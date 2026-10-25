import type { DatabaseSync } from 'node:sqlite';

/**
 * How far a member has read a channel. Kept as the time of the newest message
 * they have seen, so a channel is unread when it holds anything newer.
 */
export function markChannelRead(sqlite: DatabaseSync, userId: string, channelId: string, readAt: string): void {
  sqlite
    .prepare(
      `INSERT INTO channel_reads (user_id, channel_id, read_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE
         SET read_at = MAX(channel_reads.read_at, excluded.read_at)`,
    )
    .run(userId, channelId, readAt);
}

/**
 * Puts a member's read marker exactly where it is told, back as well as forward,
 * for marking a channel unread from a message. Reading only ever moves the
 * marker on, through `markChannelRead`, so a read that arrives late cannot undo
 * one that came before it; this is the one deliberate exception.
 */
export function setChannelReadMarker(sqlite: DatabaseSync, userId: string, channelId: string, readAt: string): void {
  sqlite
    .prepare(
      `INSERT INTO channel_reads (user_id, channel_id, read_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET read_at = excluded.read_at`,
    )
    .run(userId, channelId, readAt);
}

/**
 * Which of these channels hold something this member has not read.
 *
 * A channel nobody has ever opened counts as unread as soon as it has a message,
 * which is what makes a fresh account on an established instance show what it has
 * missed. Callers pass only the channels the member may see, so a locked channel
 * is not even considered.
 *
 * A deleted message is gone as far as anyone reading is concerned, so it cannot
 * leave a channel lit up with nothing new to show for it. Neither can one of the
 * member's own: posting reads the channel anyway, and one sent from another
 * device is not news to whoever sent it.
 */
export function listUnreadChannelIds(sqlite: DatabaseSync, userId: string, channelIds: string[]): string[] {
  if (channelIds.length === 0) return [];

  const placeholders = channelIds.map(() => '?').join(', ');
  const rows = sqlite
    .prepare(
      `SELECT m.channel_id AS id
         FROM messages m
         LEFT JOIN channel_reads r ON r.user_id = ? AND r.channel_id = m.channel_id
        WHERE m.channel_id IN (${placeholders})
          AND m.deleted_at IS NULL
          AND (m.author_id IS NULL OR m.author_id <> ?)
        GROUP BY m.channel_id
       HAVING MAX(m.created_at) > COALESCE(MAX(r.read_at), '')`,
    )
    .all(userId, ...channelIds, userId) as unknown as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

/**
 * Where this member's read marker stands in each of these channels, for the
 * channels they have read at all. A client uses it to place the "new" line
 * above the first message that came after it.
 */
export function listReadMarkers(sqlite: DatabaseSync, userId: string, channelIds: string[]): Record<string, string> {
  if (channelIds.length === 0) return {};

  const placeholders = channelIds.map(() => '?').join(', ');
  const rows = sqlite
    .prepare(
      `SELECT channel_id AS id, read_at FROM channel_reads
        WHERE user_id = ? AND channel_id IN (${placeholders})`,
    )
    .all(userId, ...channelIds) as unknown as Array<{ id: string; read_at: string }>;

  return Object.fromEntries(rows.map((row) => [row.id, row.read_at]));
}
