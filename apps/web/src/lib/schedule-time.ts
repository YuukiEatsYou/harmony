/**
 * The pure half of scheduled messages: reading and checking the time somebody
 * picked, describing it back to them in their own zone, and keeping the list of
 * scheduled messages in order. No state and no DOM, so the text smoke test can
 * pin "now" and the zone. The store that talks to the server is
 * `scheduled.svelte.ts`.
 */
import { SCHEDULED_MAX_LEAD_MS, SCHEDULED_MIN_LEAD_MS, type ScheduledMessage } from '@harmony/shared';
import { parseTimeExpression, type TimeInputOptions } from './time-input.ts';

/**
 * The time fields hold whole minutes, so asking for less than a minute ahead
 * would be a coin toss on which minute it rounds into. The server's own minimum
 * is shorter; this keeps the wording honest and a slow request clear of it.
 */
const CLIENT_MIN_LEAD_MS = Math.max(60_000, SCHEDULED_MIN_LEAD_MS + 2_000);

/**
 * Reads what was typed into the "when" field: the same expressions the composer
 * turns into timestamps after an `@` (`5pm`, `tomorrow 9am`, `in 2h`, `fri 18:30`),
 * with or without the `@`. Null when it is not one.
 */
export function parseScheduleInput(text: string, options: TimeInputOptions): number | null {
  const stripped = text.trim().replace(/^@/, '');
  if (stripped.length === 0) return null;
  return parseTimeExpression(stripped, options)?.epochMs ?? null;
}

/** What is wrong with a chosen time, in words, or null when it can be scheduled. */
export function scheduleProblem(epochMs: number | null, now: number): string | null {
  if (epochMs === null) return 'Pick a date and a time.';
  if (epochMs < now + CLIENT_MIN_LEAD_MS) return 'Pick a time at least a minute from now.';
  if (epochMs > now + SCHEDULED_MAX_LEAD_MS) return 'Messages can be scheduled up to a year ahead.';
  return null;
}

export interface ScheduleChoice {
  label: string;
  at: number;
}

/**
 * The quick choices offered beside the date and time fields. "Tomorrow morning"
 * is 9:00 the next day in the writer's zone.
 */
export function scheduleChoices(now: number, options: Omit<TimeInputOptions, 'now'> = {}): ScheduleChoice[] {
  const fixed = (minutes: number): number => Math.floor((now + minutes * 60_000) / 1000) * 1000;
  const choices: ScheduleChoice[] = [
    { label: 'In 30 minutes', at: fixed(30) },
    { label: 'In 1 hour', at: fixed(60) },
    { label: 'In 3 hours', at: fixed(180) },
  ];
  const tomorrow = parseTimeExpression('tomorrow 9am', { ...options, now });
  if (tomorrow) choices.push({ label: 'Tomorrow morning', at: tomorrow.epochMs });
  return choices;
}

/** A sensible starting point: an hour out, rounded up to the next five minutes. */
export function defaultScheduleTime(now: number): number {
  const step = 5 * 60_000;
  return Math.ceil((now + 60 * 60_000) / step) * step;
}

/**
 * How a send time reads to its author: the day, the time and the zone it is in,
 * for example "Tomorrow at 9:00 AM (Europe/Berlin)". The zone is spelled out
 * because the whole point is what the clock on their wall will say.
 */
export function describeSendTime(epochMs: number, options: TimeInputOptions): string {
  const { locale, timeZone } = options;
  const zone = timeZone ?? new Intl.DateTimeFormat(locale).resolvedOptions().timeZone;
  const dayKey = (moment: number): string =>
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(moment);
  const days = Math.round((Date.parse(dayKey(epochMs)) - Date.parse(dayKey(options.now))) / 86_400_000);

  let day: string;
  if (days === 0) day = 'Today';
  else if (days === 1) day = 'Tomorrow';
  else if (days > 1 && days < 7) {
    day = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone }).format(epochMs);
  } else {
    day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(epochMs);
  }
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone }).format(epochMs);
  return `${day} at ${time} (${zone})`;
}

/** Soonest first, the order the server lists them in. */
export function bySendTime(a: ScheduledMessage, b: ScheduledMessage): number {
  return a.sendAt.localeCompare(b.sendAt) || a.id.localeCompare(b.id);
}

/** The list with one entry added or replaced, kept in order. */
export function upsertScheduled(list: ScheduledMessage[], entry: ScheduledMessage): ScheduledMessage[] {
  return [...list.filter((other) => other.id !== entry.id), entry].sort(bySendTime);
}

export function removeScheduled(list: ScheduledMessage[], id: string): ScheduledMessage[] {
  return list.filter((entry) => entry.id !== id);
}

/** How the count on the header button reads: pending ones, with failed ones counted too. */
export function scheduledBadge(list: ScheduledMessage[]): { count: number; failed: number } {
  return { count: list.length, failed: list.filter((entry) => entry.status === 'failed').length };
}
