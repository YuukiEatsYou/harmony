/**
 * The pure half of editing from the keyboard; the shared edit state itself is
 * message-edit.svelte.ts. Only the shapes it needs are named, so the text smoke
 * test can hand it plain objects rather than full messages.
 */

/**
 * The message the Up arrow edits: the newest one loaded that the member wrote
 * and may edit. A poll's text is its question and cannot be edited, so polls are
 * passed over, as the Edit button already leaves them out.
 */
export function lastEditable<M extends { author: { id: string } | null; poll: unknown }>(
  messages: readonly M[],
  userId: string | undefined,
): M | null {
  if (!userId) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message && message.author?.id === userId && !message.poll) return message;
  }
  return null;
}
