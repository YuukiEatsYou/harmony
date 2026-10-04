import type { DatabaseSync } from 'node:sqlite';
import type { Reaction } from '@harmony/shared';

/**
 * Adds a reaction, ignoring a duplicate (the same user reacting twice with the
 * same emoji is a no-op rather than an error).
 */
export function insertReaction(
  sqlite: DatabaseSync,
  input: { messageId: string; userId: string; emoji: string; emojiId: string | null; createdAt: string },
): void {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, emoji_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.messageId, input.userId, input.emoji, input.emojiId, input.createdAt);
}

/** Removes one user's reaction. Returns true when a row was actually removed. */
export function deleteReaction(sqlite: DatabaseSync, messageId: string, userId: string, emoji: string): boolean {
  const result = sqlite
    .prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .run(messageId, userId, emoji);
  return Number(result.changes) > 0;
}

/** Removes every reaction for one emoji on a message (an admin action). */
export function deleteReactionsForEmoji(sqlite: DatabaseSync, messageId: string, emoji: string): number {
  const result = sqlite.prepare('DELETE FROM reactions WHERE message_id = ? AND emoji = ?').run(messageId, emoji);
  return Number(result.changes);
}

/** Removes every reaction on a message. */
export function deleteAllReactions(sqlite: DatabaseSync, messageId: string): number {
  const result = sqlite.prepare('DELETE FROM reactions WHERE message_id = ?').run(messageId);
  return Number(result.changes);
}

/** Number of users who reacted to a message with one emoji. */
export function countReaction(sqlite: DatabaseSync, messageId: string, emoji: string): number {
  const row = sqlite
    .prepare('SELECT COUNT(*) AS count FROM reactions WHERE message_id = ? AND emoji = ?')
    .get(messageId, emoji) as { count: number };
  return row.count;
}

/**
 * Like `countReaction`, but leaving out the stand-in accounts of Discord users:
 * the members who reacted here, as opposed to on the Discord side of a bridge.
 */
export function countLocalReaction(sqlite: DatabaseSync, messageId: string, emoji: string): number {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS count
         FROM reactions r
         JOIN users u ON u.id = r.user_id
        WHERE r.message_id = ? AND r.emoji = ? AND u.is_bot = 0`,
    )
    .get(messageId, emoji) as { count: number };
  return row.count;
}

/**
 * Aggregates reactions for several messages at once, keyed by message id.
 * `viewerId` decides the `me` flag on each group. Groups keep their insertion
 * order so the UI stays stable as reactions are added.
 */
export function listReactionsForMessages(
  sqlite: DatabaseSync,
  messageIds: string[],
  viewerId: string,
): Map<string, Reaction[]> {
  const result = new Map<string, Reaction[]>();
  if (messageIds.length === 0) return result;

  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = sqlite
    .prepare(
      `SELECT message_id, emoji, emoji_id,
              COUNT(*) AS count,
              MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS me,
              MIN(created_at) AS first_at
       FROM reactions
       WHERE message_id IN (${placeholders})
       GROUP BY message_id, emoji
       ORDER BY first_at, emoji`,
    )
    .all(viewerId, ...messageIds) as unknown as Array<{
    message_id: string;
    emoji: string;
    emoji_id: string | null;
    count: number;
    me: number;
  }>;

  for (const row of rows) {
    const list = result.get(row.message_id) ?? [];
    list.push({ emoji: row.emoji, emojiId: row.emoji_id, count: row.count, me: row.me === 1 });
    result.set(row.message_id, list);
  }
  return result;
}
