import { z } from 'zod';
import { isNewerVersion } from './update.ts';

/**
 * The release notes a member is shown after an update, in a "What's new" dialog.
 *
 * Only the newest entry is ever shown, and only once per member, so it has to
 * cover everything user-facing since the entry before it. A branch that ships a
 * user-facing change adds one entry at the top for the version it ships as, or
 * extends its own top entry if it already has one. The words are for members,
 * not developers: short plain sentences about what they can now do or what was
 * fixed, with no internals.
 *
 * Which version a member last saw is kept by the server, per account, so "once"
 * holds across their devices and browsers. A new account starts at the newest
 * entry, since nothing in it is news to someone who has only just arrived.
 */

/** One release's notes. */
export interface ChangelogEntry {
  /** The release these notes ship with, as three dotted numbers such as 2.9.0. */
  version: string;
  /** The day it was released, as YYYY-MM-DD. */
  date: string;
  /** The dialog's heading. */
  title: string;
  /** What changed, one short sentence each, in the order a member should read them. */
  items: string[];
}

/**
 * A release number as the changelog and a member's seen marker hold it: three
 * dotted numbers without leading zeros, each short enough to compare exactly.
 */
export const CHANGELOG_VERSION_PATTERN = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** Every release's notes, newest first. */
export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    version: '2.15.0',
    date: '2026-10-22',
    title: "What's new",
    items: [
      "Go back and forward between the channels you have opened, with your mouse's side buttons, Alt with the left and right arrows (Cmd with [ and ] on a Mac), your browser's buttons, or the back gesture on Android. Back closes an open panel or drawer first.",
      'Reloading the page keeps you in the channel you were in.',
      'Message times say which day a message was sent, and a line with the date separates one day from the next.',
      'A link to a message, a notification or a reply now takes you to that message however far back it is, and you can scroll on from there to the newest ones.',
      "Click the quote above a reply to jump to the message it answers. The quote also follows that message's edits and deletion.",
      'Mark a channel unread from any message: hold Alt and click it, or use Mark unread in its menu. Copy link copies a link straight to a message.',
      'New keyboard shortcuts: Ctrl+F to search, Ctrl+I for mentions, Ctrl+P for pins, Ctrl+U to show or hide the member list, Escape to close a panel or mark a channel read (Shift+Escape for all of them), and Ctrl+Shift+M or D to mute or deafen in voice. Press Ctrl+/ to see them all (Cmd on a Mac).',
      'In the message box, Ctrl+B, I and U make text bold, italic or underlined, Ctrl+E and Ctrl+G open the emoji and GIF pickers, and the Up arrow edits your last message. When editing, Enter saves and Escape cancels.',
      'Start typing anywhere to write a message, and hold Shift while clicking Delete to skip the question.',
      'On a wide screen you can hide the member list with its button in the channel header.',
      'Harmony opens faster: panels most visits never use are fetched the first time you open them.',
      'Fixed: the edit history now opens over the whole window, and picking the channel you are already in no longer reloads it and loses your reply.',
      "This note, shown once after each update. You can read it again from About: click the server's name.",
    ],
  },
];

/** The newest entry, or null when there are none. */
export function latestChangelog(): ChangelogEntry | null {
  return CHANGELOG[0] ?? null;
}

/**
 * The entry to show a member whose newest seen version is `lastSeen`: the newest
 * entry when they have seen none, or one older than it, and otherwise nothing.
 */
export function changelogToShow(lastSeen: string | null): ChangelogEntry | null {
  const latest = latestChangelog();
  if (!latest) return null;
  return lastSeen === null || isNewerVersion(latest.version, lastSeen) ? latest : null;
}

/** Response for `GET /api/v1/users/@me/changelog`. */
export interface ChangelogSeenResponse {
  /** The newest release whose notes the caller has been shown, or null for none. */
  seen: string | null;
}

/** Recording that a release's notes were shown, for `PUT /api/v1/users/@me/changelog`. */
export const changelogSeenSchema = z.object({
  version: z.string().regex(CHANGELOG_VERSION_PATTERN, 'A release number such as 2.9.0'),
});
export type ChangelogSeenInput = z.infer<typeof changelogSeenSchema>;
