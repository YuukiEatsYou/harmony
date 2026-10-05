/** Product-wide constants shared by the server, web client and bridge bot. */

export const HARMONY_NAME = 'Harmony';

/**
 * The release shown in the About panel. Patch for fixes and minor for features;
 * the major number is the owner's to raise. Kept here rather than in a
 * package.json so the client, the server and the bridge all read one value.
 */
export const HARMONY_VERSION = '1.26.0';

/** Where the project lives, linked from the About panel. */
export const HARMONY_REPO_URL = 'https://github.com/YuukiEatsYou/harmony';

/**
 * FORKS: change this one line to run the update check against your own releases
 * instead of Harmony's. It should be the raw URL of a copy of this file on your
 * update branch; the server reads HARMONY_VERSION out of it. An empty string
 * switches update checks off. A normal instance never needs to touch it, which is
 * why it is a constant here rather than an environment variable.
 */
export const HARMONY_VERSION_SOURCE_URL =
  'https://raw.githubusercontent.com/YuukiEatsYou/harmony/main/packages/shared/src/constants.ts';

/** Version prefix for all REST routes, e.g. `/api/v1`. */
export const API_VERSION = 'v1';

/** Bumped whenever the gateway event protocol changes incompatibly. */
export const GATEWAY_VERSION = 1;

/** Default heartbeat cadence for the gateway, in milliseconds. */
export const GATEWAY_HEARTBEAT_MS = 45_000;

/** Limits enforced by the API and mirrored by the UI. */
export const LIMITS = {
  username: { min: 2, max: 32 },
  password: { min: 8, max: 200 },
  channelName: { min: 1, max: 64 },
  displayName: { max: 32 },
  messageLength: 4_000,
  attachmentsPerMessage: 10,
  /** Discord's own cap, kept so a bridged channel's pins can always fit on both sides. */
  pinsPerChannel: 50,
} as const;

/** Image formats accepted by the attachment upload endpoint. */
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageContentType = (typeof ALLOWED_IMAGE_TYPES)[number];

/** Video formats accepted by the attachment upload endpoint. */
export const ALLOWED_VIDEO_TYPES = ['video/mp4'] as const;
export type VideoContentType = (typeof ALLOWED_VIDEO_TYPES)[number];

/** Everything the attachment upload endpoint accepts. */
export const ALLOWED_ATTACHMENT_TYPES = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES] as const;

/**
 * What the gif picker works with. It is deliberately gif-only: a screenshot or a
 * photo is not something anybody browses a picker for, so the searchable library,
 * the hearts and what can be saved are all limited to these.
 */
export const GIF_CONTENT_TYPES = ['image/gif'] as const;

/** Whether an attachment is a gif, and so belongs in the picker. */
export function isGifContentType(contentType: string): boolean {
  return (GIF_CONTENT_TYPES as readonly string[]).includes(contentType);
}

/** Default maximum size of an image upload, in bytes (10 MiB). */
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Default maximum size of a video upload, in bytes (20 MiB). */
export const DEFAULT_MAX_VIDEO_BYTES = 20 * 1024 * 1024;

/**
 * Share of an installed app icon's tile left clear around the artwork, as a
 * percentage, when the instance works it out from the image.
 */
export const DEFAULT_ICON_PADDING = 10;

/** Past this the artwork is too small to read, whatever it is. */
export const MAX_ICON_PADDING = 45;

/**
 * The largest single upload the multipart layer will buffer. An admin cannot
 * configure a per-type limit above this.
 */
export const MAX_UPLOAD_CEILING_BYTES = 100 * 1024 * 1024;

/** Maximum size of a custom emoji image, in bytes (256 KiB). */
export const DEFAULT_MAX_EMOJI_BYTES = 256 * 1024;

/** Maximum size of an uploaded profile picture, in bytes (2 MiB). */
export const DEFAULT_MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** Profile pictures are normalized to this square size. */
export const AVATAR_SIZE = 256;

/** Maximum size of an uploaded server icon, in bytes (2 MiB). */
export const DEFAULT_MAX_ICON_BYTES = 2 * 1024 * 1024;

/** Server icons are normalized to this square size. */
export const ICON_SIZE = 256;

/** Profile banners are normalized to this wide size. */
export const BANNER_WIDTH = 600;
export const BANNER_HEIGHT = 240;

/** Maximum size of an uploaded profile banner, in bytes (4 MiB). */
export const DEFAULT_MAX_BANNER_BYTES = 4 * 1024 * 1024;
