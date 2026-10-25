/**
 * The pure half of going back and forward between channels: what a browser
 * history entry of ours holds, and what to do when the open channel changes,
 * something opens over the chat, or the browser steps to another entry. It
 * holds no state and touches no DOM, so the text smoke test can import it
 * straight into Node.
 *
 * Every channel opened gets a real history entry, rather than a list kept on
 * the side, because that is what the browser's own back and forward already
 * walk: its buttons, Alt+arrow and Cmd+bracket, a trackpad swipe, Android's back
 * gesture and the mouse's side buttons in a browser that handles them itself.
 * The URL does not name the channel. The entry's state is enough, and the
 * browser keeps it across a reload, which is how a reload stays in the channel
 * it was on.
 *
 * Something opened over the chat (a drawer, a panel, the lightbox, the quick
 * switcher) gets an entry as well, a marker, so that back closes it before it
 * changes channel. That is what back means on a phone, where the drawer and the
 * panels cover the whole screen and a press that changed the channel behind one
 * would look like it did nothing.
 */

/** What one of our history entries carries, under its own key in `history.state`. */
export interface ChannelHistoryEntry {
  /** The channel the entry opens. A marker names the channel that was open under it. */
  channelId: string;
  /**
   * The entry's position among ours. A step lands on an entry without saying
   * which way it went, so comparing positions is how back is told from forward.
   */
  index: number;
  /**
   * 0 for a channel's own entry. A marker holds how many layers were open over
   * the chat when it was pushed (a panel makes one, and a picture opened from it
   * a second), so a step back onto the entry beneath knows how many to close.
   */
  depth: number;
  /**
   * The account that wrote the entry. Signing out leaves the tab's history as
   * it is, so the next account to sign in there walks the same entries; see
   * ownedBy. Absent on an entry not yet written, which the writer stamps.
   */
  userId?: string;
}

/** The key our entry sits under, so state anyone else puts there is left alone. */
const stateKey = 'harmonyChannel';

/**
 * Reads our entry out of a `history.state`, or null when the state is not one of
 * ours. An entry written before markers existed has no depth, and reads as a
 * channel's own entry, which is what it was.
 */
export function readEntry(state: unknown): ChannelHistoryEntry | null {
  if (typeof state !== 'object' || state === null) return null;
  const entry: unknown = (state as Record<string, unknown>)[stateKey];
  if (typeof entry !== 'object' || entry === null) return null;
  const { channelId, index, depth = 0, userId } = entry as Record<string, unknown>;
  if (typeof channelId !== 'string' || channelId.length === 0) return null;
  if (typeof index !== 'number' || !Number.isSafeInteger(index)) return null;
  if (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 0) return null;
  return typeof userId === 'string' ? { channelId, index, depth, userId } : { channelId, index, depth };
}

/**
 * Whether an entry is the signed-in account's own. One written by someone who
 * has since signed out of this tab is treated like an entry for a channel that
 * is gone: it is never opened, so the next account neither lands in the last
 * channel the previous one had open nor walks back through the channels they
 * visited, and a step onto it rewrites it and carries on. An entry with no
 * account was written before entries recorded one, and counts as anyone's.
 */
export function ownedBy(entry: ChannelHistoryEntry, userId: string | null): boolean {
  return entry.userId === undefined || entry.userId === userId;
}

/**
 * A `history.state` carrying `entry`, keeping whatever else `state` held. A
 * fresh entry passes null, since it should not inherit another entry's state.
 */
export function writeEntry(state: unknown, entry: ChannelHistoryEntry): Record<string, unknown> {
  const base = typeof state === 'object' && state !== null ? { ...(state as Record<string, unknown>) } : {};
  base[stateKey] =
    entry.userId === undefined
      ? { channelId: entry.channelId, index: entry.index, depth: entry.depth }
      : { channelId: entry.channelId, index: entry.index, depth: entry.depth, userId: entry.userId };
  return base;
}

/**
 * How a change of the open channel is written into history, given the entry
 * the page is on (`current`), whether that entry's channel still exists, and
 * the position to use when the page is on no entry of ours yet.
 *
 * - `push` adds an entry after the current one, so back returns to the
 *   channel being left. After a marker, that is the channel open under it, so
 *   a channel opened from a panel (a search result, a pick in the phone's
 *   drawer) goes back to the one it was opened from.
 * - `replace` rewrites the entry the page is on. That is right for the first
 *   channel the page opens, which belongs on the entry it was loaded with, and
 *   for a channel that took over from one that has gone (deleted, or locked
 *   away), since going back to a channel that is gone would only land on the
 *   default again. A marker stays a marker; only the channel it names changes.
 * - null leaves history as it is: nothing is open, or the entry already names
 *   this channel, which is what a step back or forward looks like once it has
 *   opened its channel.
 */
export function planVisit(
  current: ChannelHistoryEntry | null,
  nextChannelId: string | null,
  currentStillExists: boolean,
  fallbackIndex: number,
): { op: 'push' | 'replace'; entry: ChannelHistoryEntry } | null {
  if (nextChannelId === null) return null;
  if (current === null) return { op: 'replace', entry: { channelId: nextChannelId, index: fallbackIndex, depth: 0 } };
  if (current.channelId === nextChannelId) return null;
  return currentStillExists
    ? { op: 'push', entry: { channelId: nextChannelId, index: current.index + 1, depth: 0 } }
    : { op: 'replace', entry: { channelId: nextChannelId, index: current.index, depth: current.depth } };
}

