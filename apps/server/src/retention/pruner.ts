import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { GatewayEvent, type PruneSummary, type RetentionUsage } from '@harmony/shared';
import type { Config } from '../config.ts';
import {
  countAttachments,
  deleteImageAttachmentsOlderThan,
  deleteOldestAttachments,
  deleteUnattachedAttachmentsOlderThan,
  deleteVideoAttachmentsOlderThan,
  listReferencedHashes,
} from '../db/attachments.ts';
import { countMessages, deleteMessagesOlderThan } from '../db/messages.ts';
import { deleteExternalEmojisUnusedBefore } from '../db/emojis.ts';
import { deleteStickersUnusedBefore } from '../db/stickers.ts';
import { deleteAuditOlderThan } from '../db/audit.ts';
import { deleteGifFavoritesUnusedBefore } from '../db/gif_favorites.ts';
import {
  clearGifSourcesForHash,
  isGifBlobHeldElsewhere,
  listGifHashesPaired,
  listOldestGifCopies,
} from '../db/gif_sources.ts';
import type { GatewayHub } from '../realtime/hub.ts';
import type { ServerLogService } from '../log/service.ts';
import type { SettingsService } from '../settings/service.ts';
import { createBlobStore } from '../storage/blobs.ts';

/** Abandoned uploads (chosen but never sent) are dropped after this long. */
const UNATTACHED_UPLOAD_HOURS = 24;
const BATCH_SIZE = 200;
const MAX_BATCHES = 400;

export interface Pruner {
  usage(): RetentionUsage;
  lastRun(): PruneSummary | null;
  runNow(): PruneSummary;
  /** Runs once at startup and then on the configured interval. */
  start(): void;
  stop(): void;
}

export interface PrunerDeps {
  sqlite: DatabaseSync;
  config: Config;
  settings: SettingsService;
  hub: GatewayHub;
  log: (message: string, detail?: unknown) => void;
  /**
   * Optional so the pruner can be driven standalone; when present, a run that
   * removed anything and a failed run are recorded for the owner.
   */
  serverLog?: ServerLogService;
}

