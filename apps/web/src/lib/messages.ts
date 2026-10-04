import type { Message, User } from '@harmony/shared';
// The extension is deliberate: unlike the rest of the client's modules, this one
// is imported straight by Node in the text smoke test, which resolves nothing.
import { parseMessage } from './message-text.ts';

/**
 * Whether a message is aimed at one particular user: a reply to them, or their
 * name mentioned in the text. A name inside a code block is being quoted rather
 * than called, so it does not count.
 */
export function mentionsUser(
  message: Message,
  userId: string,
  resolve: (username: string) => User | undefined,
): boolean {
  if (message.replyTo?.author?.id === userId) return true;

  // Only mentions matter here, so the emoji lookup stays empty rather than
  // dragging the whole emoji list into a notification decision.
  const blocks = parseMessage(message.content, new Map(), resolve);
  return blocks.some(
    (block) =>
      block.type !== 'code' &&
      block.segments.some((segment) => segment.type === 'mention' && segment.user.id === userId),
  );
}

export interface MergeResult {
  messages: Message[];
  /**
   * True when what was loaded before no longer lines up with the fresh page, so
   * the older pages were let go: either the fresh page does not reach back to
   * them (more arrived than one page holds, and splicing them together would
   * hide the gap), or it is the whole channel. Whether there is older history
   * then has to be decided from the fresh page alone.
   */
  reset: boolean;
}

/**
 * Folds a freshly fetched newest page into the messages already loaded.
 *
 * Used when the client catches up after being away, where replacing the whole
 * list would throw away the older pages someone may have scrolled back to.
 *
 * The fresh page is the server's word on everything in its time range: anything
 * loaded from that range that it no longer holds was deleted meanwhile and goes,
 * and everything it does hold replaces what was loaded, so an edit or a reaction
 * made meanwhile shows up. Older pages outside its range are kept as they are.
 * Messages loaded after the page was fetched (a live one racing the request) are
 * newer than anything in it and are kept on the end.
 *
 * `complete` says the fresh page reaches back to the channel's very first
 * message, as a short page does; then nothing older survives at all.
 */
export function mergeLatest(loaded: Message[], fresh: Message[], complete: boolean): MergeResult {
  const oldest = fresh[0];
  const newest = fresh.at(-1);
  if (!oldest || !newest) return { messages: [], reset: true };

  const freshIds = new Set(fresh.map((message) => message.id));
  const lastLoaded = loaded.at(-1);

  // Nothing in common: the fresh page starts after the last message loaded, so
  // whatever came between is missing. Starting over at the present is honest;
  // the older history is a "load older" away.
  if (!complete && (!lastLoaded || oldest.createdAt > lastLoaded.createdAt)) {
    return { messages: fresh, reset: true };
  }

  // Messages sharing the fresh page's oldest millisecond may sit just below it,
  // so only strictly newer ones count as covered by the page.
  const older = complete
    ? []
    : loaded.filter((message) => !freshIds.has(message.id) && message.createdAt <= oldest.createdAt);
  const later = loaded.filter((message) => !freshIds.has(message.id) && message.createdAt > newest.createdAt);
  return { messages: [...older, ...fresh, ...later], reset: complete };
}
