import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ServerGif, ServerGifKind } from '@harmony/shared';

export interface ServerGifRow {
  id: string;
  kind: ServerGifKind;
  hash: string;
  filename: string;
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
  name: string;
  tags: string;
  position: number;
  pinned: number;
  added_by: string | null;
  created_at: string;
}

/** Tags are stored as one comma-separated string of lower-cased words. */
export function splitTags(stored: string): string[] {
  return stored.length === 0 ? [] : stored.split(',');
}

/** Lower-cases, trims and de-duplicates tags; commas cannot survive, as they are the separator. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const clean = tag.replace(/,/g, ' ').trim().toLowerCase();
    if (clean.length > 0) seen.add(clean);
  }
  return [...seen];
}

export function toServerGif(row: ServerGifRow): ServerGif {
  return {
    id: row.id,
    kind: row.kind,
    hash: row.hash,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    width: row.width,
    height: row.height,
    name: row.name,
    tags: splitTags(row.tags),
    position: row.position,
    pinned: row.pinned === 1,
    addedBy: row.added_by,
    createdAt: row.created_at,
  };
}

export interface ServerGifInput {
  kind: ServerGifKind;
  hash: string;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  name: string;
  tags: string[];
  pinned: boolean;
  addedBy: string;
}

/**
 * Writes a row for a picture. One row per hash: a picture that already has a
 * row (hidden, say, and now being curated) is turned into the new kind in
 * place, keeping its id. A newly curated gif goes to the end of the list.
 */
export function upsertServerGif(sqlite: DatabaseSync, input: ServerGifInput): ServerGifRow {
  const existing = findServerGifByHash(sqlite, input.hash);
  const tags = normalizeTags(input.tags).join(',');

  if (existing) {
    sqlite
      .prepare(
        'UPDATE server_gifs SET kind = ?, name = ?, tags = ?, pinned = ?, added_by = ?, position = ? WHERE id = ?',
      )
      .run(
        input.kind,
        input.name,
        tags,
        input.pinned ? 1 : 0,
        input.addedBy,
        input.kind === 'curated' ? nextPosition(sqlite) : existing.position,
        existing.id,
      );
    return findServerGif(sqlite, existing.id) as ServerGifRow;
  }

  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO server_gifs
         (id, kind, hash, filename, content_type, size, width, height, name, tags, position, pinned, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.kind,
      input.hash,
      input.filename,
      input.contentType,
      input.size,
      input.width,
      input.height,
      input.name,
      tags,
      input.kind === 'curated' ? nextPosition(sqlite) : 0,
      input.pinned ? 1 : 0,
      input.addedBy,
      new Date().toISOString(),
    );
  return findServerGif(sqlite, id) as ServerGifRow;
}

function nextPosition(sqlite: DatabaseSync): number {
  const row = sqlite
    .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM server_gifs WHERE kind = 'curated'")
    .get() as { next: number };
  return row.next;
}

export function findServerGif(sqlite: DatabaseSync, id: string): ServerGifRow | null {
  return (sqlite.prepare('SELECT * FROM server_gifs WHERE id = ?').get(id) as ServerGifRow | undefined) ?? null;
}

export function findServerGifByHash(sqlite: DatabaseSync, hash: string): ServerGifRow | null {
  return (sqlite.prepare('SELECT * FROM server_gifs WHERE hash = ?').get(hash) as ServerGifRow | undefined) ?? null;
}

/** Curated gifs in display order: pinned first, then by position, oldest first on a tie. */
export function listCuratedServerGifs(sqlite: DatabaseSync): ServerGifRow[] {
  return sqlite
    .prepare(
      "SELECT * FROM server_gifs WHERE kind = 'curated' ORDER BY pinned DESC, position ASC, created_at ASC, rowid ASC",
    )
    .all() as unknown as ServerGifRow[];
}

export function listHiddenServerGifs(sqlite: DatabaseSync): ServerGifRow[] {
  return sqlite
    .prepare("SELECT * FROM server_gifs WHERE kind = 'hidden' ORDER BY created_at DESC, rowid DESC")
    .all() as unknown as ServerGifRow[];
}

/** Every hash that has a row, of either kind: none of them belongs in the auto list. */
export function listServerGifHashes(sqlite: DatabaseSync): Set<string> {
  const rows = sqlite.prepare('SELECT hash FROM server_gifs').all() as unknown as Array<{ hash: string }>;
  return new Set(rows.map((row) => row.hash));
}

export function updateServerGifFields(
  sqlite: DatabaseSync,
  id: string,
  patch: { name?: string; tags?: string[]; pinned?: boolean; position?: number },
): ServerGifRow | null {
  const sets: string[] = [];
  const params: Array<string | number> = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.tags !== undefined) {
    sets.push('tags = ?');
    params.push(normalizeTags(patch.tags).join(','));
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = ?');
    params.push(patch.pinned ? 1 : 0);
  }
  if (patch.position !== undefined) {
    sets.push('position = ?');
    params.push(patch.position);
  }
  if (sets.length > 0) {
    sqlite.prepare(`UPDATE server_gifs SET ${sets.join(', ')} WHERE id = ? AND kind = 'curated'`).run(...params, id);
  }
  return findServerGif(sqlite, id);
}

/** Renumbers the listed curated gifs 0..n-1 in the order given, in one transaction. */
export function reorderServerGifs(sqlite: DatabaseSync, ids: readonly string[]): void {
  sqlite.exec('BEGIN');
  try {
    const update = sqlite.prepare("UPDATE server_gifs SET position = ? WHERE id = ? AND kind = 'curated'");
    ids.forEach((id, index) => update.run(index, id));
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

export function deleteServerGif(sqlite: DatabaseSync, id: string): boolean {
  return Number(sqlite.prepare('DELETE FROM server_gifs WHERE id = ?').run(id).changes) > 0;
}