export function createPruner(deps: PrunerDeps): Pruner {
  const blobs = createBlobStore(deps.config);
  let last: PruneSummary | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function isoDaysAgo(days: number): string {
    return new Date(Date.now() - days * 86_400_000).toISOString();
  }

  function isoHoursAgo(hours: number): string {
    return new Date(Date.now() - hours * 3_600_000).toISOString();
  }

  /**
   * Deletes on-disk blobs that no row references any more. Because storage is
   * content-addressed, a blob only goes once its last reference is gone.
   */
  function sweepUnreferencedBlobs(): { count: number; bytes: number } {
    const referenced = listReferencedHashes(deps.sqlite);
    let count = 0;
    let bytes = 0;

    for (const hash of blobs.listHashes()) {
      if (referenced.has(hash)) continue;
      bytes += blobs.delete(hash);
      count += 1;
      // A gif source that mirrored this blob must not keep pointing at a file that
      // is gone: cleared here, it is fetched again on demand instead of 404ing.
      clearGifSourcesForHash(deps.sqlite, hash);
    }
    return { count, bytes };
  }

  /**
   * Forgets the pairing of any gif source whose blob is no longer on disk because
   * it vanished some way other than the sweep (removed by hand, restored from a
   * backup without its files), so it is fetched again on demand.
   */
  function reconcileGifPairs(): void {
    for (const hash of listGifHashesPaired(deps.sqlite)) {
      if (!existsSync(blobs.pathFor(hash))) clearGifSourcesForHash(deps.sqlite, hash);
    }
  }

  /**
   * Releases stored copies of remote gifs, oldest first, until `needed` bytes are
   * freed or none are left that something else does not also keep. A copy made
   * for a gif source is re-fetchable from where it came from and no message
   * depends on it, so it is the first thing to give up when space runs out,
   * well before any attachment is evicted.
   */
  function releaseGifCopies(needed: number): { count: number; bytes: number } {
    const released = new Set<string>();
    let planned = 0;
    for (const row of listOldestGifCopies(deps.sqlite, 5000)) {
      if (planned >= needed) break;
      if (row.hash === null || released.has(row.hash)) continue;
      if (isGifBlobHeldElsewhere(deps.sqlite, row.hash)) continue;
      released.add(row.hash);
      planned += row.size ?? 0;
    }
    let bytes = 0;
    for (const hash of released) {
      clearGifSourcesForHash(deps.sqlite, hash);
      bytes += blobs.delete(hash);
    }
    return { count: released.size, bytes };
  }

  function usage(): RetentionUsage {
    return {
      blobBytes: blobs.totalBytes(),
      attachmentCount: countAttachments(deps.sqlite),
      messageCount: countMessages(deps.sqlite),
    };
  }

  function runNow(): PruneSummary {
    const settings = deps.settings.getRetention();
    let deletedAttachments = 0;
    let deletedMessages = 0;
    let deletedAuditEntries = 0;
    let deletedFavorites = 0;
    let deletedExternalEmojis = 0;
    let deletedStickers = 0;
    let deletedBlobs = 0;
    let freedBytes = 0;

    // Image, video and message retention all spare what somebody chose to keep:
    // pinned messages and saved messages, their attachments included. That
    // exemption lives in the db layer so every rule applies it the same way.
    if (settings.imageRetentionDays !== null) {
      deletedAttachments += deleteImageAttachmentsOlderThan(deps.sqlite, isoDaysAgo(settings.imageRetentionDays));
    }

    // Videos have their own schedule: they are far heavier, so an admin may well
    // want to keep images longer than clips.
    if (settings.videoRetentionDays !== null) {
      deletedAttachments += deleteVideoAttachmentsOlderThan(deps.sqlite, isoDaysAgo(settings.videoRetentionDays));
    }

    if (settings.messageRetentionDays !== null) {
      deletedMessages += deleteMessagesOlderThan(deps.sqlite, isoDaysAgo(settings.messageRetentionDays));
    }

    // The log ages on its own schedule, independent of the messages it describes.
    if (settings.auditRetentionDays !== null) {
      deletedAuditEntries += deleteAuditOlderThan(deps.sqlite, isoDaysAgo(settings.auditRetentionDays));
    }

    // Saved gifs are exempt from the image and message rules, so this is the only
    // thing that ever ages one out. It is deliberately checked before the sweep, so
    // the bytes of a gif nothing keeps any more go in the same pass.
    if (settings.favoriteRetentionDays !== null) {
      deletedFavorites += deleteGifFavoritesUnusedBefore(deps.sqlite, isoDaysAgo(settings.favoriteRetentionDays));
    }

    // Emoji learned from Discord age out once no bridged message has carried them
    // for a while; the instance's own emoji are never touched by this. Like the
    // favorites above, it runs before the sweep so their bytes are freed here too.
    if (settings.externalEmojiRetentionDays !== null) {
      const removedEmojiIds = deleteExternalEmojisUnusedBefore(
        deps.sqlite,
        isoDaysAgo(settings.externalEmojiRetentionDays),
      );
      deletedExternalEmojis += removedEmojiIds.length;

      // Clients keep their own emoji list and only refresh it on EMOJI_DELETE, so
      // without this a pruned emoji would keep rendering in messages until a
      // reload. Learned emoji are never offered in a picker to begin with.
      for (const id of removedEmojiIds) deps.hub.dispatch(GatewayEvent.EmojiDelete, { id });
    }

    // Stickers learned from Discord age out the same way, once no bridged message
    // has carried them for a while.
    if (settings.stickerRetentionDays !== null) {
      deletedStickers += deleteStickersUnusedBefore(deps.sqlite, isoDaysAgo(settings.stickerRetentionDays));
    }

    // Uploads that never turned into a message.
    deletedAttachments += deleteUnattachedAttachmentsOlderThan(deps.sqlite, isoHoursAgo(UNATTACHED_UPLOAD_HOURS));

    // Realize whatever the deletions above freed.
    let swept = sweepUnreferencedBlobs();
    deletedBlobs += swept.count;
    freedBytes += swept.bytes;
    reconcileGifPairs();

    // Emergency pruning: evict the oldest attachments until back under the target.
    // Attachments are the only thing it may remove, and it spares the ones held by
    // a pinned or saved message. The total also counts saved gifs, emoji, stickers,
    // avatars and the instance icon, none of which this touches, and messages hold
    // no bytes of their own: once their attachments are gone, deleting them frees
    // nothing and would only erase history.
    if (settings.storageLimitBytes !== null) {
      const target =
        settings.storageTargetBytes !== null
          ? Math.min(settings.storageTargetBytes, settings.storageLimitBytes)
          : settings.storageLimitBytes;

      let current = blobs.totalBytes();
      let batches = 0;

      if (current > target) {
        const released = releaseGifCopies(current - target);
        deletedBlobs += released.count;
        freedBytes += released.bytes;
        current -= released.bytes;
      }

      while (current > target && batches < MAX_BATCHES) {
        batches += 1;

        const removedAttachments = deleteOldestAttachments(deps.sqlite, BATCH_SIZE);
        deletedAttachments += removedAttachments;

        swept = sweepUnreferencedBlobs();
        deletedBlobs += swept.count;
        freedBytes += swept.bytes;
        current -= swept.bytes;

        // Either no attachments are left, or the ones just removed shared their
        // blobs with something that stays (a saved gif, say). Both mean the rest
        // of the total is held by content pruning may not remove, so stop rather
        // than keep evicting for nothing on every run.
        if (removedAttachments === 0 || swept.bytes === 0) {
          if (current > target) {
            deps.log('storage limit is out of reach of emergency pruning', {
              storedBytes: current,
              targetBytes: target,
            });
          }
          break;
        }
      }
    }

    const summary: PruneSummary = {
      ranAt: new Date().toISOString(),
      deletedAttachments,
      deletedMessages,
      deletedAuditEntries,
      deletedFavorites,
      deletedExternalEmojis,
      deletedStickers,
      deletedBlobs,
      freedBytes,
    };
    last = summary;

    if (
      deletedAttachments > 0 ||
      deletedMessages > 0 ||
      deletedAuditEntries > 0 ||
      deletedFavorites > 0 ||
      deletedExternalEmojis > 0 ||
      deletedStickers > 0 ||
      deletedBlobs > 0
    ) {
      deps.hub.dispatch(GatewayEvent.RetentionApplied, summary);
      deps.log('retention removed content', summary);
      const removed =
        deletedAttachments +
        deletedMessages +
        deletedAuditEntries +
        deletedFavorites +
        deletedExternalEmojis +
        deletedStickers +
        deletedBlobs;
      deps.serverLog?.info('retention_applied', `Retention removed ${removed} item${removed === 1 ? '' : 's'}`, {
        ...summary,
      });
    }

    // The server log ages on its own rule. It runs last, after the summary
    // above, so this run's own entry is not swept by it; pruning the log is not
    // itself news, so nothing is recorded for it.
    if (settings.serverLogRetentionDays !== null) {
      deps.serverLog?.pruneOlderThan(isoDaysAgo(settings.serverLogRetentionDays));
    }

    return summary;
  }

  return {
    usage,
    lastRun: () => last,
    runNow,

    start() {
      if (timer) return;

      try {
        runNow();
      } catch (error) {
        deps.log('initial retention run failed', error);
        deps.serverLog?.error('retention_run_failed', String(error));
      }

      timer = setInterval(
        () => {
          try {
            runNow();
          } catch (error) {
            deps.log('retention run failed', error);
            deps.serverLog?.error('retention_run_failed', String(error));
          }
        },
        Math.max(1, deps.config.pruneIntervalMinutes) * 60_000,
      );
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
