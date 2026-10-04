import type { DatabaseSync } from 'node:sqlite';
import type { MessageRow } from './messages.ts';

/** A message row carrying the mention that put it in someone's inbox. */
export interface MentionRow extends MessageRow {
  mention_kind: string;
  /** 1 when the channel has not been read since, 0 otherwise. */
  mention_unread: number;
}

/**
 * Records that `userId` should be told about `messageId`. One row per message
 * and recipient, so a message that both replies to someone and names them is
 * still a single entry; the first kind recorded wins.
 */
export function insertMention(
  sqlite: DatabaseSync,
  input: { messageId: string; userId: string; channelId: string; kind: 'mention' | 'reply'; createdAt: string },
): void {
  sqlite
    .prepare(
      `INSERT INTO mentions (message_id, user_id, channel_id, kind, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_id, user_id) DO NOTHING`,
    )
    .run(input.messageId, input.userId, input.channelId, input.kind, input.createdAt);
}

/**
 * Forgets who a message names, for an edit to record afresh. Reply rows are
 * kept: an edit cannot change which message a reply answers.
 */
export function deleteNameMentions(sqlite: DatabaseSync, messageId: string): void {
  sqlite.prepare(`DELETE FROM mentions WHERE message_id = ? AND kind = 'mention'`).run(messageId);
}

/**
 * The channels holding a mention or reply this member has not read, which is
 * what puts a mark beside them. A mention counts as read exactly when the
 * channel does, so the same cursor that clears a channel's unread mark clears
 * this too, and there is no second read state to keep in step.
 *
 * Callers pass only the channels the member may see, so a channel that has been
 * locked away is not even considered.
 */
export function listChannelsWithUnreadMentions(
  sqlite: DatabaseSync,
  userId: string,
  channelIds: string[],
): string[] {
  if (channelIds.length === 0) return [];

  const placeholders = channelIds.map(() => '?').join(', ');
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT mn.channel_id AS id
         FROM mentions mn
         JOIN messages m ON m.id = mn.message_id
         LEFT JOIN channel_reads r ON r.user_id = mn.user_id AND r.channel_id = mn.channel_id
        WHERE mn.user_id = ?
          AND m.deleted_at IS NULL
          AND mn.channel_id IN (${placeholders})
          AND mn.created_at > COALESCE(r.read_at, '')`,
    )
    .all(userId, ...channelIds) as unknown as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

/**
 * A member's own inbox, newest first. Only the channels they may see are asked
 * about, so a mention in a channel that has since been locked away simply
 * disappears from the list. The same `created_at` + id cursor as the rest of
 * the API pages through it.
 */
export function listMentions(
  sqlite: DatabaseSync,
  userId: string,
  channelIds: string[],
  options: { limit: number; before?: string | undefined; beforeId?: string | undefined },
): MentionRow[] {
  if (channelIds.length === 0) return [];
  const { limit, before, beforeId } = options;

  const placeholders = channelIds.map(() => '?').join(', ');
  const conditions = ['mn.user_id = ?', 'm.deleted_at IS NULL', `mn.channel_id IN (${placeholders})`];
  const values: Array<string | number> = [userId, ...channelIds];

  if (before !== undefined && beforeId !== undefined) {
    conditions.push('(m.created_at < ? OR (m.created_at = ? AND m.rowid < (SELECT rowid FROM messages WHERE id = ?)))');
    values.push(before, before, beforeId);
  } else if (before !== undefined) {
    conditions.push('m.created_at < ?');
    values.push(before);
  }

  values.push(limit);
  return sqlite
    .prepare(
      `SELECT m.*, mn.kind AS mention_kind,
              CASE WHEN mn.created_at > COALESCE(r.read_at, '') THEN 1 ELSE 0 END AS mention_unread
         FROM mentions mn
         JOIN messages m ON m.id = mn.message_id
         LEFT JOIN channel_reads r ON r.user_id = mn.user_id AND r.channel_id = mn.channel_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT ?`,
    )
    .all(...values) as unknown as MentionRow[];
}
