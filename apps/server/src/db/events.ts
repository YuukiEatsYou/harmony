import type { DatabaseSync } from 'node:sqlite';

export interface EventRow {
  id: string;
  title: string;
  description: string;
  location_kind: 'channel' | 'external';
  channel_id: string | null;
  location_text: string;
  starts_at: number;
  ends_at: number | null;
  creator_id: string | null;
  status: 'scheduled' | 'active' | 'ended' | 'canceled';
  created_at: string;
  updated_at: string;
  announced_message_id: string | null;
  reminded_at: number | null;
}

export function insertEvent(
  sqlite: DatabaseSync,
  input: {
    id: string;
    title: string;
    description: string;
    locationKind: 'channel' | 'external';
    channelId: string | null;
    locationText: string;
    startsAt: number;
    endsAt: number | null;
    creatorId: string;
    now: string;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO events (id, title, description, location_kind, channel_id, location_text,
                           starts_at, ends_at, creator_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
    )
    .run(
      input.id,
      input.title,
      input.description,
      input.locationKind,
      input.channelId,
      input.locationText,
      input.startsAt,
      input.endsAt,
      input.creatorId,
      input.now,
      input.now,
    );
}

export function findEvent(sqlite: DatabaseSync, id: string): EventRow | null {
  const row = sqlite.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
  return row ?? null;
}

/** The fields an edit may change. `remindedAt: null` re-arms the reminder. */
export interface EventPatch {
  title?: string;
  description?: string;
  locationKind?: 'channel' | 'external';
  channelId?: string | null;
  locationText?: string;
  startsAt?: number;
  endsAt?: number | null;
  remindedAt?: number | null;
}

export function updateEvent(sqlite: DatabaseSync, id: string, patch: EventPatch, now: string): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  const add = (column: string, value: string | number | null | undefined) => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    values.push(value);
  };
  add('title', patch.title);
  add('description', patch.description);
  add('location_kind', patch.locationKind);
  add('channel_id', patch.channelId);
  add('location_text', patch.locationText);
  add('starts_at', patch.startsAt);
  add('ends_at', patch.endsAt);
  add('reminded_at', patch.remindedAt);
  sets.push('updated_at = ?');
  values.push(now, id);
  sqlite.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/** Moves an event to a new status only from one of the expected ones. True when it moved. */
export function setEventStatus(
  sqlite: DatabaseSync,
  id: string,
  from: EventRow['status'][],
  to: EventRow['status'],
  now: string,
): boolean {
  const placeholders = from.map(() => '?').join(', ');
  const result = sqlite
    .prepare(`UPDATE events SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`)
    .run(to, now, id, ...from);
  return Number(result.changes) > 0;
}

export function setEventAnnouncement(sqlite: DatabaseSync, id: string, messageId: string): void {
  sqlite.prepare('UPDATE events SET announced_message_id = ? WHERE id = ?').run(messageId, id);
}

