import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** How many previous versions a message keeps; the oldest are dropped first. */
export const MAX_MESSAGE_EDITS = 20;

export interface MessageEditRow {
  id: string;
  message_id: string;
  editor_id: string | null;
  content: string;
  edited_at: string;
  source: 'harmony' | 'discord';
}

/**
 * Saves the text a message is about to lose, then trims the oldest versions past
 * the cap. `editedAt` is when the edit happened, i.e. when this text stopped being
 * the current one.
 */
export function recordMessageEdit(
  sqlite: DatabaseSync,
  input: {
    messageId: string;
    editorId: string | null;
    content: string;
    editedAt: string;
    source: 'harmony' | 'discord';
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO message_edits (id, message_id, editor_id, content, edited_at, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), input.messageId, input.editorId, input.content, input.editedAt, input.source);
  sqlite
    .prepare(
      `DELETE FROM message_edits WHERE message_id = ? AND id NOT IN (
         SELECT id FROM message_edits WHERE message_id = ?
         ORDER BY edited_at DESC, rowid DESC LIMIT ?)`,
    )
    .run(input.messageId, input.messageId, MAX_MESSAGE_EDITS);
}

/** A message's saved versions, newest first. */
export function listMessageEdits(sqlite: DatabaseSync, messageId: string): MessageEditRow[] {
  return sqlite
    .prepare('SELECT * FROM message_edits WHERE message_id = ? ORDER BY edited_at DESC, rowid DESC')
    .all(messageId) as unknown as MessageEditRow[];
}
