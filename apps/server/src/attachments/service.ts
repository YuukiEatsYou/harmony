import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import type { Metadata } from 'sharp';
import {
  ALLOWED_IMAGE_TYPES,
  ALLOWED_VIDEO_TYPES,
  type Attachment,
  type ImageContentType,
  type VideoContentType,
} from '@harmony/shared';
import type { Config } from '../config.ts';
import type { AuthContext } from '../auth/service.ts';
import { assertNotTimedOut } from '../auth/guards.ts';
import {
  attachToMessage,
  findAttachment,
  findAttachmentBySourceUrl,
  insertAttachment,
  toAttachment,
  type AttachmentRow,
} from '../db/attachments.ts';
import { HttpError } from '../http/errors.ts';
import type { SettingsService } from '../settings/service.ts';
import { createBlobStore } from '../storage/blobs.ts';

export interface UploadInput {
  filename: string;
  contentType: string;
  data: Buffer;
}

/** An image the server fetched from a link in a message's own text. */
export interface LinkedImageInput {
  messageId: string;
  uploaderId: string | null;
  sourceUrl: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

/** Image bytes that passed every check and are now in the blob store. */
export interface StoredImage {
  hash: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
}

export interface AttachmentService {
  upload(auth: AuthContext, file: UploadInput): Promise<Attachment>;
  /**
   * Stores an image that a message linked to, as an attachment of that message.
   *
   * Anything the server has to fetch on a message's behalf has to be kept: the
   * address it came from is somebody else's, may be signed and expire, and may
   * simply stop existing. A copy of our own keeps working. Returns null when the
   * bytes are not a usable image, or are too large for this instance.
   */
  storeLinkedImage(input: LinkedImageInput): Promise<Attachment | null>;
  /**
   * Validates image bytes and puts them in the blob store, returning what is
   * needed to refer to them. Nothing is recorded: what the bytes are for is the
   * caller's to decide, whether that is a message, a saved gif or both.
   */
  storeImageBytes(contentType: string, data: Buffer): Promise<StoredImage | null>;
  /**
   * A picture already copied from this link and still on disk, so it does not have
   * to be fetched a second time. The same gif comes round again far more often
   * than a community finds a new one, and refetching it costs bandwidth and a
   * visible wait for a file this instance is already holding.
   */
  reusableForUrl(url: string): AttachmentRow | null;
  /** Gives another message a picture this instance already holds. No download. */
  copyLinkedImage(input: {
    messageId: string;
    uploaderId: string | null;
    sourceUrl: string;
    from: AttachmentRow;
  }): Attachment;
  /**
   * Gives a message a picture whose bytes this instance already holds under a
   * source address (a gif copied earlier, perhaps while the instance linked
   * instead of storing). No download.
   */
  attachStoredCopy(input: {
    messageId: string;
    uploaderId: string | null;
    sourceUrl: string;
    filename: string;
    stored: StoredImage;
  }): Attachment;
  find(id: string): AttachmentRow | null;
  /** Absolute path of the on-disk blob for a content hash. */
  filePathFor(hash: string): string;
}

/**
 * An MP4 starts with a size word followed by the `ftyp` box. Videos are not
 * decoded, so this is the cheap sanity check that keeps arbitrary bytes from
 * being stored under a video content type.
 */
function looksLikeMp4(data: Buffer): boolean {
  return data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp';
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

export function createAttachmentService(
  sqlite: DatabaseSync,
  config: Config,
  settings: SettingsService,
): AttachmentService {
  const blobs = createBlobStore(config);

  /** Inserts one attachment row and hands back its id. */
  function addRow(input: {
    uploaderId: string | null;
    filename: string;
    contentType: string;
    size: number;
    width: number | null;
    height: number | null;
    hash: string;
    sourceUrl: string | null;
  }): string {
    const id = randomUUID();
    insertAttachment(sqlite, { id, ...input, createdAt: new Date().toISOString() });
    return id;
  }

  /**
   * The one place bytes become a blob: the type has to be one this instance
   * keeps, the size has to be within what an upload of it would be allowed, and
   * sharp has the last word on whether it is really an image. The dimensions it
   * reports are kept with the attachment, so a picture renders without a jump.
   */
  async function storeImageBytes(contentType: string, data: Buffer): Promise<StoredImage | null> {
    if (!ALLOWED_IMAGE_TYPES.includes(contentType as ImageContentType)) return null;
    if (data.length > settings.get().maxImageBytes) return null;

    let metadata: Metadata;
    try {
      metadata = await sharp(data).metadata();
    } catch {
      return null; // Not a real image, whatever the content type claimed.
    }

    return {
      // Content-addressed, so the same gif posted twice costs the disk once.
      hash: blobs.save(data),
      contentType,
      size: data.length,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
    };
  }

  return {
    filePathFor: blobs.pathFor,
    storeImageBytes,

    find(id) {
      return findAttachment(sqlite, id);
    },

    async storeLinkedImage(input) {
      const stored = await storeImageBytes(input.contentType, input.data);
      if (!stored) return null;

      const id = addRow({
        uploaderId: input.uploaderId,
        filename: input.filename,
        contentType: stored.contentType,
        size: stored.size,
        width: stored.width,
        height: stored.height,
        hash: stored.hash,
        sourceUrl: input.sourceUrl,
      });
      attachToMessage(sqlite, id, input.messageId);

      const row = findAttachment(sqlite, id);
      return row ? toAttachment(row) : null;
    },

    reusableForUrl(url) {
      const row = findAttachmentBySourceUrl(sqlite, url);
      // A row can only outlive its file if somebody pruned the blob by hand.
      // Pointing a message at nothing would be worse than fetching again.
      if (!row || !existsSync(blobs.pathFor(row.hash))) return null;
      return row;
    },

    copyLinkedImage(input) {
      // The dimensions and the name are the originals', since the bytes are.
      const id = addRow({
        uploaderId: input.uploaderId,
        filename: input.from.filename,
        contentType: input.from.content_type,
        size: input.from.size,
        width: input.from.width,
        height: input.from.height,
        hash: input.from.hash,
        sourceUrl: input.sourceUrl,
      });
      attachToMessage(sqlite, id, input.messageId);

      const row = findAttachment(sqlite, id);
      if (!row) throw new Error('Failed to give a message a picture already stored');
      return toAttachment(row);
    },

    attachStoredCopy(input) {
      const id = addRow({
        uploaderId: input.uploaderId,
        filename: input.filename,
        contentType: input.stored.contentType,
        size: input.stored.size,
        width: input.stored.width,
        height: input.stored.height,
        hash: input.stored.hash,
        sourceUrl: input.sourceUrl,
      });
      attachToMessage(sqlite, id, input.messageId);

      const row = findAttachment(sqlite, id);
      if (!row) throw new Error('Failed to give a message a picture already stored');
      return toAttachment(row);
    },

    async upload(auth, file) {
      assertNotTimedOut(auth);

      const isImage = ALLOWED_IMAGE_TYPES.includes(file.contentType as ImageContentType);
      const isVideo = ALLOWED_VIDEO_TYPES.includes(file.contentType as VideoContentType);
      if (!isImage && !isVideo) {
        throw new HttpError(
          415,
          'unsupported_media_type',
          `Unsupported file type "${file.contentType}". Allowed: ${[...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES].join(', ')}.`,
        );
      }

      const limits = settings.get();
      const limit = isVideo ? limits.maxVideoBytes : limits.maxImageBytes;
      if (file.data.length > limit) {
        throw new HttpError(
          413,
          'payload_too_large',
          `${isVideo ? 'Videos' : 'Images'} must be at most ${megabytes(limit)} MB.`,
        );
      }

      // Images are re-validated by sharp, which also gives us their dimensions so
      // they render without a layout shift. Videos carry no dimensions.
      let width: number | null = null;
      let height: number | null = null;
      if (isImage) {
        let metadata: Metadata;
        try {
          metadata = await sharp(file.data).metadata();
        } catch {
          throw new HttpError(415, 'invalid_image', 'That file is not a readable image.');
        }
        width = metadata.width ?? null;
        height = metadata.height ?? null;
      } else if (!looksLikeMp4(file.data)) {
        throw new HttpError(415, 'invalid_video', 'That file is not a readable MP4 video.');
      }

      const hash = blobs.save(file.data);

      const id = randomUUID();
      insertAttachment(sqlite, {
        id,
        uploaderId: auth.user.id,
        filename: file.filename,
        contentType: file.contentType,
        size: file.data.length,
        width,
        height,
        hash,
        createdAt: new Date().toISOString(),
      });

      const row = findAttachment(sqlite, id);
      if (!row) throw new HttpError(500, 'internal_error', 'Failed to store the upload.');
      return toAttachment(row);
    },
  };
}