export function countOpenEvents(sqlite: DatabaseSync): number {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE status IN ('scheduled', 'active')`)
    .get() as { n: number };
  return Number(row.n);
}

/** Every event that has not finished, for the list. */
export function listOpenEvents(sqlite: DatabaseSync): EventRow[] {
  return sqlite
    .prepare(`SELECT * FROM events WHERE status IN ('scheduled', 'active') ORDER BY starts_at ASC, id ASC`)
    .all() as unknown as EventRow[];
}

/** Recently finished or canceled events, latest first, bounded. */
export function listPastEvents(sqlite: DatabaseSync, since: number, limit: number): EventRow[] {
  return sqlite
    .prepare(
      `SELECT * FROM events
        WHERE status IN ('ended', 'canceled')
          AND COALESCE(ends_at, starts_at) >= ?
        ORDER BY COALESCE(ends_at, starts_at) DESC, id DESC
        LIMIT ?`,
    )
    .all(since, limit) as unknown as EventRow[];
}

/** Scheduled events whose start has come, for the sweep. */
export function listEventsToStart(sqlite: DatabaseSync, now: number): EventRow[] {
  return sqlite
    .prepare(`SELECT * FROM events WHERE status = 'scheduled' AND starts_at <= ? ORDER BY starts_at ASC`)
    .all(now) as unknown as EventRow[];
}

/** Active events, for the sweep to end when their time is up. */
export function listActiveEvents(sqlite: DatabaseSync): EventRow[] {
  return sqlite.prepare(`SELECT * FROM events WHERE status = 'active'`).all() as unknown as EventRow[];
}

/** Scheduled events inside their reminder window that have not been reminded yet. */
export function listEventsToRemind(sqlite: DatabaseSync, now: number, leadMs: number): EventRow[] {
  return sqlite
    .prepare(
      `SELECT * FROM events
        WHERE status = 'scheduled' AND reminded_at IS NULL AND starts_at - ? <= ?
        ORDER BY starts_at ASC`,
    )
    .all(leadMs, now) as unknown as EventRow[];
}

/** Stamps the reminder as sent; false when something else already did. */
export function markEventReminded(sqlite: DatabaseSync, id: string, now: number): boolean {
  const result = sqlite
    .prepare('UPDATE events SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL')
    .run(now, id);
  return Number(result.changes) > 0;
}

// ---- RSVPs ----

/** Adds an interest. False when the member already had one. */
export function addRsvp(sqlite: DatabaseSync, eventId: string, userId: string, now: string): boolean {
  const result = sqlite
    .prepare('INSERT OR IGNORE INTO event_rsvps (event_id, user_id, created_at) VALUES (?, ?, ?)')
    .run(eventId, userId, now);
  return Number(result.changes) > 0;
}

/** Removes an interest. False when there was none. */
export function removeRsvp(sqlite: DatabaseSync, eventId: string, userId: string): boolean {
  const result = sqlite
    .prepare('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?')
    .run(eventId, userId);
  return Number(result.changes) > 0;
}

export function countRsvps(sqlite: DatabaseSync, eventId: string): number {
  const row = sqlite.prepare('SELECT COUNT(*) AS n FROM event_rsvps WHERE event_id = ?').get(eventId) as {
    n: number;
  };
  return Number(row.n);
}

/** Interest counts for a batch of events, one query. */
export function countRsvpsFor(sqlite: DatabaseSync, eventIds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (eventIds.length === 0) return counts;
  const placeholders = eventIds.map(() => '?').join(', ');
  const rows = sqlite
    .prepare(
      `SELECT event_id, COUNT(*) AS n FROM event_rsvps WHERE event_id IN (${placeholders}) GROUP BY event_id`,
    )
    .all(...eventIds) as unknown as Array<{ event_id: string; n: number }>;
  for (const row of rows) counts.set(row.event_id, Number(row.n));
  return counts;
}

/** Which of these events the member is interested in. */
export function listRsvpsAmong(sqlite: DatabaseSync, userId: string, eventIds: string[]): Set<string> {
  if (eventIds.length === 0) return new Set();
  const placeholders = eventIds.map(() => '?').join(', ');
  const rows = sqlite
    .prepare(`SELECT event_id FROM event_rsvps WHERE user_id = ? AND event_id IN (${placeholders})`)
    .all(userId, ...eventIds) as unknown as Array<{ event_id: string }>;
  return new Set(rows.map((row) => row.event_id));
}

/** Who is interested, earliest first, bounded. */
export function listInterestedUserIds(sqlite: DatabaseSync, eventId: string, limit?: number): string[] {
  const rows = sqlite
    .prepare(
      `SELECT user_id FROM event_rsvps WHERE event_id = ? ORDER BY created_at ASC, user_id ASC LIMIT ?`,
    )
    .all(eventId, limit ?? -1) as unknown as Array<{ user_id: string }>;
  return rows.map((row) => row.user_id);
}
