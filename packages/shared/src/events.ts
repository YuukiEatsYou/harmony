import { z } from 'zod';
import type { IsoTimestamp, SnowflakeId, User } from './types.ts';

/**
 * Server events with an "Interested" RSVP: Discord's scheduled events, simplified.
 * An event takes place in a channel or at a free-text place, starts at a time and
 * optionally ends at one. There is no recurrence and nothing is bridged to
 * Discord's own scheduled events.
 */
export const EVENT_LIMITS = {
  title: 100,
  description: 1000,
  locationText: 100,
  /** How many scheduled or active events may exist at once. */
  upcomingMax: 50,
  /** The furthest ahead an event may start. */
  maxLeadMs: 365 * 86_400_000,
  /** The longest an event may run. */
  maxDurationMs: 30 * 86_400_000,
  /** How long an event with no end time stays "now" before it is marked ended. */
  defaultDurationMs: 4 * 3_600_000,
  /** How long a finished or canceled event stays in the list. */
  pastWindowMs: 7 * 86_400_000,
  /** How many finished events the list returns at most. */
  pastMax: 20,
  /** How many names the interested list returns. */
  interestedPage: 100,
} as const;

/** How far before the start an interested member is reminded. */
export const EVENT_REMINDER_LEAD_MS = 15 * 60_000;

export type EventLocationKind = 'channel' | 'external';
export type EventStatus = 'scheduled' | 'active' | 'ended' | 'canceled';

export interface ServerEvent {
  id: SnowflakeId;
  title: string;
  description: string;
  locationKind: EventLocationKind;
  /** The channel it takes place in, for a channel event. */
  channelId: SnowflakeId | null;
  /** The place, for an external event. */
  locationText: string;
  /** Epoch milliseconds. */
  startsAt: number;
  /** Epoch milliseconds, or null when no end was given. */
  endsAt: number | null;
  creator: User | null;
  status: EventStatus;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  /** The message that announced it, if one was posted. */
  announcedMessageId: SnowflakeId | null;
  /** How many members are interested. */
  interestedCount: number;
  /**
   * Whether the viewer is interested. One member's perspective, so a broadcast
   * carries false and clients keep what they hold (see {@link EventUpdatePayload}).
   */
  interested: boolean;
}

export interface EventListResponse {
  events: ServerEvent[];
}

export interface EventInterestedResponse {
  total: number;
  users: User[];
}

/**
 * An event changed. A channel event goes to the members who can see its channel,
 * an external one to everybody. When `reason` is `rsvp`, `rsvpUserId` says whose
 * interest changed and `rsvpInterested` what it became, so each client can update
 * its own `interested` without the server baking one viewer into a broadcast.
 */
export interface EventUpdatePayload {
  event: ServerEvent;
  reason: 'created' | 'updated' | 'started' | 'ended' | 'canceled' | 'rsvp';
  rsvpUserId: SnowflakeId | null;
  rsvpInterested: boolean | null;
}

/** Sent only to an interested member's own sessions shortly before an event starts. */
export interface EventReminderPayload {
  event: ServerEvent;
}

const epochMs = z.number().int().positive();

const eventFields = {
  title: z.string().trim().min(1, 'An event needs a title.').max(EVENT_LIMITS.title),
  description: z.string().trim().max(EVENT_LIMITS.description),
  locationKind: z.enum(['channel', 'external']),
  channelId: z.string().min(1).nullable(),
  locationText: z.string().trim().max(EVENT_LIMITS.locationText),
  startsAt: epochMs,
  endsAt: epochMs.nullable(),
};

export const createEventSchema = z
  .object({
    ...eventFields,
    description: eventFields.description.default(''),
    locationText: eventFields.locationText.default(''),
    channelId: eventFields.channelId.default(null),
    endsAt: eventFields.endsAt.default(null),
    /** Post an announcement message in this channel as the creator. */
    announceChannelId: z.string().min(1).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.locationKind === 'channel' && !value.channelId) {
      ctx.addIssue({ code: 'custom', path: ['channelId'], message: 'Pick a channel.' });
    }
    if (value.locationKind === 'external' && value.locationText.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['locationText'], message: 'Say where it takes place.' });
    }
  });
export type CreateEventInput = z.infer<typeof createEventSchema>;

export const updateEventSchema = z
  .object({
    title: eventFields.title.optional(),
    description: eventFields.description.optional(),
    locationKind: eventFields.locationKind.optional(),
    channelId: eventFields.channelId.optional(),
    locationText: eventFields.locationText.optional(),
    startsAt: eventFields.startsAt.optional(),
    endsAt: eventFields.endsAt.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to change.',
  });
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

// ---- Pure helpers shared by the client and its smoke test ----

export type EventGroup = 'now' | 'upcoming' | 'past';

/** Which list section an event belongs in. */
export function eventGroup(event: Pick<ServerEvent, 'status'>): EventGroup {
  if (event.status === 'active') return 'now';
  if (event.status === 'scheduled') return 'upcoming';
  return 'past';
}

/** Groups events and orders each group: now and upcoming soonest first, past latest first. */
export function groupEvents<T extends Pick<ServerEvent, 'status' | 'startsAt' | 'endsAt'>>(
  events: readonly T[],
): Record<EventGroup, T[]> {
  const groups: Record<EventGroup, T[]> = { now: [], upcoming: [], past: [] };
  for (const event of events) groups[eventGroup(event)].push(event);
  groups.now.sort((a, b) => a.startsAt - b.startsAt);
  groups.upcoming.sort((a, b) => a.startsAt - b.startsAt);
  groups.past.sort((a, b) => (b.endsAt ?? b.startsAt) - (a.endsAt ?? a.startsAt));
  return groups;
}

/** A short badge for the interested count: "No one yet", "1 interested". */
export function interestedLabel(count: number): string {
  if (count <= 0) return 'No one yet';
  return `${count} interested`;
}
