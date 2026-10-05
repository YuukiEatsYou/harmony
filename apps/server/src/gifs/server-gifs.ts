import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import {
  GatewayEvent,
  isGifContentType,
  type AddServerGifInput,
  type Attachment,
  type ServerGif,
  type ServerGifItem,
  type ServerGifManageResponse,
  type UpdateServerGifInput,
} from '@harmony/shared';
import { canAccessChannel, channelAccessFor } from '../access/service.ts';
import type { AttachmentService, StoredImage } from '../attachments/service.ts';
import type { AuditService } from '../audit/service.ts';
import type { AuthContext } from '../auth/service.ts';
import { findAttachment, insertAttachment, toAttachment, type AttachmentRow } from '../db/attachments.ts';
import { favoriteIdsByHash, findGifFavorite } from '../db/gif_favorites.ts';
import { findMessage } from '../db/messages.ts';
import {
  deleteServerGif,
  findServerGif,
  findServerGifByHash,
  listCuratedServerGifs,
  listHiddenServerGifs,
  listServerGifHashes,
  normalizeTags,
  reorderServerGifs,
  splitTags,
  toServerGif,
  updateServerGifFields,
  upsertServerGif,
  type ServerGifRow,
} from '../db/server_gifs.ts';
import { fetchPublicImage, type PublicImage } from '../embeds/media.ts';
import { HttpError } from '../http/errors.ts';
import type { GatewayHub } from '../realtime/hub.ts';
import type { GifService } from './service.ts';
import { isKlipyAddress } from './klipy.ts';

/**
 * Curation of the picker's Server tab. The tab is the administrators' list of
 * chosen gifs (pinned ones first) followed by the auto-collected gifs, which are
 * the recent gif attachments this member can see, minus any an administrator hid.
 *
 * Every curated gif is a stored copy, held by hash and exempt from retention (see
 * listReferencedHashes), so it survives the message it was found in and link rot.
 */
export interface ServerGifService {
  /** The Server tab: curated gifs (all matches), then up to `limit` auto-collected ones. */
  list(auth: AuthContext, query: { q?: string; limit: number }): ServerGifItem[];
  /** The admin view: curated, hidden, and the visible auto-collected gifs. */
  manage(auth: AuthContext): ServerGifManageResponse;
  /** Curates a gif from an attachment, a member's favorite, or a hosted address. */
  add(auth: AuthContext, input: AddServerGifInput): Promise<ServerGif>;
  update(auth: AuthContext, id: string, patch: UpdateServerGifInput): ServerGif;
  /** Puts the curated gifs in the given order. Unknown ids are ignored; listed ones come first. */
  reorder(auth: AuthContext, ids: string[]): void;
  /** Removes an auto-collected gif (named by the attachment it was found as) from the list. */
  hide(auth: AuthContext, attachmentId: string): ServerGif;
  /** Deletes a curated gif, or un-hides a hidden one. */
  remove(auth: AuthContext, id: string): void;
  find(id: string): ServerGifRow | null;
  /** Absolute path of a row's bytes, or null once they are gone. */
  filePathFor(row: { hash: string }): string | null;
  /** Takes a curated gif into the message being written, as a pending attachment. */
  pick(auth: AuthContext, id: string): Attachment;
}

export interface ServerGifServiceDeps {
  attachments: AttachmentService;
  gifs: GifService;
  audit: AuditService;
  hub: GatewayHub;
  /** Replaces the outbound fetch of a hosted gif; for tests, which cannot reach a gif host. */
  fetchImage?: (url: string, userAgent: string) => Promise<PublicImage | null>;
}

/** More than this and the admin list stops being something a person can manage. */
export const MAX_CURATED_GIFS = 500;
const AUTO_SCAN_CAP = 200;
const USER_AGENT = 'Harmony/1.0 server-gifs';

/** A name for a gif that was given none: its filename without the extension. */
function defaultName(filename: string): string {
  const stem = filename.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
  return (stem.length > 0 ? stem : filename).slice(0, 60);
}

