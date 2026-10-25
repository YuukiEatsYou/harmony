/**
 * The decisions behind the "What's new" dialog: which notes to show a member
 * when they open Harmony, and what to tell the server about it.
 *
 * The server keeps the newest release each member has been shown, which is what
 * makes "only once" hold across their devices. This browser keeps a copy too,
 * written the moment the notes appear, and the newer of the two counts as seen:
 * if the write to the server fails, a reload here still does not show the same
 * notes a second time, and the next visit sends the server what it missed.
 *
 * Pure, so the text smoke test can import it; the store that does the fetching
 * and the storage is changelog.svelte.ts.
 */
import {
  CHANGELOG_VERSION_PATTERN,
  HARMONY_VERSION,
  changelogToShow,
  isNewerVersion,
  type ChangelogEntry,
} from '@harmony/shared';

/** Where this browser remembers the newest notes it showed a member, one key per account. */
export function changelogSeenKey(userId: string): string {
  return `harmony:changelog-seen:${userId}`;
}

/** A remembered version, or null when there is none or it is not a release number. Storage can hold anything. */
export function readSeenMarker(raw: string | null): string | null {
  return raw !== null && CHANGELOG_VERSION_PATTERN.test(raw) ? raw : null;
}

/** The newer of two seen versions, either of which may be missing. */
export function newerSeen(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return isNewerVersion(b, a) ? b : a;
}

/** What to do when a member opens Harmony. */
export interface ChangelogPlan {
  /** The notes to show now, or null when there is nothing they have not seen. */
  show: ChangelogEntry | null;
  /**
   * A version the server should record without anything being shown: one this
   * browser showed while the server never heard about it. Null when the server
   * is already up to date, and always null while there is something to show,
   * since showing it records it.
   */
  report: string | null;
}

/**
 * Decides from the server's seen version and this browser's copy, the raw
 * stored string, which may be missing or garbage.
 */
export function planChangelog(serverSeen: string | null, storedSeen: string | null): ChangelogPlan {
  const local = readSeenMarker(storedSeen);
  const show = changelogToShow(newerSeen(serverSeen, local));
  if (show) return { show, report: null };
  // A copy newer than the server's is a write that failed. One newer than this
  // build was made by a newer one before a rollback, and the server would
  // refuse it, so it is not worth sending.
  const missed =
    local !== null &&
    (serverSeen === null || isNewerVersion(local, serverSeen)) &&
    !isNewerVersion(local, HARMONY_VERSION);
  return { show: null, report: missed ? local : null };
}

/**
 * A changelog date, written YYYY-MM-DD, the way the reader writes dates, such
 * as 22 October 2026. It is a calendar day rather than an instant, so it is read
 * and formatted in UTC and never slips to the day before west of Greenwich. The
 * locale is only passed by the tests.
 */
export function formatChangelogDate(date: string, locale?: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return date;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(day);
}
