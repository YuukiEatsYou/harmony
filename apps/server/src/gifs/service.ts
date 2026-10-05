import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import {
  isGifContentType,
  isGifLinkHost,
  type Attachment,
  type GifFavorite,
  type GifLinkResponse,
  type GifItem,
  type GifSearchResult,
} from '@harmony/shared';
import { canAccessChannel, channelAccessFor, visibleChannels } from '../access/service.ts';
import type { AttachmentService, StoredImage } from '../attachments/service.ts';
import type { AuthContext } from '../auth/service.ts';
import type { Config } from '../config.ts';
import {
  findAttachment,
  insertAttachment,
  listRecentGifAttachments,
  toAttachment,
  type AttachmentRow,
} from '../db/attachments.ts';
import {
  deleteGifFavorite,
  favoriteIdsByHash,
  findGifFavorite,
  listGifFavoritesForUser,
  touchGifFavorite,
  toGifFavorite,
  upsertGifFavorite,
} from '../db/gif_favorites.ts';
import { findMessage } from '../db/messages.ts';
import { verifyLinkedGif, type VerifyLinkedGif } from '../embeds/linked-gif.ts';
import { fetchPublicImage } from '../embeds/media.ts';
import { HttpError } from '../http/errors.ts';
import type { SettingsService } from '../settings/service.ts';
import { createBlobStore, type BlobStore } from '../storage/blobs.ts';
import { isKlipyAddress, klipySearchUrl, normalizeKlipySearch } from './klipy.ts';
import type { GifSourceService } from './sources.ts';

export interface GifService {
  /** The gifs this member has kept, most recently used first. */
  listFavorites(auth: AuthContext): GifFavorite[];
  /**
   * Keeps a gif: one this instance already holds, by attachment, or one from the
   * hosted service, by address, which is fetched and stored on the way in.
   */
  addFavorite(auth: AuthContext, ref: { attachmentId?: string; url?: string }): Promise<GifFavorite>;
  removeFavorite(auth: AuthContext, favoriteId: string): void;
  /**
   * Takes a gif into the message being written: it becomes an unattached
   * attachment owned by the caller, which the message then claims exactly as it
   * would an upload. A gif already stored costs a row; a hosted one is fetched.
   */
  pick(auth: AuthContext, ref: { attachmentId?: string; favoriteId?: string; url?: string }): Promise<Attachment>;
  /**
   * Checks a gif address from the hosted service for linking (gif storage mode
   * "link"): it must be https on an allowlisted gif host and actually serve a gif
   * of a sensible size. Nothing is stored; the checked address is handed back for
   * the member to send as the message text. Refused while the mode is "store".
   */
  link(auth: AuthContext, url: string): Promise<GifLinkResponse>;
  /** Absolute path of a kept gif's bytes, or null when they are gone. */
  filePathFor(favorite: { hash: string }): string | null;
  /**
   * Gifs this instance already holds, for the picker's local tab: one per picture,
   * newest first, and only from channels the member may see.
   */
  listLocal(auth: AuthContext, query: { q?: string; limit: number }): GifItem[];
  /** Gifs from the configured hosted service, or an empty list when there is none. */
  searchKlipy(query: { q?: string; limit: number }): Promise<GifSearchResult[]>;
}

export interface GifServiceDeps {
  attachments: AttachmentService;
  settings: SettingsService;
  /** Replaces the check made before a gif is linked; for tests, which cannot reach a gif host. */
  verifyLinkedGif?: VerifyLinkedGif;
  /** Pairs each gif address with the copy held of it, so one address is fetched at most once. */
  sources: GifSourceService;
  /** Replaces the guarded download of a hosted gif; for tests, which cannot reach one. */
  fetchImage?: (url: string, userAgent: string) => Promise<{ data: Buffer; contentType: string } | null>;
}

/** How many candidate rows to look at to fill a page once duplicates are dropped. */
const LOCAL_SCAN_FACTOR = 4;
const LOCAL_SCAN_LIMIT = 400;
const KLIPY_TIMEOUT_MS = 6000;
/** Klipy serves its media to any client, but naming ourselves is only polite. */
const KLIPY_USER_AGENT = 'Harmony/1.0 gif-picker';

