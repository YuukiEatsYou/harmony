/**
 * The pure half of showing a channel somewhere other than its newest page:
 * laying out the page fetched around a linked message, joining it to the present
 * when the two meet, and carrying an older stretch forward a page at a time
 * until it reaches the present again. It holds no state and touches no DOM, so
 * the text smoke test imports it straight into Node. Only the shapes it needs
 * are named, so the tests can hand it plain objects rather than full messages.
 */
import { historyAroundSplit } from '@harmony/shared';

interface MessageLike {
  id: string;
  createdAt: string;
}

/** What the open channel's list becomes, and where it stands in the channel. */
export interface HistoryWindow<T extends MessageLike> {
  messages: T[];
  /** Whether older messages may exist beyond the oldest one in the list. */
  hasMore: boolean;
  /**
   * Whether the list stops short of the channel's newest message, so live
   * messages are held back and the reader is offered the way forward.
   */
  detached: boolean;
}

/**
 * Lays out the page the server returned around a message.
 *
 * `present` is what is known of the channel's newest stretch: the list on screen
 * when it already reaches the present, or a newest page fetched alongside. When
 * the page around the message meets it, the two become one list and the reader
 * is simply in the present, with the message somewhere above. Otherwise the page
 * stands on its own as an older stretch, unless its newer side came back short,
 * which says it reaches the newest message by itself.
 *
 * Whether older messages exist is read the same way from the older side: a full
 * side may have more beyond it, as a full page does when paging back. Null when
 * the page does not hold the message, which the server never sends.
 */
export function windowAround<T extends MessageLike>(
  page: readonly T[],
  messageId: string,
  limit: number,
  present: { messages: readonly T[]; hasMore: boolean } | null,
): HistoryWindow<T> | null {
  const index = page.findIndex((message) => message.id === messageId);
  if (index === -1) return null;
  const split = historyAroundSplit(limit);
  const olderBeyond = index >= split.before;
  const reachesNewest = page.length - index - 1 < split.after;

  const joined = present ? joinPresent(page, present.messages) : null;
  if (joined && present) {
    // The joined list starts wherever the earlier of the two did, and that one
    // is what knows whether anything older lies beyond it.
    const startsWithPage = joined[0]?.id === page[0]?.id;
    return { messages: joined, hasMore: startsWithPage ? olderBeyond : present.hasMore, detached: false };
  }
  return { messages: [...page], hasMore: olderBeyond, detached: !reachesNewest };
}

/**
 * The page and the present as one list, when they share a message; null when a
 * gap may lie between them. Both are unbroken runs of the same channel, so once
 * they overlap, whatever of the page the present lacks comes before it, or after
 * it for a message that landed since the present was last brought up to date.
 */
function joinPresent<T extends MessageLike>(page: readonly T[], present: readonly T[]): T[] | null {
  const first = present[0];
  const last = present.at(-1);
  if (!first || !last) return null;
  const ids = new Set(present.map((message) => message.id));
  if (!page.some((message) => ids.has(message.id))) return null;
  const older = page.filter((message) => !ids.has(message.id) && message.createdAt <= first.createdAt);
  const newer = page.filter((message) => !ids.has(message.id) && message.createdAt > last.createdAt);
  return [...older, ...present, ...newer];
}

/**
 * Carries an older stretch one page forward, with the page fetched just after
 * its newest message. A page shorter than the limit reaches the newest message,
 * so the stretch has rejoined the present. A message already held, such as a
 * live one that belonged inside the stretch, is not repeated.
 */
export function appendNewer<T extends MessageLike>(
  loaded: readonly T[],
  page: readonly T[],
  limit: number,
): { messages: T[]; detached: boolean } {
  const ids = new Set(loaded.map((message) => message.id));
  return {
    messages: [...loaded, ...page.filter((message) => !ids.has(message.id))],
    detached: page.length >= limit,
  };
}
