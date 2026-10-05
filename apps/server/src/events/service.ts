import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  EVENT_LIMITS,
  EVENT_REMINDER_LEAD_MS,
  GatewayEvent,
  Permission,
  hasPermission,
  type CreateEventInput,
  type EventInterestedResponse,
  type EventListResponse,
  type EventReminderPayload,
  type EventUpdatePayload,
  type ServerEvent,
  type UpdateEventInput,
} from '@harmony/shared';
import { canAccessChannel, channelAccessFor, type ChannelAccess } from '../access/service.ts';
import type { AuditService } from '../audit/service.ts';
import type { AuthContext } from '../auth/service.ts';
import { findChannel } from '../db/channels.ts';
import {
  addRsvp,
  countOpenEvents,
  countRsvps,
  countRsvpsFor,
  findEvent,
  insertEvent,
  listActiveEvents,
  listEventsToRemind,
  listEventsToStart,
  listInterestedUserIds,
  listOpenEvents,
  listPastEvents,
  listRsvpsAmong,
  markEventReminded,
  removeRsvp,
  setEventAnnouncement,
  setEventStatus,
  updateEvent,
  type EventPatch,
  type EventRow,
} from '../db/events.ts';
import { findUserById, presentUser } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { MessageService } from '../messages/service.ts';
import type { GatewayHub } from '../realtime/hub.ts';

/** How often the sweep looks for events to start, end or remind about. */
const DEFAULT_SWEEP_MS = 15_000;

export interface EventServiceOptions {
  /** How often the sweep runs. A test hook; env `HARMONY_EVENT_SWEEP_MS`. */
  sweepMs?: number | undefined;
  /** How long before the start an interested member is reminded. Env `HARMONY_EVENT_REMINDER_LEAD_MS`. */
  reminderLeadMs?: number | undefined;
  /** How long an event without an end stays active. Env `HARMONY_EVENT_DEFAULT_DURATION_MS`. */
  defaultDurationMs?: number | undefined;
}

/**
 * Server events with an "Interested" RSVP.
 *
 * Who sees what: an event in a channel is visible only to members who can open
 * that channel, and an external one to every member. "Visible" governs every
 * surface (the list, one event, the RSVP, the counts, the names, the gateway),
 * and an event a member cannot see is reported as missing rather than forbidden.
 *
 * Creating needs `ManageEvents`; editing or canceling needs it too, unless the
 * member created the event themselves.
 *
 * A sweep moves events through their life: `scheduled` becomes `active` at the
 * start time and `active` becomes `ended` at the end time (or after the default
 * duration when none was given). It also sends the pre-start reminder, once per
 * event, to members who are interested and online: the reminder is a gateway
 * event to those members' own sessions and is not stored for anyone offline.
 */
export interface EventService {
  list(auth: AuthContext): EventListResponse;
  get(auth: AuthContext, id: string): ServerEvent;
  create(auth: AuthContext, input: CreateEventInput): ServerEvent;
  update(auth: AuthContext, id: string, input: UpdateEventInput): ServerEvent;
  cancel(auth: AuthContext, id: string): ServerEvent;
  setInterested(auth: AuthContext, id: string, interested: boolean): ServerEvent;
  interested(auth: AuthContext, id: string): EventInterestedResponse;
  /** One pass of the lifecycle: start, end and remind. Exposed for the timer and for tests. */
  sweep(now?: number): void;
  start(): void;
  stop(): void;
}