/** A name for a fetched gif: the last piece of its address, which a service supplies. */
function nameForUrl(url: string): string {
  const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  if (last.length === 0 || last.length > 100) return 'gif.gif';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export function createGifService(sqlite: DatabaseSync, config: Config, deps: GifServiceDeps): GifService {
  const blobs: BlobStore = createBlobStore(config);

  function missing(): never {
    // A gif in a channel this member cannot see is reported as absent, so a locked
    // channel leaks nothing by way of its gifs either.
    throw new HttpError(404, 'gif_not_found', 'That gif does not exist.');
  }

  /** Whether the member may see the attachment this gif came from, or own it. */
  function assertMayUseAttachment(auth: AuthContext, attachment: AttachmentRow): void {
    if (attachment.message_id === null) {
      if (attachment.uploader_id !== auth.user.id) missing();
      return;
    }
    const message = findMessage(sqlite, attachment.message_id);
    if (!message) missing();
    if (!canAccessChannel(sqlite, channelAccessFor(sqlite, auth.user.id), message.channel_id)) missing();
  }

  function requireStoredBytes(hash: string): void {
    if (!existsSync(blobs.pathFor(hash))) {
      throw new HttpError(404, 'gif_missing', 'That gif is missing from storage.');
    }
  }

  /** One already-stored gif, in the shape everything below works with. */
  function storedFromAttachment(attachment: AttachmentRow): StoredImage {
    return {
      hash: attachment.hash,
      contentType: attachment.content_type,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
    };
  }

  /**
   * Fetches a hosted gif and keeps it, so that what a member saves or sends is
   * ours from then on and cannot expire or disappear under us. Only Klipy's own
   * addresses are accepted, since those are the only ones the picker is ever given.
   */
  async function storeFromUrl(url: string): Promise<StoredImage> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new HttpError(400, 'invalid_gif_url', 'That is not a usable gif address.');
    }
    if (!isKlipyAddress(target)) {
      throw new HttpError(400, 'invalid_gif_url', 'Only gifs from the configured service can be used.');
    }

    // An address this instance has already copied (while linking, or for another
    // member) costs nothing: the pairing hands back the stored bytes.
    const held = deps.sources.copyFor(target.toString());
    if (held && isGifContentType(held.content_type ?? '')) {
      return {
        hash: held.hash,
        contentType: held.content_type ?? 'image/gif',
        size: held.size ?? 0,
        width: held.width,
        height: held.height,
      };
    }

    const media = await (deps.fetchImage ?? fetchPublicImage)(target.toString(), KLIPY_USER_AGENT);
    if (!media) throw new HttpError(415, 'invalid_gif', 'That gif could not be fetched.');

    // The picker is gif-only, so a response that turns out to be something else is
    // refused here rather than saved as a gif the picker would never show again.
    if (!isGifContentType(media.contentType)) {
      throw new HttpError(415, 'unsupported_gif', 'That address is not a gif.');
    }

    const stored = await deps.attachments.storeImageBytes(media.contentType, media.data);
    if (!stored) {
      throw new HttpError(413, 'gif_too_large', 'That gif is larger than this instance will store.');
    }
    deps.sources.recordCopy(target.toString(), stored);
    return stored;
  }

  /** Writes the unattached attachment a picked gif travels to its message as. */
  function draftFrom(source: StoredImage, auth: AuthContext, filename: string): Attachment {
    const id = randomUUID();
    insertAttachment(sqlite, {
      id,
      uploaderId: auth.user.id,
      filename,
      contentType: source.contentType,
      size: source.size,
      width: source.width,
      height: source.height,
      hash: source.hash,
      createdAt: new Date().toISOString(),
    });

    const row = findAttachment(sqlite, id);
    if (!row) throw new HttpError(500, 'internal_error', 'Failed to send that gif.');
    return toAttachment(row);
  }

  return {
    listFavorites(auth) {
      return listGifFavoritesForUser(sqlite, auth.user.id).map(toGifFavorite);
    },

    async addFavorite(auth, ref) {
      let source: StoredImage;
      let filename: string;
      let sourceUrl: string | null;

      if (ref.attachmentId !== undefined) {
        const attachment = findAttachment(sqlite, ref.attachmentId);
        if (!attachment) missing();
        assertMayUseAttachment(auth, attachment);
        if (!isGifContentType(attachment.content_type)) {
          throw new HttpError(400, 'not_a_gif', 'Only gifs can be saved.');
        }
        requireStoredBytes(attachment.hash);
        source = storedFromAttachment(attachment);
        filename = attachment.filename;
        // Kept only as a note of where it came from; the bytes are what matter.
        sourceUrl = attachment.source_url;
        if (sourceUrl !== null) deps.sources.recordCopy(sourceUrl, source);
      } else if (ref.url !== undefined) {
        source = await storeFromUrl(ref.url);
        filename = nameForUrl(ref.url);
        sourceUrl = ref.url;
      } else {
        throw new HttpError(400, 'gif_reference_required', 'Name the gif to save.');
      }

      return toGifFavorite(
        upsertGifFavorite(sqlite, {
          userId: auth.user.id,
          hash: source.hash,
          filename,
          contentType: source.contentType,
          size: source.size,
          width: source.width,
          height: source.height,
          sourceUrl,
        }),
      );
    },

    removeFavorite(auth, favoriteId) {
      const favorite = findGifFavorite(sqlite, favoriteId);
      if (!favorite || favorite.user_id !== auth.user.id) missing();
      deleteGifFavorite(sqlite, favorite.id);
    },

    async pick(auth, ref) {
      // A hosted gif arrives as bytes, and everything else is already stored.
      if (ref.url !== undefined) {
        return draftFrom(await storeFromUrl(ref.url), auth, nameForUrl(ref.url));
      }

      let source: StoredImage;
      let filename: string;

      if (ref.favoriteId !== undefined) {
        const favorite = findGifFavorite(sqlite, ref.favoriteId);
        if (!favorite || favorite.user_id !== auth.user.id) missing();
        requireStoredBytes(favorite.hash);
        // Picking a kept gif counts as using it, which its retention counts from.
        touchGifFavorite(sqlite, auth.user.id, favorite.hash);
        source = {
          hash: favorite.hash,
          contentType: favorite.content_type,
          size: favorite.size,
          width: favorite.width,
          height: favorite.height,
        };
        filename = favorite.filename;
      } else if (ref.attachmentId !== undefined) {
        const attachment = findAttachment(sqlite, ref.attachmentId);
        if (!attachment) missing();
        assertMayUseAttachment(auth, attachment);
        if (!isGifContentType(attachment.content_type)) {
          throw new HttpError(400, 'not_a_gif', 'Only gifs can be sent from the picker.');
        }
        requireStoredBytes(attachment.hash);
        source = storedFromAttachment(attachment);
        filename = attachment.filename;
      } else {
        throw new HttpError(400, 'gif_reference_required', 'Name the gif to send.');
      }

      // The bytes are already stored, so this is a row and nothing more. The source
      // link is deliberately left off: a picked gif belongs to its message the way
      // an upload does, and is not undone when the text around it changes.
      return draftFrom(source, auth, filename);
    },

    async link(_auth, url) {
      const settings = deps.settings.get();
      if (settings.gifStorage !== 'link') {
        throw new HttpError(409, 'gif_link_disabled', 'This server keeps its own copy of every gif.');
      }
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        throw new HttpError(400, 'invalid_gif_url', 'That is not a usable gif address.');
      }
      if (!isGifLinkHost(target)) {
        throw new HttpError(400, 'invalid_gif_url', 'Only gifs from known gif services can be linked.');
      }

      const gif = await (deps.verifyLinkedGif ?? verifyLinkedGif)(target.toString(), {
        maxImageBytes: settings.maxImageBytes,
        maxVideoBytes: settings.maxVideoBytes,
        userAgent: KLIPY_USER_AGENT,
      });
      if (!gif) throw new HttpError(415, 'invalid_gif', 'That gif could not be checked.');
      // Only the pairing is recorded; the bytes are copied later, on demand.
      deps.sources.record(target.toString(), gif.contentType);
      return { url: target.toString(), contentType: gif.contentType };
    },

    filePathFor(favorite) {
      const path = blobs.pathFor(favorite.hash);
      return existsSync(path) ? path : null;
    },

    listLocal(auth, query) {
      const access = channelAccessFor(sqlite, auth.user.id);
      // Administrators see everything; everybody else only their own channels, so a
      // gif in a locked channel never turns up in somebody's picker.
      const channelIds = access.bypass ? null : visibleChannels(sqlite, access).map((channel) => channel.id);

      const rows = listRecentGifAttachments(sqlite, {
        channelIds,
        q: query.q && query.q.length > 0 ? query.q : null,
        // The same picture is sent over and over, so a page's worth of rows holds
        // far fewer distinct gifs; read ahead before dropping the duplicates.
        limit: Math.min(query.limit * LOCAL_SCAN_FACTOR, LOCAL_SCAN_LIMIT),
      });

      const saved = favoriteIdsByHash(sqlite, auth.user.id);
      const seen = new Set<string>();
      const gifs: GifItem[] = [];

      for (const row of rows) {
        if (seen.has(row.hash)) continue;
        seen.add(row.hash);
        gifs.push({
          id: row.id,
          hash: row.hash,
          filename: row.filename,
          contentType: row.content_type,
          size: row.size,
          width: row.width,
          height: row.height,
          sourceUrl: row.source_url,
          createdAt: row.created_at,
          favoriteId: saved.get(row.hash) ?? null,
        });
        if (gifs.length >= query.limit) break;
      }
      return gifs;
    },

    async searchKlipy(query) {
      const key = deps.settings.getKlipyKey();
      if (!key) return [];

      const response = await fetch(klipySearchUrl(key, query), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(KLIPY_TIMEOUT_MS),
      }).catch(() => null);
      if (!response?.ok) {
        throw new HttpError(502, 'gif_service_unavailable', 'The gif service could not be reached.');
      }

      return normalizeKlipySearch(await response.json().catch(() => null));
    },
  };
}
