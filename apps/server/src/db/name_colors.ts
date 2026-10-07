import type { DatabaseSync } from 'node:sqlite';
import type { NameColor } from '@harmony/shared';

/** A palette entry an administrator offers for members' usernames. */
export interface NameColorRow {
  id: string;
  color: number;
  label: string | null;
  position: number;
  created_at: string;
}

export function toNameColor(row: NameColorRow): NameColor {
  return { id: row.id, color: row.color, label: row.label, position: row.position };
}

/** Display order: the position first, then creation, so it never depends on a tie. */
export function listNameColors(sqlite: DatabaseSync): NameColorRow[] {
  return sqlite
    .prepare('SELECT * FROM name_colors ORDER BY position, created_at')
    .all() as unknown as NameColorRow[];
}

export function findNameColor(sqlite: DatabaseSync, id: string): NameColorRow | null {
  return (sqlite.prepare('SELECT * FROM name_colors WHERE id = ?').get(id) as NameColorRow | undefined) ?? null;
}

export function nextNameColorPosition(sqlite: DatabaseSync): number {
  const row = sqlite.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM name_colors').get() as {
    position: number;
  };
  return row.position;
}

export function insertNameColor(
  sqlite: DatabaseSync,
  input: { id: string; color: number; label: string | null; position: number; createdAt: string },
): void {
  sqlite
    .prepare('INSERT INTO name_colors (id, color, label, position, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.id, input.color, input.label, input.position, input.createdAt);
}

export function updateNameColor(
  sqlite: DatabaseSync,
  id: string,
  patch: { color?: number; label?: string | null },
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.color !== undefined) {
    sets.push('color = ?');
    values.push(patch.color);
  }
  if (patch.label !== undefined) {
    sets.push('label = ?');
    values.push(patch.label);
  }
  if (sets.length === 0) return;
  values.push(id);
  sqlite.prepare(`UPDATE name_colors SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/** Removes an entry. Members who had picked it are dropped back to no color by the foreign key. */
export function deleteNameColor(sqlite: DatabaseSync, id: string): void {
  sqlite.prepare('DELETE FROM name_colors WHERE id = ?').run(id);
}

/** The members who picked this entry, so an edit or removal can tell them to refetch. */
export function listUserIdsWithNameColor(sqlite: DatabaseSync, id: string): string[] {
  const rows = sqlite.prepare('SELECT id FROM users WHERE name_color_id = ?').all(id) as unknown as Array<{
    id: string;
  }>;
  return rows.map((row) => row.id);
}
