/**
 * The pure half of server events on the client: the create/edit form's draft,
 * checking it, turning it into a request, and describing an event's time in the
 * reader's own zone. No state and no DOM, so the text smoke test can pin "now"
 * and the zone. The store that talks to the server is `events.svelte.ts`.
 */
import {
  EVENT_LIMITS,
  type CreateEventInput,
  type EventLocationKind,
  type ServerEvent,
  type UpdateEventInput,
} from '@harmony/shared';
import { describeSendTime } from './schedule-time.ts';
import type { TimeInputOptions } from './time-input.ts';

/** The form's working copy of an event. */
export interface EventDraft {
  title: string;
  description: string;
  locationKind: EventLocationKind;
  channelId: string | null;
  locationText: string;
  startsAt: number | null;
  endsAt: number | null;
  /** Create only: a channel to post an announcement in, or null for none. */
  announceChannelId: string | null;
}

/** An hour out, rounded up to the next five minutes, as the scheduler does. */
export function defaultEventStart(now: number): number {
  const step = 5 * 60_000;
  return Math.ceil((now + 60 * 60_000) / step) * step;
}

export function newEventDraft(now: number, channelId: string | null = null): EventDraft {
  return {
    title: '',
    description: '',
    locationKind: channelId ? 'channel' : 'external',
    channelId,
    locationText: '',
    startsAt: defaultEventStart(now),
    endsAt: null,
    announceChannelId: null,
  };
}

export function draftFromEvent(event: ServerEvent): EventDraft {
  return {
    title: event.title,
    description: event.description,
    locationKind: event.locationKind,
    channelId: event.channelId,
    locationText: event.locationText,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    announceChannelId: null,
  };
}

/**
 * What is wrong with the draft, in words, or null when it can be sent.
 * `started` is an edit of an event already under way, whose start is history.
 */
export function eventDraftProblem(draft: EventDraft, now: number, started = false): string | null {
  if (draft.title.trim().length === 0) return 'Give the event a title.';
  if (draft.title.trim().length > EVENT_LIMITS.title) return `Titles can be up to ${EVENT_LIMITS.title} characters.`;
  if (draft.description.trim().length > EVENT_LIMITS.description) {
    return `Descriptions can be up to ${EVENT_LIMITS.description} characters.`;
  }
  if (draft.locationKind === 'channel' && !draft.channelId) return 'Pick a channel.';
  if (draft.locationKind === 'external') {
    if (draft.locationText.trim().length === 0) return 'Say where it takes place.';
    if (draft.locationText.trim().length > EVENT_LIMITS.locationText) {
      return `The place can be up to ${EVENT_LIMITS.locationText} characters.`;
    }
  }
  if (draft.startsAt === null) return 'Pick a start date and time.';
  if (!started && draft.startsAt <= now) return 'The start has to be in the future.';
  if (draft.startsAt > now + EVENT_LIMITS.maxLeadMs) return 'Events can start up to a year ahead.';
  if (draft.endsAt !== null) {
    if (draft.endsAt <= draft.startsAt) return 'The end has to come after the start.';
    if (draft.endsAt - draft.startsAt > EVENT_LIMITS.maxDurationMs) return 'Events can run for up to 30 days.';
    if (started && draft.endsAt <= now) return 'The end has to be in the future.';
  }
  return null;
}

/** The create request: only what the chosen location kind uses is sent. */
export function toCreateEventBody(draft: EventDraft): CreateEventInput {
  return {
    title: draft.title.trim(),
    description: draft.description.trim(),
    locationKind: draft.locationKind,
    channelId: draft.locationKind === 'channel' ? draft.channelId : null,
    locationText: draft.locationKind === 'external' ? draft.locationText.trim() : '',
    startsAt: draft.startsAt ?? 0,
    endsAt: draft.endsAt,
    announceChannelId: draft.announceChannelId,
  };
}

/** The edit request: only the fields that differ from the event as it stands. */
export function toUpdateEventBody(draft: EventDraft, event: ServerEvent): UpdateEventInput {
  const body: UpdateEventInput = {};
  if (draft.title.trim() !== event.title) body.title = draft.title.trim();
  if (draft.description.trim() !== event.description) body.description = draft.description.trim();
  const place = draft.locationKind === 'channel' ? draft.channelId : draft.locationText.trim();
  const was = event.locationKind === 'channel' ? event.channelId : event.locationText;
  if (draft.locationKind !== event.locationKind || place !== was) {
    body.locationKind = draft.locationKind;
    if (draft.locationKind === 'channel') body.channelId = draft.channelId;
    else body.locationText = draft.locationText.trim();
  }
  if (draft.startsAt !== null && draft.startsAt !== event.startsAt) body.startsAt = draft.startsAt;
  if (draft.endsAt !== event.endsAt) body.endsAt = draft.endsAt;
  return body;
}

// ---- Reading an event ----

/** The event with one replaced or added (by id), the others untouched. */
export function upsertEvent(list: ServerEvent[], event: ServerEvent): ServerEvent[] {
  const index = list.findIndex((other) => other.id === event.id);
  if (index === -1) return [...list, event];
  return list.map((other) => (other.id === event.id ? event : other));
}

export function removeEvent(list: ServerEvent[], id: string): ServerEvent[] {
  return list.filter((event) => event.id !== id);
}

/**
 * Applies a broadcast to what the viewer already holds. A broadcast carries no
 * viewer perspective, so the viewer's own `interested` is kept, except when the
 * update says it was their own interest that changed.
 */
export function applyEventUpdate(
  list: ServerEvent[],
  update: { event: ServerEvent; rsvpUserId: string | null; rsvpInterested: boolean | null },
  viewerId: string | null,
): ServerEvent[] {
  const existing = list.find((event) => event.id === update.event.id);
  let interested = existing?.interested ?? false;
  if (update.rsvpUserId !== null && update.rsvpUserId === viewerId && update.rsvpInterested !== null) {
    interested = update.rsvpInterested;
  }
  return upsertEvent(list, { ...update.event, interested });
}

/** How the time reads to the member: "Tomorrow at 9:00 AM (Europe/Berlin)", with the end when there is one. */
export function describeEventTime(event: Pick<ServerEvent, 'startsAt' | 'endsAt'>, options: TimeInputOptions): string {
  const start = describeSendTime(event.startsAt, options);
  if (event.endsAt === null) return start;
  const sameDay = describeSendTime(event.endsAt, options).split(' at ')[0] === start.split(' at ')[0];
  const endTime = new Intl.DateTimeFormat(options.locale, { timeStyle: 'short', timeZone: options.timeZone }).format(
    event.endsAt,
  );
  return sameDay ? `${start} to ${endTime}` : `${start} to ${describeSendTime(event.endsAt, options)}`;
}

/** The pill beside an event: its status in a word. */
export function eventStatusLabel(status: ServerEvent['status']): string {
  switch (status) {
    case 'active':
      return 'Happening now';
    case 'scheduled':
      return 'Upcoming';
    case 'ended':
      return 'Ended';
    case 'canceled':
      return 'Canceled';
  }
}

/** Minutes until the start, rounded, never below one. */
export function minutesUntil(startsAt: number, now: number): number {
  return Math.max(1, Math.round((startsAt - now) / 60_000));
}

/** The line a reminder shows: "Game night starts in 15 minutes." */
export function reminderText(event: Pick<ServerEvent, 'title' | 'startsAt'>, now: number): string {
  if (event.startsAt <= now) return `${event.title} is starting now.`;
  const minutes = minutesUntil(event.startsAt, now);
  return `${event.title} starts in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}
