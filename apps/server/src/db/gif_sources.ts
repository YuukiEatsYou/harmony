import type { DatabaseSync } from 'node:sqlite';
import type { GifSourceStats } from '@harmony/shared';

export interface GifSourceRow {
  url: string;
  hash: string | null;
  content_type: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  first_seen_at: string;
  last_seen_at: string;
  copied_at: string | null;
  /** 1 when the pairing itself keeps the blob alive (see migration 31). */
  held: number;
  last_checked_at: string | null;
  fail_count: number;
  status: 'ok' | 'dead';
}

/** Failed fetches in a row after which an address is given up on. */
export const GIF_SOURCE_DEAD_AFTER = 3;

export interface GifSourceCopy {
  hash: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
}

export function findGifSource(sqlite: DatabaseSync, url: string): GifSourceRow | null {
  return (sqlite.prepare('SELECT * FROM gif_sources WHERE url = ?').get(url) as GifSourceRow | undefined) ?? null;
}

/**
 * Records that an address was seen, creating its row on first sight. A repeat
 * only moves `last_seen_at`, so the same address never has two rows. The content
 * type is filled in when it was not known yet.
 */
export function touchGifSource(sqlite: DatabaseSync, url: string, contentType: string | null): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO gif_sources (url, content_type, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         content_type = COALESCE(gif_sources.content_type, excluded.content_type)`,
    )
    .run(url, contentType, now, now);
}

/**
 * Pairs an address with a stored copy, clearing any record of failures. `held`
 * marks a copy made for the pairing itself; a pairing that only mirrors bytes
 * somebody else holds leaves an existing hold as it was.
 */
export function setGifSourceCopy(sqlite: DatabaseSync, url: string, copy: GifSourceCopy, held: boolean): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO gif_sources
         (url, hash, content_type, size, width, height, first_seen_at, last_seen_at, copied_at, held, last_checked_at, fail_count, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ok')
       ON CONFLICT(url) DO UPDATE SET
         held = CASE WHEN excluded.hash = gif_sources.hash THEN MAX(gif_sources.held, excluded.held) ELSE excluded.held END,
         hash = excluded.hash,
         content_type = excluded.content_type,
         size = excluded.size,
         width = excluded.width,
         height = excluded.height,
         last_seen_at = excluded.last_seen_at,
         copied_at = excluded.copied_at,
         last_checked_at = excluded.last_checked_at,
         fail_count = 0,
         status = 'ok'`,
    )
    .run(url, copy.hash, copy.contentType, copy.size, copy.width, copy.height, now, now, now, held ? 1 : 0, now);
}

/** Notes a failed fetch; the address is given up on after enough of them. Returns whether it is now dead. */
export function failGifSource(sqlite: DatabaseSync, url: string): boolean {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `UPDATE gif_sources
       SET fail_count = fail_count + 1,
           last_checked_at = ?,
           status = CASE WHEN fail_count + 1 >= ? THEN 'dead' ELSE status END
       WHERE url = ?`,
    )
    .run(now, GIF_SOURCE_DEAD_AFTER, url);
  return findGifSource(sqlite, url)?.status === 'dead';
}

/** Gives up on an address that can never be copied (not a gif host, say). */
export function markGifSourceDead(sqlite: DatabaseSync, url: string): void {
  sqlite.prepare("UPDATE gif_sources SET status = 'dead', last_checked_at = ? WHERE url = ?").run(new Date().toISOString(), url);
}

/** Gives a dead address another chance; used when it has just been seen alive again. */
export function reviveGifSource(sqlite: DatabaseSync, url: string): void {
  sqlite.prepare("UPDATE gif_sources SET status = 'ok', fail_count = 0 WHERE url = ? AND status = 'dead'").run(url);
}

/** Forgets the copy an address pointed at (the file is gone or being released). */
export function clearGifSourceCopy(sqlite: DatabaseSync, url: string): void {
  sqlite.prepare('UPDATE gif_sources SET hash = NULL, copied_at = NULL, held = 0 WHERE url = ?').run(url);
}

/** Forgets every pairing with a blob that no longer exists. */
export function clearGifSourcesForHash(sqlite: DatabaseSync, hash: string): number {
  return Number(
    sqlite.prepare('UPDATE gif_sources SET hash = NULL, copied_at = NULL, held = 0 WHERE hash = ?').run(hash).changes,
  );
}

