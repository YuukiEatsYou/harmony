/**
 * How the time beside a message reads, and where the date lines between
 * messages fall. A clock time alone cannot tell this morning from last month,
 * so a message from another day says which, the way Discord's do: "Yesterday at
 * 14:32", or the date in front of the time.
 *
 * Pure, so the text smoke test can import it. The locale and zone are only ever
 * passed by the tests; the client leaves them unset so every reader sees their
 * own. Days are calendar days in that zone, not 24-hour spans, so a change to or
 * from daylight saving time does not shift "yesterday".
 */
import { formatTimestampTitle } from './timestamp.ts';

export interface MessageTimeOptions {
  /** What "now" is, for today and yesterday. */
  now?: number;
  locale?: string;
  timeZone?: string;
}

/** The calendar day an instant falls on, as `YYYY-MM-DD` in the given zone. */
export function dayKey(epochMs: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(epochMs);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The key of the calendar day before the one `key` names. */
function previousDayKey(key: string): string {
  const [year = 0, month = 1, day = 1] = key.split('-').map(Number);
  // Date.UTC rolls day 0 back into the month before, and across a year too.
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/** The clock time alone, as the grouped rows show it in their gutter. */
export function clockTime(epochMs: number, options: MessageTimeOptions = {}): string {
  return new Intl.DateTimeFormat(options.locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: options.timeZone,
  }).format(epochMs);
}

/** The time beside a message's name: the clock for today, otherwise the day as well. */
export function messageTimeLabel(epochMs: number, options: MessageTimeOptions = {}): string {
  const time = clockTime(epochMs, options);
  const key = dayKey(epochMs, options.timeZone);
  const today = dayKey(options.now ?? Date.now(), options.timeZone);
  if (key === today) return time;
  if (key === previousDayKey(today)) return `Yesterday at ${time}`;
  const date = new Intl.DateTimeFormat(options.locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: options.timeZone,
  }).format(epochMs);
  return `${date} ${time}`;
}

/** The full date and time, for the tooltip on any message time. */
export function messageTimeTitle(epochMs: number, options: MessageTimeOptions = {}): string {
  return formatTimestampTitle(epochMs, options);
}

/** The words on the line that starts a new day in the message list. */
export function dayDividerLabel(epochMs: number, options: MessageTimeOptions = {}): string {
  return new Intl.DateTimeFormat(options.locale, { dateStyle: 'long', timeZone: options.timeZone }).format(epochMs);
}

/**
 * Marks the rows that open a new day, which is where a date line goes, and
 * stops such a row continuing the group above it, as a header has to follow a
 * date line. The first row only opens a day when the list reaches back to the
 * start of the channel (`fromStart`); otherwise the loaded page just happens to
 * begin there, and the line arrives with the older page that shows the change.
 */
export function withDayStarts<R extends { message: { createdAt: string }; grouped: boolean }>(
  rows: readonly R[],
  fromStart: boolean,
  timeZone?: string,
): Array<R & { dayStart: boolean }> {
  let previous: string | null = null;
  return rows.map((row, index) => {
    const key = dayKey(Date.parse(row.message.createdAt), timeZone);
    const dayStart = index === 0 ? fromStart : key !== previous;
    previous = key;
    return dayStart ? { ...row, grouped: false, dayStart } : { ...row, dayStart };
  });
}
