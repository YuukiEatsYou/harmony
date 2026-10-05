import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import {
  isGifContentType,
  isGifLinkUrl,
  type GifArchiveResponse,
  type GifFreeResponse,
  type GifSourceStats,
} from '@harmony/shared';
import type { AttachmentService, StoredImage } from '../attachments/service.ts';
import type { Config } from '../config.ts';
import { listReferencedHashes } from '../db/attachments.ts';
import {
  clearGifSourceCopy,
  clearGifSourcesForHash,
  countGifSourcesToArchive,
  failGifSource,
  findGifSource,
  gifSourceStats,
  isGifBlobHeldElsewhere,
  listDeadGifSources,
  listGifSourcesToArchive,
  listGifSourcesWithCopy,
  markGifSourceDead,
  reviveGifSource,
  setGifSourceCopy,
  touchGifSource,
  type GifSourceRow,
} from '../db/gif_sources.ts';
import { fetchPublicImage, type PublicImage } from '../embeds/media.ts';
import { HttpError } from '../http/errors.ts';
import { createBlobStore } from '../storage/blobs.ts';
import { normalizeGifSourceUrl } from './source-url.ts';

/** Replaces the guarded download; for tests, which cannot reach a gif host. */
export type FetchGifImage = (url: string, userAgent: string) => Promise<PublicImage | null>;

export interface GifSourceServiceDeps {
  attachments: Pick<AttachmentService, 'storeImageBytes'>;
  fetchImage?: FetchGifImage;
}

/**
 * The pairing between a remote gif address and the copy this server holds of it
 * (`gif_sources`). It is what makes the gif storage setting reversible: link
 * mode only records an address, store mode (or an admin) copies it later, and
 * wherever a copy exists it is reused rather than fetched again.
 */
export interface GifSourceService {
  /** Notes that an address passed through (a link, a pick). Never fetches. Null for an unusable address. */
  record(url: string, contentType?: string | null): GifSourceRow | null;
  /** Pairs an address with bytes that are already stored. */
  recordCopy(url: string, stored: StoredImage): void;
  /**
   * The row for an address when a copy of it is stored and its file is on disk.
   * A pairing whose file has gone is cleared on the way, so it is fetched again
   * instead of pointing at nothing.
   */
  copyFor(url: string): (GifSourceRow & { hash: string }) | null;
  /**
   * Like `copyFor`, but fetches the gif once when a recorded address has no copy
   * yet. Concurrent callers for one address share one download, a few downloads
   * run at a time, and an address that keeps failing is given up on. Never
   * creates a row: only addresses already recorded are fetched.
   */
  ensureCopy(url: string): Promise<(GifSourceRow & { hash: string }) | null>;
  /** Absolute path of a copy's bytes. */
  filePathFor(hash: string): string;
  stats(): GifSourceStats;
  /**
   * Copies up to `limit` recorded addresses that have no copy, including ones
   * previously given up on: one bounded batch, also the admin's retry.
   */
  archive(limit: number): Promise<GifArchiveResponse>;
  /**
   * Releases the copies of gifs that are still linked and that nothing else
   * keeps (no attachment, favorite or curated server gif). The addresses stay
   * recorded and can be copied again.
   */
  free(): GifFreeResponse;
  /** Clears the pairing of every copy of a blob that is about to be, or was, deleted. */
  forgetBlob(hash: string): void;
}

/** After a failed fetch an address is left alone this long, except when an admin asks. */
export const GIF_SOURCE_RETRY_MS = 5 * 60_000;
/** Downloads running at once, however many messages ask. */
const MAX_PARALLEL_FETCHES = 4;
const USER_AGENT = 'Harmony/1.0 gif-archive';