const ARCHIVABLE_SQL = `hash IS NULL AND status = 'ok'
  AND (content_type IS NULL OR content_type NOT LIKE 'video/%')
  AND (last_checked_at IS NULL OR last_checked_at < ?)`;

/** Addresses recorded without a copy, not given up on, that are worth fetching now. */
export function listGifSourcesToArchive(sqlite: DatabaseSync, limit: number, retryBefore: string): GifSourceRow[] {
  return sqlite
    .prepare(`SELECT * FROM gif_sources WHERE ${ARCHIVABLE_SQL} ORDER BY last_seen_at DESC LIMIT ?`)
    .all(retryBefore, limit) as unknown as GifSourceRow[];
}

export function countGifSourcesToArchive(sqlite: DatabaseSync, retryBefore: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM gif_sources WHERE ${ARCHIVABLE_SQL}`).get(retryBefore) as {
    n: number;
  };
  return row.n;
}

export function gifSourceStats(sqlite: DatabaseSync): GifSourceStats {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN hash IS NULL AND status = 'ok' THEN 1 ELSE 0 END), 0) AS linked,
              COALESCE(SUM(CASE WHEN hash IS NOT NULL THEN 1 ELSE 0 END), 0) AS archived,
              COALESCE(SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END), 0) AS dead
       FROM gif_sources`,
    )
    .get() as { total: number; linked: number; archived: number; dead: number };
  // Counted once per picture: two addresses can share one blob.
  const bytes = sqlite
    .prepare(
      `SELECT COALESCE(SUM(size), 0) AS n FROM
         (SELECT hash, MAX(size) AS size FROM gif_sources WHERE hash IS NOT NULL GROUP BY hash)`,
    )
    .get() as { n: number };
  return {
    total: Number(row.total),
    linked: Number(row.linked),
    archived: Number(row.archived),
    dead: Number(row.dead),
    archivedBytes: Number(bytes.n),
  };
}

/** Sources holding a copy, in address order, a page at a time. */
export function listGifSourcesWithCopy(sqlite: DatabaseSync, limit: number, afterUrl: string | null): GifSourceRow[] {
  return sqlite
    .prepare(
      `SELECT * FROM gif_sources
       WHERE held = 1 AND hash IS NOT NULL AND (? IS NULL OR url > ?)
       ORDER BY url
       LIMIT ?`,
    )
    .all(afterUrl, afterUrl, limit) as unknown as GifSourceRow[];
}

/** Copies, oldest first: the ones to release first when space runs out. */
export function listOldestGifCopies(sqlite: DatabaseSync, limit: number): GifSourceRow[] {
  return sqlite
    .prepare('SELECT * FROM gif_sources WHERE held = 1 AND hash IS NOT NULL ORDER BY copied_at ASC, url ASC LIMIT ?')
    .all(limit) as unknown as GifSourceRow[];
}

/** Every blob hash some address is currently paired with. */
export function listGifHashesPaired(sqlite: DatabaseSync): string[] {
  const rows = sqlite.prepare('SELECT DISTINCT hash FROM gif_sources WHERE hash IS NOT NULL').all() as unknown as Array<{
    hash: string;
  }>;
  return rows.map((row) => row.hash);
}

function tableExists(sqlite: DatabaseSync, name: string): boolean {
  return sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/**
 * Whether something other than a gif source's own pairing keeps this blob: a
 * message attachment, a member's favorite, or a curated server gif. This is the
 * single place the question is answered for "free copies" and emergency
 * pruning, so a new holder of gif blobs is added here and nowhere else.
 *
 * `server_gifs` is created by a separate migration; the table is consulted only
 * when it exists.
 */
export function isGifBlobHeldElsewhere(sqlite: DatabaseSync, hash: string): boolean {
  const held = (sql: string): boolean => sqlite.prepare(sql).get(hash) !== undefined;
  if (held('SELECT 1 FROM attachments WHERE hash = ? LIMIT 1')) return true;
  if (held('SELECT 1 FROM gif_favorites WHERE hash = ? LIMIT 1')) return true;
  if (tableExists(sqlite, 'server_gifs') && held('SELECT 1 FROM server_gifs WHERE hash = ? LIMIT 1')) return true;
  return false;
}