/**
 * The marker to push when something has opened over the chat, given the entry
 * the page is on, the open channel, and how many layers are now open over it.
 * Null when none is needed.
 *
 * The marker names the open channel, so a reload on it reopens that channel,
 * and it sits one position past the current entry, so a step back from it
 * lands on the entry beneath and closes what was opened. Nothing is pushed
 * while the entry already covers that many layers over the same channel: one
 * panel opened from another, or a panel opened again before the quiet step off
 * its old marker has landed, needs no second marker, which is what keeps opening
 * and closing from piling entries up. Nor is anything pushed with no entry of
 * ours to go after or no channel to name, since a marker without one would
 * make back leave the app or open nothing.
 *
 * Nor, finally, for something that opened by itself (`userActivated` false):
 * the "What's new" notes after an update, or the owner's setup wizard. Chrome
 * lets a page add entries without a click, but marks the entry the page was on
 * as one its back button skips, so a marker pushed then would make back skip
 * the channel beneath it, and on the first channel leave the app altogether.
 * Without a marker a step back still closes what is open: it lands one entry
 * further back, and the page steps forward again (see returnAfterClose).
 */
export function planOverlay(
  current: ChannelHistoryEntry | null,
  activeChannelId: string | null,
  depth: number,
  userActivated = true,
): ChannelHistoryEntry | null {
  if (current === null || activeChannelId === null || depth === 0 || !userActivated) return null;
  if (current.channelId === activeChannelId && current.depth >= depth) return null;
  return { channelId: activeChannelId, index: current.index + 1, depth };
}

/**
 * Whether the page should step quietly back off the marker it is on, which is
 * when some of what the marker stands for has been closed through its own
 * controls (a close button, Escape, the backdrop) rather than by a step. Back
 * on the entry beneath, the next press does what it would have done had
 * nothing been opened. That matters most on the first channel of the installed
 * app, where a press with nowhere left to go closes the app: a marker left in
 * the way would swallow that press, and only the next one would close it.
 */
export function stepsOffMarker(
  current: ChannelHistoryEntry | null,
  activeChannelId: string | null,
  depth: number,
): boolean {
  return current !== null && current.channelId === activeChannelId && current.depth > depth;
}

/**
 * What to do when the browser has stepped onto one of our entries, given which
 * way it went and how many layers are open over the chat.
 *
 * - `close` closes the layers open above the entry's depth and stops there. A
 *   step back with something open over the chat only closes it: the channel
 *   stays as it is and nothing is skipped, so closing it is all the press does.
 *   A step forward never closes anything.
 * - `open` opens the entry's channel.
 * - `skip` keeps going the same way: the entry names the channel already open,
 *   or it is a marker, which a step passes over rather than reopening whatever
 *   it was pushed for. Stopping on either would make the press look like it did
 *   nothing.
 * - `stale` means the channel is gone. The entry is rewritten to the open
 *   channel, which also makes later steps skip it, and the step carries on.
 */
export function popAction(
  entry: ChannelHistoryEntry,
  activeChannelId: string | null,
  exists: boolean,
  direction: -1 | 1,
  openDepth: number,
): 'close' | 'open' | 'skip' | 'stale' {
  if (direction === -1 && openDepth > entry.depth) return 'close';
  if (entry.depth > 0 || entry.channelId === activeChannelId) return 'skip';
  return exists ? 'open' : 'stale';
}

/**
 * After a step back that only closed what was open (popAction's `close`), how
 * many entries forward the page should step to return to the entry the press
 * came from (`from`), or null to stay where it landed.
 *
 * Usually the step lands on the open channel's own entry or a marker over it,
 * and staying is right. But something that opened by itself has no marker (see
 * planOverlay), so the press lands on the entry before, for another channel,
 * while the open channel stays open. Writing the open channel's entry in again
 * there would be a push without a click, which Chrome answers by making its
 * back button skip the entry landed on: the next press would pass the channel
 * before, or leave the app. A step forward onto the entry the press came from
 * adds nothing, so it is taken instead.
 */
export function returnAfterClose(
  entry: ChannelHistoryEntry,
  from: ChannelHistoryEntry | null,
  activeChannelId: string | null,
): number | null {
  if (from === null || activeChannelId === null || entry.channelId === activeChannelId) return null;
  if (from.channelId !== activeChannelId || from.index <= entry.index) return null;
  return from.index - entry.index;
}

/**
 * Whether a skipped or stale step may carry on the same way from the entry at
 * `index`. Never back past the first of our entries, which is position 0: the
 * entry behind it is whatever page came before, and carrying on there would
 * leave the app over a press that only meant to change channel. Forward has no
 * such marker, but leaving forward means the member had already left this tab
 * for another page once, which the app itself never does.
 *
 * The exception is a step that left a marker over the open channel (`from` is
 * the entry it left). With nothing open, sitting on that marker is as good as
 * sitting on the channel's own entry, so a press from it may leave the app just
 * as a press from the first channel always could.
 */
export function mayCarryOn(
  direction: -1 | 1,
  index: number,
  from: ChannelHistoryEntry | null = null,
  activeChannelId: string | null = null,
): boolean {
  if (direction === 1 || index > 0) return true;
  return from !== null && from.depth > 0 && from.channelId === activeChannelId;
}

/** Which way a step from the entry at `from` to the one at `to` went: -1 back, 1 forward. */
export function stepDirection(from: number, to: number): -1 | 1 {
  return to < from ? -1 : 1;
}

/**
 * The history step a mouse button means: -1 for the back button and 1 for the
 * forward button, which `MouseEvent.button` numbers 3 and 4, and null for any
 * other button.
 */
export function mouseButtonStep(button: number): -1 | 1 | null {
  if (button === 3) return -1;
  if (button === 4) return 1;
  return null;
}
