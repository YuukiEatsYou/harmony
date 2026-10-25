/**
 * The pure half of the unread indicators: where the "new" line goes in a
 * channel, what the "new messages" bar says, the number on a mention pill and
 * the wording of a mute. It holds no state and touches no DOM, so the text
 * smoke test imports it straight into Node. Only the shapes it needs are named
 * here, so the tests can hand it plain objects rather than full messages.
 */

interface MessageLike {
  id: string;
  createdAt: string;
  author: { id: string } | null;
}

/** Whether a message arrived after the read marker and is somebody else's. */
function isNew(message: MessageLike, since: string, myId: string | undefined): boolean {
  return message.createdAt > since && (message.author === null || message.author.id !== myId);
}

/**
 * Whether the loaded stretch reaches back to the read marker, so that nothing
 * new can be hiding above it: its oldest message is one already read, or it
 * starts at the channel's very first message.
 */
function reachesPast(messages: readonly MessageLike[], since: string, complete: boolean): boolean {
  const oldest = messages[0];
  return complete || oldest === undefined || oldest.createdAt <= since;
}

/**
 * Which loaded message the "new" line sits above: the first one, by someone
 * else, newer than where the member had read to when they opened the channel.
 * Their own messages never count, so a line never appears over something they
 * sent from another device.
 *
 * When even the oldest loaded message came after the marker and older history
 * has not been loaded yet, the true first unread message may be further up, so
 * the line is not placed until it is; `complete` says the list reaches back to
 * the channel's very first message, in which case the top of the list is the
 * place.
 */
export function firstUnreadIndex(
  messages: readonly MessageLike[],
  since: string | null,
  myId: string | undefined,
  complete: boolean,
): number {
  if (since === null || !reachesPast(messages, since, complete)) return -1;
  return messages.findIndex((message) => isNew(message, since, myId));
}

/**
 * How many new messages the bar at the top of a channel counts, and whether
 * there are more than are loaded. Like Discord's, it counts what it has: when
 * the loaded stretch does not reach back to the read marker it says "50+"
 * rather than guessing.
 */
export function newMessageCount(
  messages: readonly MessageLike[],
  since: string | null,
  myId: string | undefined,
  complete: boolean,
): { count: number; more: boolean } {
  if (since === null) return { count: 0, more: false };
  const count = messages.filter((message) => isNew(message, since, myId)).length;
  return { count, more: count > 0 && !reachesPast(messages, since, complete) };
}

/** The bar's text, e.g. "3 new messages since 14:05" or "50+ new messages since …". */
export function newMessagesLabel(count: number, more: boolean, since: string, formatTime: (iso: string) => string): string {
  const amount = more ? `${count}+` : String(count);
  const noun = count === 1 && !more ? 'new message' : 'new messages';
  return `${amount} ${noun} since ${formatTime(since)}`;
}

/**
 * The unread list and mention counts once the server has said where one channel
 * stands, as marking it unread from a message answers: the channel is in the
 * list exactly when it is unread, and its count is set, or dropped at zero.
 * Every other channel is left as it was.
 */
export function withChannelReadState(
  unreadChannelIds: readonly string[],
  mentionCounts: Readonly<Record<string, number>>,
  state: { channelId: string; unread: boolean; mentionCount: number },
): { unreadChannelIds: string[]; mentionCounts: Record<string, number> } {
  const { channelId } = state;
  const listed = unreadChannelIds.includes(channelId);
  const ids = state.unread
    ? listed
      ? [...unreadChannelIds]
      : [...unreadChannelIds, channelId]
    : unreadChannelIds.filter((id) => id !== channelId);
  const counts = { ...mentionCounts };
  if (state.mentionCount > 0) counts[channelId] = state.mentionCount;
  else delete counts[channelId];
  return { unreadChannelIds: ids, mentionCounts: counts };
}

/** The number on a red mention pill, capped the way Discord caps it. */
export function pillCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * How a mute describes itself, for a tooltip or the menu. A mute ending today
 * gives just the time, one ending on another day gives the date too, and one
 * with no end says so.
 */
export function muteLabel(endsAt: string | null, now: number = Date.now()): string {
  if (endsAt === null) return 'Muted until you turn it back on';
  const end = new Date(endsAt);
  const time = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (end.toDateString() === new Date(now).toDateString()) return `Muted until ${time}`;
  const day = end.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `Muted until ${day}, ${time}`;
}