export function createEventService(
  sqlite: DatabaseSync,
  hub: GatewayHub,
  messages: MessageService,
  audit: AuditService,
  options: EventServiceOptions = {},
): EventService {
  const reminderLeadMs = options.reminderLeadMs ?? EVENT_REMINDER_LEAD_MS;
  const defaultDurationMs = options.defaultDurationMs ?? EVENT_LIMITS.defaultDurationMs;
  let timer: ReturnType<typeof setInterval> | null = null;

  function canSee(access: ChannelAccess, row: EventRow): boolean {
    if (row.location_kind === 'external' || row.channel_id === null) return true;
    return canAccessChannel(sqlite, access, row.channel_id);
  }

  function toDto(row: EventRow, interestedCount: number, interested: boolean): ServerEvent {
    const creatorRow = row.creator_id ? findUserById(sqlite, row.creator_id) : null;
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      locationKind: row.location_kind,
      channelId: row.channel_id,
      locationText: row.location_text,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      creator: creatorRow ? presentUser(sqlite, creatorRow) : null,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      announcedMessageId: row.announced_message_id,
      interestedCount,
      interested,
    };
  }

  /** One event as `viewerId` sees it (their own interest included). */
  function present(row: EventRow, viewerId: string): ServerEvent {
    return toDto(row, countRsvps(sqlite, row.id), listRsvpsAmong(sqlite, viewerId, [row.id]).has(row.id));
  }

  /** The perspective-free shape that goes out in a broadcast. */
  function presentForBroadcast(row: EventRow): ServerEvent {
    return toDto(row, countRsvps(sqlite, row.id), false);
  }

  function broadcast(
    row: EventRow,
    reason: EventUpdatePayload['reason'],
    rsvp: { userId: string; interested: boolean } | null = null,
  ): void {
    const payload: EventUpdatePayload = {
      event: presentForBroadcast(row),
      reason,
      rsvpUserId: rsvp?.userId ?? null,
      rsvpInterested: rsvp?.interested ?? null,
    };
    if (row.location_kind === 'channel' && row.channel_id) {
      hub.dispatch(GatewayEvent.EventUpdate, payload, { channelId: row.channel_id });
    } else {
      hub.dispatch(GatewayEvent.EventUpdate, payload);
    }
  }

  function requireVisible(auth: AuthContext, id: string): EventRow {
    const row = findEvent(sqlite, id);
    if (!row || !canSee(channelAccessFor(sqlite, auth.user.id), row)) {
      throw new HttpError(404, 'event_not_found', 'That event does not exist.');
    }
    return row;
  }

  function canManage(auth: AuthContext, row: EventRow): boolean {
    return row.creator_id === auth.user.id || hasPermission(auth.permissions, Permission.ManageEvents);
  }

  function requireManage(auth: AuthContext, row: EventRow): void {
    if (!canManage(auth, row)) {
      throw new HttpError(403, 'forbidden', 'You need Manage Events to change this event.');
    }
  }

  /** A channel the caller may place an event in or announce to. */
  function requireChannel(auth: AuthContext, channelId: string): void {
    if (!findChannel(sqlite, channelId)) {
      throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');
    }
    if (!canAccessChannel(sqlite, channelAccessFor(sqlite, auth.user.id), channelId)) {
      throw new HttpError(403, 'channel_forbidden', 'You do not have access to that channel.');
    }
  }

  function validateTimes(startsAt: number, endsAt: number | null, now: number): void {
    if (startsAt > now + EVENT_LIMITS.maxLeadMs) {
      throw new HttpError(400, 'invalid_event_time', 'An event cannot start more than a year ahead.');
    }
    if (endsAt !== null) {
      if (endsAt <= startsAt) {
        throw new HttpError(400, 'invalid_event_time', 'An event has to end after it starts.');
      }
      if (endsAt - startsAt > EVENT_LIMITS.maxDurationMs) {
        throw new HttpError(400, 'invalid_event_time', 'An event cannot run for more than 30 days.');
      }
    }
  }

  /** The announcement text: the title and the start in each reader's own zone. */
  function announcementText(title: string, startsAt: number): string {
    const unix = Math.floor(startsAt / 1000);
    return `**Event: ${title}**\n<t:${unix}:F> (<t:${unix}:R>)`;
  }

  /** When an event should be over, given what it says about its end. */
  function endTime(row: EventRow): number {
    return row.ends_at ?? row.starts_at + defaultDurationMs;
  }

  return {
    list(auth) {
      const access = channelAccessFor(sqlite, auth.user.id);
      const rows = [
        ...listOpenEvents(sqlite),
        ...listPastEvents(sqlite, Date.now() - EVENT_LIMITS.pastWindowMs, EVENT_LIMITS.pastMax),
      ].filter((row) => canSee(access, row));
      const ids = rows.map((row) => row.id);
      const counts = countRsvpsFor(sqlite, ids);
      const mine = listRsvpsAmong(sqlite, auth.user.id, ids);
      return { events: rows.map((row) => toDto(row, counts.get(row.id) ?? 0, mine.has(row.id))) };
    },

    get(auth, id) {
      return present(requireVisible(auth, id), auth.user.id);
    },

    create(auth, input) {
      if (!hasPermission(auth.permissions, Permission.ManageEvents)) {
        throw new HttpError(403, 'forbidden', 'You need Manage Events to create an event.');
      }
      const now = Date.now();
      if (input.startsAt <= now) {
        throw new HttpError(400, 'invalid_event_time', 'An event has to start in the future.');
      }
      validateTimes(input.startsAt, input.endsAt, now);

      const channelId = input.locationKind === 'channel' ? input.channelId : null;
      if (channelId) requireChannel(auth, channelId);
      if (input.announceChannelId) {
        requireChannel(auth, input.announceChannelId);
        if (!hasPermission(auth.permissions, Permission.SendMessages)) {
          throw new HttpError(403, 'forbidden', 'You cannot send messages, so the event cannot be announced.');
        }
      }
      if (countOpenEvents(sqlite) >= EVENT_LIMITS.upcomingMax) {
        throw new HttpError(
          409,
          'too_many_events',
          `There can be at most ${EVENT_LIMITS.upcomingMax} upcoming events; cancel or finish one first.`,
        );
      }

      const id = randomUUID();
      insertEvent(sqlite, {
        id,
        title: input.title,
        description: input.description,
        locationKind: input.locationKind,
        channelId,
        locationText: input.locationKind === 'external' ? input.locationText : '',
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        creatorId: auth.user.id,
        now: new Date(now).toISOString(),
      });
      audit.eventChange('event_create', auth.user.id, channelId, input.title);

      if (input.announceChannelId) {
        // The event stands even if the announcement cannot be posted (slowmode, say).
        try {
          const message = messages.create(
            auth,
            input.announceChannelId,
            announcementText(input.title, input.startsAt),
            [],
            null,
          );
          setEventAnnouncement(sqlite, id, message.id);
        } catch {
          // Left unannounced.
        }
      }

      const row = findEvent(sqlite, id)!;
      broadcast(row, 'created');
      return present(row, auth.user.id);
    },

    update(auth, id, input) {
      const row = requireVisible(auth, id);
      requireManage(auth, row);
      if (row.status === 'ended' || row.status === 'canceled') {
        throw new HttpError(409, 'event_closed', 'That event is over, so it can no longer be changed.');
      }

      const now = Date.now();
      const patch: EventPatch = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = input.description;

      // Work out the location as it will stand, then check it as a whole.
      const kind = input.locationKind ?? row.location_kind;
      let channelId = row.channel_id;
      let locationText = row.location_text;
      if (kind === 'channel') {
        if (input.channelId !== undefined) channelId = input.channelId;
        if (!channelId) throw new HttpError(400, 'validation_error', 'Pick a channel.');
        if (channelId !== row.channel_id) requireChannel(auth, channelId);
        locationText = '';
      } else {
        channelId = null;
        if (input.locationText !== undefined) locationText = input.locationText;
        if (locationText.length === 0) throw new HttpError(400, 'validation_error', 'Say where it takes place.');
      }
      if (
        kind !== row.location_kind ||
        channelId !== row.channel_id ||
        locationText !== row.location_text
      ) {
        patch.locationKind = kind;
        patch.channelId = channelId;
        patch.locationText = locationText;
      }

      // Once started, the start time is history; the end may still move.
      const startsAt = input.startsAt ?? row.starts_at;
      const endsAt = input.endsAt !== undefined ? input.endsAt : row.ends_at;
      if (input.startsAt !== undefined && input.startsAt !== row.starts_at) {
        if (row.status === 'active') {
          throw new HttpError(409, 'event_started', 'An event that has started cannot be moved.');
        }
        if (input.startsAt <= now) {
          throw new HttpError(400, 'invalid_event_time', 'An event has to start in the future.');
        }
        patch.startsAt = input.startsAt;
        // A new start gets its reminder afresh.
        patch.remindedAt = null;
      }
      if (input.endsAt !== undefined && input.endsAt !== row.ends_at) {
        if (input.endsAt !== null && input.endsAt <= now && row.status === 'active') {
          throw new HttpError(400, 'invalid_event_time', 'An event cannot end in the past.');
        }
        patch.endsAt = input.endsAt;
      }
      validateTimes(startsAt, endsAt, now);

      updateEvent(sqlite, id, patch, new Date(now).toISOString());
      const updated = findEvent(sqlite, id)!;
      audit.eventChange('event_edit', auth.user.id, updated.channel_id, updated.title);
      broadcast(updated, 'updated');
      return present(updated, auth.user.id);
    },

    cancel(auth, id) {
      const row = requireVisible(auth, id);
      requireManage(auth, row);
      if (row.status === 'canceled') return present(row, auth.user.id);
      if (row.status === 'ended') {
        throw new HttpError(409, 'event_closed', 'That event is already over.');
      }
      setEventStatus(sqlite, id, ['scheduled', 'active'], 'canceled', new Date().toISOString());
      const updated = findEvent(sqlite, id)!;
      audit.eventChange('event_cancel', auth.user.id, updated.channel_id, updated.title);
      broadcast(updated, 'canceled');
      return present(updated, auth.user.id);
    },

    setInterested(auth, id, interested) {
      const row = requireVisible(auth, id);
      if (interested) {
        if (row.status === 'ended' || row.status === 'canceled') {
          throw new HttpError(409, 'event_closed', 'That event is over.');
        }
        if (addRsvp(sqlite, id, auth.user.id, new Date().toISOString())) {
          broadcast(row, 'rsvp', { userId: auth.user.id, interested: true });
        }
      } else if (removeRsvp(sqlite, id, auth.user.id)) {
        broadcast(row, 'rsvp', { userId: auth.user.id, interested: false });
      }
      return present(row, auth.user.id);
    },

    interested(auth, id) {
      const row = requireVisible(auth, id);
      const total = countRsvps(sqlite, row.id);
      const users = listInterestedUserIds(sqlite, row.id, EVENT_LIMITS.interestedPage).flatMap((userId) => {
        const userRow = findUserById(sqlite, userId);
        // Someone who can no longer see the event is not named in it.
        if (!userRow || !canSee(channelAccessFor(sqlite, userId), row)) return [];
        return [presentUser(sqlite, userRow)];
      });
      return { total, users };
    },

    sweep(now = Date.now()) {
      // Start what is due. One whose end has already passed (a long outage) goes
      // straight through to ended, passing through active so clients see both.
      for (const row of listEventsToStart(sqlite, now)) {
        if (!setEventStatus(sqlite, row.id, ['scheduled'], 'active', new Date(now).toISOString())) continue;
        const started = findEvent(sqlite, row.id)!;
        // Whatever reminder was due is moot once it has begun.
        markEventReminded(sqlite, row.id, now);
        broadcast(started, 'started');
      }

      for (const row of listActiveEvents(sqlite)) {
        if (endTime(row) > now) continue;
        if (!setEventStatus(sqlite, row.id, ['active'], 'ended', new Date(now).toISOString())) continue;
        broadcast(findEvent(sqlite, row.id)!, 'ended');
      }

      for (const row of listEventsToRemind(sqlite, now, reminderLeadMs)) {
        // Stamp first: if the dispatch throws, the reminder is skipped, never doubled.
        if (!markEventReminded(sqlite, row.id, now)) continue;
        const interestedIds = listInterestedUserIds(sqlite, row.id);
        const recipients = new Set<string>();
        for (const userId of interestedIds) {
          if (canSee(channelAccessFor(sqlite, userId), row)) recipients.add(userId);
        }
        if (recipients.size === 0) continue;
        const payload: EventReminderPayload = {
          event: toDto(findEvent(sqlite, row.id)!, interestedIds.length, true),
        };
        hub.dispatchToUsers(GatewayEvent.EventReminder, payload, recipients);
      }
    },

    start() {
      if (timer) return;
      this.sweep();
      timer = setInterval(() => {
        try {
          this.sweep();
        } catch (error) {
          void error;
        }
      }, options.sweepMs ?? DEFAULT_SWEEP_MS);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