export function createGifSourceService(
  sqlite: DatabaseSync,
  config: Config,
  deps: GifSourceServiceDeps,
): GifSourceService {
  const blobs = createBlobStore(config);
  const fetchImage = deps.fetchImage ?? fetchPublicImage;
  const inFlight = new Map<string, Promise<(GifSourceRow & { hash: string }) | null>>();
  const waiting: Array<() => void> = [];
  let running = 0;

  async function withSlot<T>(job: () => Promise<T>): Promise<T> {
    if (running >= MAX_PARALLEL_FETCHES) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await job();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  }

  function copyFor(url: string): (GifSourceRow & { hash: string }) | null {
    const key = normalizeGifSourceUrl(url);
    if (key === null) return null;
    const row = findGifSource(sqlite, key);
    if (!row || row.hash === null) return null;
    if (!existsSync(blobs.pathFor(row.hash))) {
      // The file is gone (pruned, or removed by hand); forget the pairing.
      clearGifSourceCopy(sqlite, key);
      return null;
    }
    return row as GifSourceRow & { hash: string };
  }

  /** One download, stored. Counts a failure against the address. */
  async function fetchCopy(key: string): Promise<(GifSourceRow & { hash: string }) | null> {
    const media = await fetchImage(key, USER_AGENT).catch(() => null);
    const stored =
      media && isGifContentType(media.contentType)
        ? await deps.attachments.storeImageBytes(media.contentType, media.data).catch(() => null)
        : null;
    if (!stored) {
      failGifSource(sqlite, key);
      return null;
    }
    // A copy made for the pairing itself: the retention sweep keeps it until released.
    setGifSourceCopy(sqlite, key, stored, true);
    return copyFor(key);
  }

  function ensureCopy(url: string): Promise<(GifSourceRow & { hash: string }) | null> {
    const key = normalizeGifSourceUrl(url);
    if (key === null) return Promise.resolve(null);

    const existing = copyFor(key);
    if (existing) return Promise.resolve(existing);

    const row = findGifSource(sqlite, key);
    // Never fetched on the strength of the address alone: it must be one that was
    // recorded, on a gif host, still alive, and a kind of file that can be kept.
    if (!row || row.status === 'dead' || !isGifLinkUrl(key)) return Promise.resolve(null);
    if (row.content_type?.startsWith('video/')) return Promise.resolve(null);
    if (
      row.fail_count > 0 &&
      row.last_checked_at !== null &&
      Date.now() - Date.parse(row.last_checked_at) < GIF_SOURCE_RETRY_MS
    ) {
      return Promise.resolve(null);
    }

    const pending = inFlight.get(key);
    if (pending) return pending;
    const job = withSlot(() => fetchCopy(key)).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  }

  /** Deletes blobs that nothing at all refers to any more. Returns the bytes freed. */
  function deleteUnreferenced(hashes: Iterable<string>): number {
    const referenced = listReferencedHashes(sqlite);
    let bytes = 0;
    for (const hash of hashes) if (!referenced.has(hash)) bytes += blobs.delete(hash);
    return bytes;
  }

  let archiving = false;

  return {
    copyFor,
    ensureCopy,
    filePathFor: blobs.pathFor,
    stats: () => gifSourceStats(sqlite),

    record(url, contentType = null) {
      const key = normalizeGifSourceUrl(url);
      if (key === null || !isGifLinkUrl(key)) return null;
      touchGifSource(sqlite, key, contentType);
      // Recorded only after a check of the remote file passed, so a dead address
      // that answers again is alive again.
      reviveGifSource(sqlite, key);
      return findGifSource(sqlite, key);
    },

    recordCopy(url, stored) {
      const key = normalizeGifSourceUrl(url);
      if (key === null || !isGifLinkUrl(key) || !isGifContentType(stored.contentType)) return;
      // Mirrors bytes an attachment or a favorite holds; their retention governs the blob.
      setGifSourceCopy(sqlite, key, stored, false);
    },

    async archive(limit) {
      if (archiving) throw new HttpError(409, 'archive_running', 'An archive run is already in progress.');
      archiving = true;
      try {
        // Addresses tried in this run are stamped "now" and so are not "more" work.
        const startedAt = new Date().toISOString();
        const batch = listGifSourcesToArchive(sqlite, limit, startedAt);
        // The archive is the one explicit retry, so fill any room left in the
        // batch with addresses that were given up on and can be tried again.
        if (batch.length < limit) batch.push(...listDeadGifSources(sqlite, limit - batch.length, startedAt));
        let copied = 0;
        let failed = 0;
        let markedDead = 0;

        const queue = [...batch];
        const worker = async (): Promise<void> => {
          for (let row = queue.shift(); row; row = queue.shift()) {
            // Straight to the download: an admin asked, so the retry spacing is waived.
            // Never fetched, whatever the table says: only gif hosts are ever copied.
            if (!isGifLinkUrl(row.url)) {
              markGifSourceDead(sqlite, row.url);
              markedDead += 1;
              continue;
            }
            const result = await fetchCopy(row.url);
            if (result) copied += 1;
            else {
              failed += 1;
              if (findGifSource(sqlite, row.url)?.status === 'dead') markedDead += 1;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_FETCHES, batch.length) }, worker));

        return {
          attempted: batch.length,
          copied,
          failed,
          markedDead,
          more: countGifSourcesToArchive(sqlite, startedAt) > 0,
          stats: gifSourceStats(sqlite),
        };
      } finally {
        archiving = false;
      }
    },

    free() {
      const released = new Set<string>();
      let releasedCount = 0;
      let freedBytes = 0;
      let after: string | null = null;
      for (;;) {
        const page = listGifSourcesWithCopy(sqlite, 200, after);
        if (page.length === 0) break;
        after = page[page.length - 1]?.url ?? null;
        for (const row of page) {
          if (row.hash === null || !isGifLinkUrl(row.url)) continue;
          if (isGifBlobHeldElsewhere(sqlite, row.hash)) continue;
          clearGifSourceCopy(sqlite, row.url);
          releasedCount += 1;
          released.add(row.hash);
        }
      }
      // Another address may still pair with a blob just released; the reference
      // scan inside keeps it. Only blobs nothing refers to go.
      freedBytes = deleteUnreferenced(released);
      return { released: releasedCount, freedBytes, stats: gifSourceStats(sqlite) };
    },

    forgetBlob(hash) {
      clearGifSourcesForHash(sqlite, hash);
    },
  };
}