function nameForUrl(url: string): string {
  const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  if (last.length === 0 || last.length > 100) return 'gif.gif';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export function createServerGifService(
  sqlite: DatabaseSync,
  deps: ServerGifServiceDeps,
): ServerGifService {
  function missing(): never {
    throw new HttpError(404, 'gif_not_found', 'That gif does not exist.');
  }

  function changed(): void {
    // Small on purpose: clients just refetch the list they are showing.
    deps.hub.dispatch(GatewayEvent.ServerGifsUpdate, {});
  }

  /** The attachment, if this member may see it (or it is their own pending upload). */
  function visibleAttachment(auth: AuthContext, attachmentId: string): AttachmentRow {
    const attachment = findAttachment(sqlite, attachmentId);
    if (!attachment) missing();
    if (attachment.message_id === null) {
      if (attachment.uploader_id !== auth.user.id) missing();
    } else {
      const message = findMessage(sqlite, attachment.message_id);
      if (!message) missing();
      if (!canAccessChannel(sqlite, channelAccessFor(sqlite, auth.user.id), message.channel_id)) missing();
    }
    if (!isGifContentType(attachment.content_type)) {
      throw new HttpError(400, 'not_a_gif', 'Only gifs can be used here.');
    }
    return attachment;
  }

  function requireBytes(hash: string): void {
    if (!existsSync(deps.attachments.filePathFor(hash))) {
      throw new HttpError(404, 'gif_missing', 'That gif is missing from storage.');
    }
  }

  async function storeFromUrl(url: string): Promise<StoredImage> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new HttpError(400, 'invalid_gif_url', 'That is not a usable gif address.');
    }
    // Only the hosted service's own addresses, as for favorites: the server never
    // fetches an arbitrary address on a member's say-so. The fetch itself still goes
    // through the SSRF-guarded path.
    if (!isKlipyAddress(target)) {
      throw new HttpError(400, 'invalid_gif_url', 'Only gifs from the configured service can be used.');
    }
    const media = await (deps.fetchImage ?? fetchPublicImage)(target.toString(), USER_AGENT);
    if (!media) throw new HttpError(415, 'invalid_gif', 'That gif could not be fetched.');
    if (!isGifContentType(media.contentType)) {
      throw new HttpError(415, 'unsupported_gif', 'That address is not a gif.');
    }
    const stored = await deps.attachments.storeImageBytes(media.contentType, media.data);
    if (!stored) throw new HttpError(413, 'gif_too_large', 'That gif is larger than this instance will store.');
    return stored;
  }

  function matches(row: ServerGifRow, query: string): boolean {
    const needle = query.toLowerCase();
    return (
      row.name.toLowerCase().includes(needle) ||
      row.filename.toLowerCase().includes(needle) ||
      splitTags(row.tags).some((tag) => tag.includes(needle))
    );
  }

  /** The auto-collected gifs the member can see, without the hidden or already-curated ones. */
  function autoGifs(auth: AuthContext, q: string | undefined, limit: number) {
    const taken = listServerGifHashes(sqlite);
    return deps.gifs
      .listLocal(auth, { q, limit: Math.min(limit + taken.size, AUTO_SCAN_CAP) })
      .filter((gif) => !taken.has(gif.hash))
      .slice(0, limit);
  }

  return {
    list(auth, query) {
      const q = query.q?.trim() ?? '';
      const saved = favoriteIdsByHash(sqlite, auth.user.id);
      const curated = listCuratedServerGifs(sqlite).filter((row) => q.length === 0 || matches(row, q));

      const items: ServerGifItem[] = curated.map((row) => ({
        id: row.id,
        source: 'curated',
        hash: row.hash,
        name: row.name || defaultName(row.filename),
        tags: splitTags(row.tags),
        filename: row.filename,
        contentType: row.content_type,
        width: row.width,
        height: row.height,
        pinned: row.pinned === 1,
        favoriteId: saved.get(row.hash) ?? null,
      }));

      for (const gif of autoGifs(auth, q.length > 0 ? q : undefined, query.limit)) {
        items.push({
          id: gif.id,
          source: 'auto',
          hash: gif.hash,
          name: defaultName(gif.filename),
          tags: [],
          filename: gif.filename,
          contentType: gif.contentType,
          width: gif.width,
          height: gif.height,
          pinned: false,
          favoriteId: gif.favoriteId,
        });
      }
      return items;
    },

    manage(auth) {
      return {
        curated: listCuratedServerGifs(sqlite).map(toServerGif),
        hidden: listHiddenServerGifs(sqlite).map(toServerGif),
        auto: autoGifs(auth, undefined, 100),
      };
    },

    async add(auth, input) {
      let source: StoredImage;
      let filename: string;

      if (input.attachmentId !== undefined) {
        const attachment = visibleAttachment(auth, input.attachmentId);
        requireBytes(attachment.hash);
        source = {
          hash: attachment.hash,
          contentType: attachment.content_type,
          size: attachment.size,
          width: attachment.width,
          height: attachment.height,
        };
        filename = attachment.filename;
      } else if (input.favoriteId !== undefined) {
        const favorite = findGifFavorite(sqlite, input.favoriteId);
        if (!favorite || favorite.user_id !== auth.user.id) missing();
        requireBytes(favorite.hash);
        source = {
          hash: favorite.hash,
          contentType: favorite.content_type,
          size: favorite.size,
          width: favorite.width,
          height: favorite.height,
        };
        filename = favorite.filename;
      } else if (input.url !== undefined) {
        // Fetched and stored on the way in: the curated copy is ours from here on.
        source = await storeFromUrl(input.url);
        filename = nameForUrl(input.url);
      } else {
        throw new HttpError(400, 'gif_reference_required', 'Name the gif to add.');
      }

      const existing = findServerGifByHash(sqlite, source.hash);
      if (existing?.kind === 'curated') {
        throw new HttpError(409, 'server_gif_exists', 'That gif is already on the server list.');
      }
      if (!existing && listCuratedServerGifs(sqlite).length >= MAX_CURATED_GIFS) {
        throw new HttpError(409, 'server_gif_limit', `The server list holds at most ${MAX_CURATED_GIFS} gifs.`);
      }

      const name = input.name && input.name.length > 0 ? input.name : defaultName(filename);
      const row = upsertServerGif(sqlite, {
        kind: 'curated',
        hash: source.hash,
        filename,
        contentType: source.contentType,
        size: source.size,
        width: source.width,
        height: source.height,
        name,
        tags: input.tags ?? [],
        pinned: input.pinned ?? false,
        addedBy: auth.user.id,
      });
      deps.audit.serverGif('server_gif_add', auth.user.id, filename, name);
      changed();
      return toServerGif(row);
    },

    update(auth, id, patch) {
      const row = findServerGif(sqlite, id);
      if (!row || row.kind !== 'curated') missing();
      const updated = updateServerGifFields(sqlite, id, {
        ...patch,
        tags: patch.tags ? normalizeTags(patch.tags) : undefined,
      });
      if (!updated) missing();
      changed();
      return toServerGif(updated);
    },

    reorder(_auth, ids) {
      const curated = new Set(listCuratedServerGifs(sqlite).map((row) => row.id));
      const listed = [...new Set(ids)].filter((id) => curated.has(id));
      // Anything the caller did not list keeps its relative order after the listed ones,
      // so a stale client cannot scramble gifs it never saw.
      const rest = listCuratedServerGifs(sqlite)
        .map((row) => row.id)
        .filter((id) => !listed.includes(id));
      reorderServerGifs(sqlite, [...listed, ...rest]);
      changed();
    },

    hide(auth, attachmentId) {
      const attachment = visibleAttachment(auth, attachmentId);
      const existing = findServerGifByHash(sqlite, attachment.hash);
      if (existing?.kind === 'curated') {
        throw new HttpError(409, 'server_gif_curated', 'That gif is on the server list; remove it there instead.');
      }
      if (existing) return toServerGif(existing);

      const row = upsertServerGif(sqlite, {
        kind: 'hidden',
        hash: attachment.hash,
        filename: attachment.filename,
        contentType: attachment.content_type,
        size: attachment.size,
        width: attachment.width,
        height: attachment.height,
        name: '',
        tags: [],
        pinned: false,
        addedBy: auth.user.id,
      });
      deps.audit.serverGif('server_gif_hide', auth.user.id, attachment.filename);
      changed();
      return toServerGif(row);
    },

    remove(auth, id) {
      const row = findServerGif(sqlite, id);
      if (!row) missing();
      deleteServerGif(sqlite, id);
      if (row.kind === 'curated') {
        deps.audit.serverGif('server_gif_remove', auth.user.id, row.filename, row.name);
      } else {
        deps.audit.serverGif('server_gif_unhide', auth.user.id, row.filename);
      }
      changed();
    },

    find(id) {
      return findServerGif(sqlite, id);
    },

    filePathFor(row) {
      const path = deps.attachments.filePathFor(row.hash);
      return existsSync(path) ? path : null;
    },

    pick(auth, id) {
      const row = findServerGif(sqlite, id);
      if (!row || row.kind !== 'curated') missing();
      requireBytes(row.hash);

      const draftId = randomUUID();
      insertAttachment(sqlite, {
        id: draftId,
        uploaderId: auth.user.id,
        filename: row.filename,
        contentType: row.content_type,
        size: row.size,
        width: row.width,
        height: row.height,
        hash: row.hash,
        createdAt: new Date().toISOString(),
      });
      const attachment = findAttachment(sqlite, draftId);
      if (!attachment) throw new HttpError(500, 'internal_error', 'Failed to send that gif.');
      return toAttachment(attachment);
    },
  };
}
