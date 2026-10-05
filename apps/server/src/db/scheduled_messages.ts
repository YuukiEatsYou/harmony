import type { DatabaseSync } from 'node:sqlite';

export interface ScheduledRow {
  id: string;
  user_id: string;
  channel_id: string;
  content: string;
  reply_to_id: string | null;
  send_at: number;
  created_at: number;
  status: string;
  error: string | null;
}

export function insertScheduled(
  sqlite: DatabaseSync,
  input: {
    id: string;
    userId: string;
    channelId: string;
    content: string;
    replyToId: string | null;
    sendAt: number;
    createdAt: number;
    attachmentIds: string[];
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO scheduled_messages (id, user_id, channel_id, content, reply_to_id, send_at, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(input.id, input.userId, input.channelId, input.content, input.replyToId, input.sendAt, input.createdAt);
  const link = sqlite.prepare(
    'INSERT INTO scheduled_message_attachments (scheduled_id, attachment_id, position) VALUES (?, ?, ?)',
  );
  input.attachmentIds.forEach((attachmentId, position) => link.run(input.id, attachmentId, position));
}

export function findScheduled(sqlite: DatabaseSync, id: string): ScheduledRow | null {
  return (
    (sqlite.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id) as ScheduledRow | undefined) ?? null
  );
}

/** A member's scheduled messages, soonest first. */
export function listScheduledForUser(sqlite: DatabaseSync, userId: string): ScheduledRow[] {
  return sqlite
    .prepare('SELECT * FROM scheduled_messages WHERE user_id = ? ORDER BY send_at ASC, id ASC')
    .all(userId) as unknown as ScheduledRow[];
}

export function countScheduledForUser(sqlite: DatabaseSync, userId: string): number {
  const row = sqlite
    .prepare('SELECT COUNT(*) AS count FROM scheduled_messages WHERE user_id = ?')
    .get(userId) as { count: number };
  return row.count;
}

/** Ids of the pending messages whose time has come, oldest first. */
export function listDueScheduled(sqlite: DatabaseSync, now: number, limit: number): string[] {
  const rows = sqlite
    .prepare("SELECT id FROM scheduled_messages WHERE status = 'pending' AND send_at <= ? ORDER BY send_at, id LIMIT ?")
    .all(now, limit) as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** Attachment ids of a scheduled message, in the order they were attached. */
export function listScheduledAttachmentIds(sqlite: DatabaseSync, scheduledId: string): string[] {
  const rows = sqlite
    .prepare('SELECT attachment_id FROM scheduled_message_attachments WHERE scheduled_id = ? ORDER BY position')
    .all(scheduledId) as unknown as Array<{ attachment_id: string }>;
  return rows.map((row) => row.attachment_id);
}

/** Whether any scheduled message already holds this upload. */
export function attachmentIsScheduled(sqlite: DatabaseSync, attachmentId: string): boolean {
  return (
    sqlite.prepare('SELECT 1 FROM scheduled_message_attachments WHERE attachment_id = ?').get(attachmentId) !==
    undefined
  );
}

/**
 * Takes a pending row out of the list, returning whether this call was the one
 * to do it. The delivery runs this inside the transaction that inserts the real
 * message, so winning the claim and sending are one atomic step.
 */
export function claimScheduled(sqlite: DatabaseSync, id: string, allowedStatuses: string[]): boolean {
  const placeholders = allowedStatuses.map(() => '?').join(', ');
  const result = sqlite
    .prepare(`DELETE FROM scheduled_messages WHERE id = ? AND status IN (${placeholders})`)
    .run(id, ...allowedStatuses);
  return Number(result.changes) > 0;
}

export function markScheduledFailed(sqlite: DatabaseSync, id: string, error: string): void {
  sqlite.prepare("UPDATE scheduled_messages SET status = 'failed', error = ? WHERE id = ?").run(error, id);
}

export function updateScheduled(
  sqlite: DatabaseSync,
  id: string,
  changes: { content?: string; sendAt?: number },
): void {
  // A new time is the retry for a failed message, so it goes back in the queue;
  // fixing only the text leaves a failed one where it was.
  sqlite
    .prepare(
      `UPDATE scheduled_messages
          SET content = COALESCE(?, content),
              send_at = COALESCE(?, send_at),
              status = CASE WHEN ? IS NULL THEN status ELSE 'pending' END,
              error = CASE WHEN ? IS NULL THEN error ELSE NULL END
        WHERE id = ?`,
    )
    .run(changes.content ?? null, changes.sendAt ?? null, changes.sendAt ?? null, changes.sendAt ?? null, id);
}

export function deleteScheduled(sqlite: DatabaseSync, id: string): boolean {
  const result = sqlite.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}
