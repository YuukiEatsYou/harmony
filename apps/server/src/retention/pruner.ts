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
import type { GatewayHub } from '../realtime/hub.ts';
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
    }
    return { count, bytes };
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
      // without this a pruned emoji would linger in their picker until a reload.
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

    // Emergency pruning: evict the oldest attachments until back under the target.
    // Attachments are the only thing it may remove. The total also counts saved
    // gifs, emoji, stickers, avatars and the instance icon, none of which this
    // touches, and messages hold no bytes of their own: once their attachments
    // are gone, deleting them frees nothing and would only erase history.
    if (settings.storageLimitBytes !== null) {
      const target =
        settings.storageTargetBytes !== null
          ? Math.min(settings.storageTargetBytes, settings.storageLimitBytes)
          : settings.storageLimitBytes;

      let current = blobs.totalBytes();
      let batches = 0;

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
      }

      timer = setInterval(
        () => {
          try {
            runNow();
          } catch (error) {
            deps.log('retention run failed', error);
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
