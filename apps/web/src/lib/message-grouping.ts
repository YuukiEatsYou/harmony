/**
 * The pure half of message grouping: which messages continue the one above them.
 * It holds no state and touches no DOM, so the text smoke test imports it
 * straight into Node. Only the shapes it needs are named here, so the tests can
 * hand it plain objects rather than full messages.
 */

/** Consecutive messages from one author within this window are grouped. */
export const GROUPING_WINDOW_MS = 7 * 60 * 1000;

interface GroupableMessage {
  id: string;
  createdAt: string;
  author: { id: string } | null;
  replyTo: { id: string } | null;
}

/**
 * Whether a message continues the previous one: same author, close in time, and
 * not a reply (a reply always shows its own header, like Discord).
 */
export function isGrouped(previous: GroupableMessage | undefined, message: GroupableMessage): boolean {
  if (!previous?.author || !message.author) return false;
  if (message.replyTo) return false;
  if (previous.author.id !== message.author.id) return false;
  const gap = new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime();
  return gap >= 0 && gap <= GROUPING_WINDOW_MS;
}

/**
 * Messages paired with whether they continue the previous one, so the flag is
 * evaluated against the whole list at once and cannot go stale as messages
 * arrive. `dividerId` is the message the "new" line sits above: it starts afresh
 * under that line, header and all, so it is never grouped.
 */
export function groupedRows<M extends GroupableMessage>(
  messages: readonly M[],
  dividerId: string | null,
): Array<{ message: M; grouped: boolean }> {
  return messages.map((message, index) => ({
    message,
    grouped: message.id !== dividerId && isGrouped(index > 0 ? messages[index - 1] : undefined, message),
  }));
}
