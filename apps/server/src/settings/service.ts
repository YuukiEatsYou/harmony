import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_MAX_VOICE_MEMBERS,
  DEFAULT_SCREEN_SHARE_FRAME_RATE,
  DEFAULT_SCREEN_SHARE_HEIGHT,
  DEFAULT_UPDATE_BACKUP_RETENTION,
  HEX_COLOR_PATTERN,
  MAX_ICON_PADDING,
  MAX_UPDATE_BACKUP_RETENTION,
  MAX_UPLOAD_CEILING_BYTES,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_VIDEO_BYTES,
  type GifStorageMode,
  type IconSettings,
  type RetentionSettings,
  type ThemeSettings,
} from '@harmony/shared';
import { readAllSettings, writeSetting } from '../db/settings.ts';

export interface ServerSettings {
  serverName: string;
  requireInvite: boolean;
  /** Channel opened by default on load, or null to fall back to the first one. */
  defaultChannelId: string | null;
  /** Whether the server unfurls link previews by fetching the linked pages. */
  embedsEnabled: boolean;
  /** Instance colors; the rest of the palette is derived from these two. */
  theme: ThemeSettings;
  /** How the installed app icon is drawn; see `IconSettings`. */
  icon: IconSettings;
  /** Largest accepted image upload, in bytes. */
  maxImageBytes: number;
  /** Largest accepted video upload, in bytes. */
  maxVideoBytes: number;
  /** User agent for unfurling links, or null to identify as Harmony. */
  previewUserAgent: string | null;
  /** True once the owner has been through the first-run setup wizard. */
  setupCompleted: boolean;
  /**
   * Whether a hosted gif service is configured, which is what the picker's third
   * tab hangs on. The key itself never leaves the server.
   */
  klipyConfigured: boolean;
  /**
   * Whether a gif is stored on this server ("store", the default) or, when it
   * comes from an allowlisted gif host, linked to there ("link"). See
   * `gif-hosts.ts` in the shared package.
   */
  gifStorage: GifStorageMode;
  /** Members one voice channel holds; 0 means unlimited. */
  maxVoiceMembers: number;
  /** The tallest a shared screen is captured, in pixels. */
  screenShareHeight: number;
  /** How many frames a second a shared screen is captured at. */
  screenShareFrameRate: number;
  /** STUN URLs handed to clients by `GET /voice/ice`; empty when none are set. */
  stunUrls: string[];
  /** TURN URLs handed to clients by `GET /voice/ice`; empty when none are set. */
  turnUrls: string[];
  /** Whether a TURN shared secret is set. The secret itself is write-only. */
  turnConfigured: boolean;
}

/** A settings patch. `theme` is partial so one color can be changed on its own. */
export interface ServerSettingsUpdate {
  serverName?: string;
  requireInvite?: boolean;
  defaultChannelId?: string | null;
  embedsEnabled?: boolean;
  theme?: Partial<ThemeSettings>;
  icon?: Partial<IconSettings>;
  maxImageBytes?: number;
  maxVideoBytes?: number;
  previewUserAgent?: string | null;
  setupCompleted?: boolean;
  /** Cleared by an empty string, which takes the picker's hosted tab away. */
  klipyApiKey?: string | null;
  gifStorage?: GifStorageMode;
  /** Members one voice channel holds; 0 is unlimited. */
  maxVoiceMembers?: number;
  /** The tallest a shared screen is captured, in pixels. */
  screenShareHeight?: number;
  /** How many frames a second a shared screen is captured at. */
  screenShareFrameRate?: number;
  /** STUN URLs offered to clients; an empty list clears them. */
  stunUrls?: string[];
  /** TURN URLs offered to clients; an empty list clears them. */
  turnUrls?: string[];
  /** The coturn shared secret; an empty string clears it. */
  turnSecret?: string | null;
}

export interface BridgeSettings {
  /** Bot token, or null when the bridge has never been configured. */
  token: string | null;
  enabled: boolean;
  /**
   * Publicly reachable base URL of this instance, used to hand Discord image
   * URLs. Null disables outbound avatars.
   */
  publicBaseUrl: string | null;
}

/** Bridge settings safe to hand to the client: never includes the token. */
export interface BridgePublicSettings {
  configured: boolean;
  enabled: boolean;
  publicBaseUrl: string | null;
}

/**
 * The optional Discord sign-in integration. Both the id and secret are needed
 * before it can be switched on, and it is off unless an owner turns it on; the
 * whole bridge is optional anyway, and this is a separate concern from it.
 */
export interface DiscordAuthSettings {
  /** OAuth2 client id, or null when unconfigured. Not secret. */
  clientId: string | null;
  /** OAuth2 client secret, or null when unconfigured. Never leaves the server. */
  clientSecret: string | null;
  /** Whether sign-in and linking are switched on. Off by default. */
  enabled: boolean;
}

export interface SettingsService {
  get(): ServerSettings;
  update(patch: ServerSettingsUpdate): ServerSettings;
  getRetention(): RetentionSettings;
  updateRetention(patch: Partial<RetentionSettings>): RetentionSettings;
  getBridge(): BridgeSettings;
  getBridgePublic(): BridgePublicSettings;
  updateBridge(patch: { token?: string; enabled?: boolean; publicBaseUrl?: string | null }): BridgePublicSettings;
  getDiscordAuth(): DiscordAuthSettings;
  updateDiscordAuth(patch: { clientId?: string; clientSecret?: string; enabled?: boolean }): DiscordAuthSettings;
  /**
   * The callback URL to register with Discord, or null when the instance has no
   * public base URL. The flow cannot run without one, since Discord must be able
   * to reach us.
   */
  discordRedirectUri(): string | null;
  /** API key for the hosted gif service, or null when none is configured. */
  getKlipyKey(): string | null;
  /** The coturn shared secret for minting TURN credentials, or null when unset. */
  getTurnSecret(): string | null;
  /** The gif storage mode, read on its own because the security headers ask on every response. */
  getGifStorage(): GifStorageMode;
  /** Content hash of the uploaded server icon, or null for the built-in default. */
  getIconHash(): string | null;
  setIconHash(hash: string | null): void;
  /** Whether the server checks for updates once a day. Off unless the owner turns it on. */
  getUpdateCheck(): boolean;
  setUpdateCheck(enabled: boolean): void;
  /** How many pre-update database snapshots stay on disk. */
  getUpdateBackupRetention(): number;
  setUpdateBackupRetention(count: number): void;
}

const KEY_SERVER_NAME = 'server_name';
const KEY_REQUIRE_INVITE = 'require_invite';
const KEY_DEFAULT_CHANNEL = 'default_channel_id';
const KEY_EMBEDS_ENABLED = 'embeds_enabled';
const KEY_THEME_BACKGROUND = 'theme_background';
const KEY_THEME_ACCENT = 'theme_accent';
const KEY_ICON_PADDING = 'icon_padding';
const KEY_ICON_BACKGROUND = 'icon_background';
const KEY_IMAGE_DAYS = 'retention_image_days';
const KEY_VIDEO_DAYS = 'retention_video_days';
const KEY_MESSAGE_DAYS = 'retention_message_days';
const KEY_AUDIT_DAYS = 'retention_audit_days';
const KEY_SERVER_LOG_DAYS = 'retention_server_log_days';
const KEY_FAVORITE_DAYS = 'retention_favorite_days';
const KEY_EXTERNAL_EMOJI_DAYS = 'retention_external_emoji_days';
const KEY_STICKER_DAYS = 'retention_sticker_days';
const KEY_STORAGE_LIMIT = 'storage_limit_bytes';
const KEY_STORAGE_TARGET = 'storage_target_bytes';
const KEY_DISCORD_TOKEN = 'discord_bot_token';
const KEY_BRIDGE_ENABLED = 'bridge_enabled';
const KEY_BRIDGE_PUBLIC_URL = 'bridge_public_base_url';
const KEY_DISCORD_CLIENT_ID = 'discord_oauth_client_id';
const KEY_DISCORD_CLIENT_SECRET = 'discord_oauth_client_secret';
const KEY_DISCORD_AUTH_ENABLED = 'discord_oauth_enabled';
const KEY_ICON_HASH = 'instance_icon_hash';
const KEY_IMAGE_BYTES = 'upload_image_bytes';
const KEY_VIDEO_BYTES = 'upload_video_bytes';
const KEY_KLIPY_KEY = 'klipy_api_key';
const KEY_GIF_STORAGE = 'gif_storage';
const KEY_PREVIEW_UA = 'preview_user_agent';
const KEY_SETUP_COMPLETED = 'setup_completed';
const KEY_UPDATE_CHECK = 'update_check_enabled';
const KEY_UPDATE_BACKUP_RETENTION = 'update_backup_retention';
const KEY_MAX_VOICE_MEMBERS = 'max_voice_members';
const KEY_SCREEN_SHARE_HEIGHT = 'screen_share_height';
const KEY_SCREEN_SHARE_FRAME_RATE = 'screen_share_frame_rate';
const KEY_STUN_URLS = 'voice_stun_urls';
const KEY_TURN_URLS = 'voice_turn_urls';
const KEY_TURN_SECRET = 'voice_turn_secret';

function parseString(raw: string, fallback: string): string {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'string' ? value : fallback;
  } catch {
    return fallback;
  }
}

function parseBoolean(raw: string, fallback: boolean): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'boolean' ? value : fallback;
  } catch {
    return fallback;
  }
}

/** A number, or `null` meaning the rule is switched off. */
function parseNumberOrNull(raw: string | undefined): number | null {
  if (raw == null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function parseStringOrNull(raw: string | undefined): string | null {
  if (raw == null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** A stored list of URLs, dropping anything that is not a non-empty string. */
function parseStringArray(raw: string | undefined): string[] {
  if (raw == null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  } catch {
    return [];
  }
}

/** A stored color, or null when it is absent or not a `#rrggbb` value. */
function parseHexOrNull(raw: string | undefined): string | null {
  const value = parseStringOrNull(raw);
  return value !== null && HEX_COLOR_PATTERN.test(value) ? value : null;
}

/**
 * A stored icon padding, or null when it is absent or out of range. Null is also
 * how "work it out from the image" is stored, which is the same thing as far as
 * the renderer is concerned.
 */
function parsePadding(raw: string | undefined): number | null {
  const value = parseNumberOrNull(raw);
  if (value === null || value < 0 || value > MAX_ICON_PADDING) return null;
  return Math.round(value);
}

/** A positive byte count, clamped to what the multipart layer can buffer. */
function parseSize(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1024) return fallback;
    return Math.min(Math.floor(value), MAX_UPLOAD_CEILING_BYTES);
  } catch {
    return fallback;
  }
}

/**
 * Instance settings live in the database so admins can change them at runtime.
 * Environment values only provide the initial defaults.
 */
/**
 * What an instance falls back on before anything has been stored. It is the
 * settings shape minus the few that are worked out rather than defaulted, so a
 * caller cannot set something that is meant to be derived.
 */
export type SettingsDefaults = Omit<
  ServerSettings,
  'klipyConfigured' | 'gifStorage' | 'turnConfigured' | 'stunUrls' | 'turnUrls'
>;

/** A stored gif storage mode; anything unrecognized means the safe default, "store". */
function parseGifStorage(raw: string | undefined): GifStorageMode {
  return parseStringOrNull(raw) === 'link' ? 'link' : 'store';
}

/** Keeps a stored snapshot retention within the bounds the request schema also enforces. */
function clampRetention(value: number): number {
  return Math.min(MAX_UPDATE_BACKUP_RETENTION, Math.max(1, Math.round(value)));
}

export function createSettingsService(sqlite: DatabaseSync, defaults: SettingsDefaults): SettingsService {
  function get(): ServerSettings {
    const stored = readAllSettings(sqlite);
    const name = stored.get(KEY_SERVER_NAME);
    const requireInvite = stored.get(KEY_REQUIRE_INVITE);
    const embeds = stored.get(KEY_EMBEDS_ENABLED);
    const setup = stored.get(KEY_SETUP_COMPLETED);

    return {
      serverName: name ? parseString(name, defaults.serverName) : defaults.serverName,
      requireInvite: requireInvite ? parseBoolean(requireInvite, defaults.requireInvite) : defaults.requireInvite,
      defaultChannelId: parseStringOrNull(stored.get(KEY_DEFAULT_CHANNEL)),
      embedsEnabled: embeds ? parseBoolean(embeds, defaults.embedsEnabled) : defaults.embedsEnabled,
      theme: {
        background: parseHexOrNull(stored.get(KEY_THEME_BACKGROUND)),
        accent: parseHexOrNull(stored.get(KEY_THEME_ACCENT)),
      },
      icon: {
        padding: parsePadding(stored.get(KEY_ICON_PADDING)),
        background: parseHexOrNull(stored.get(KEY_ICON_BACKGROUND)),
      },
      maxImageBytes: parseSize(stored.get(KEY_IMAGE_BYTES), defaults.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES),
      maxVideoBytes: parseSize(stored.get(KEY_VIDEO_BYTES), defaults.maxVideoBytes ?? DEFAULT_MAX_VIDEO_BYTES),
      previewUserAgent: parseStringOrNull(stored.get(KEY_PREVIEW_UA)),
      setupCompleted: setup ? parseBoolean(setup, defaults.setupCompleted) : defaults.setupCompleted,
      klipyConfigured: parseStringOrNull(stored.get(KEY_KLIPY_KEY)) !== null,
      gifStorage: parseGifStorage(stored.get(KEY_GIF_STORAGE)),
      maxVoiceMembers:
        parseNumberOrNull(stored.get(KEY_MAX_VOICE_MEMBERS)) ??
        defaults.maxVoiceMembers ??
        DEFAULT_MAX_VOICE_MEMBERS,
      screenShareHeight:
        parseNumberOrNull(stored.get(KEY_SCREEN_SHARE_HEIGHT)) ??
        defaults.screenShareHeight ??
        DEFAULT_SCREEN_SHARE_HEIGHT,
      screenShareFrameRate:
        parseNumberOrNull(stored.get(KEY_SCREEN_SHARE_FRAME_RATE)) ??
        defaults.screenShareFrameRate ??
        DEFAULT_SCREEN_SHARE_FRAME_RATE,
      stunUrls: parseStringArray(stored.get(KEY_STUN_URLS)),
      turnUrls: parseStringArray(stored.get(KEY_TURN_URLS)),
      turnConfigured: parseStringOrNull(stored.get(KEY_TURN_SECRET)) !== null,
    };
  }

  function getRetention(): RetentionSettings {
    const stored = readAllSettings(sqlite);
    return {
      imageRetentionDays: parseNumberOrNull(stored.get(KEY_IMAGE_DAYS)),
      videoRetentionDays: parseNumberOrNull(stored.get(KEY_VIDEO_DAYS)),
      messageRetentionDays: parseNumberOrNull(stored.get(KEY_MESSAGE_DAYS)),
      auditRetentionDays: parseNumberOrNull(stored.get(KEY_AUDIT_DAYS)),
      serverLogRetentionDays: parseNumberOrNull(stored.get(KEY_SERVER_LOG_DAYS)),
      favoriteRetentionDays: parseNumberOrNull(stored.get(KEY_FAVORITE_DAYS)),
      externalEmojiRetentionDays: parseNumberOrNull(stored.get(KEY_EXTERNAL_EMOJI_DAYS)),
      stickerRetentionDays: parseNumberOrNull(stored.get(KEY_STICKER_DAYS)),
      storageLimitBytes: parseNumberOrNull(stored.get(KEY_STORAGE_LIMIT)),
      storageTargetBytes: parseNumberOrNull(stored.get(KEY_STORAGE_TARGET)),
    };
  }

  function getBridge(): BridgeSettings {
    const stored = readAllSettings(sqlite);
    const enabled = stored.get(KEY_BRIDGE_ENABLED);
    return {
      token: parseStringOrNull(stored.get(KEY_DISCORD_TOKEN)),
      enabled: enabled ? parseBoolean(enabled, false) : false,
      publicBaseUrl: parseStringOrNull(stored.get(KEY_BRIDGE_PUBLIC_URL)),
    };
  }

  function getBridgePublic(): BridgePublicSettings {
    const bridge = getBridge();
    return {
      configured: bridge.token !== null,
      enabled: bridge.enabled,
      publicBaseUrl: bridge.publicBaseUrl,
    };
  }

  function getDiscordAuth(): DiscordAuthSettings {
    const stored = readAllSettings(sqlite);
    const enabled = stored.get(KEY_DISCORD_AUTH_ENABLED);
    return {
      clientId: parseStringOrNull(stored.get(KEY_DISCORD_CLIENT_ID)),
      clientSecret: parseStringOrNull(stored.get(KEY_DISCORD_CLIENT_SECRET)),
      enabled: enabled ? parseBoolean(enabled, false) : false,
    };
  }

  function discordRedirectUri(): string | null {
    const base = getBridge().publicBaseUrl;
    if (!base) return null;
    return `${base.replace(/\/+$/, '')}/api/v1/auth/discord/callback`;
  }

  return {
    get,
    getRetention,
    getBridge,
    getBridgePublic,
    getDiscordAuth,
    discordRedirectUri,

    getIconHash() {
      return parseStringOrNull(readAllSettings(sqlite).get(KEY_ICON_HASH));
    },

    getKlipyKey() {
      return parseStringOrNull(readAllSettings(sqlite).get(KEY_KLIPY_KEY));
    },
    getTurnSecret() {
      return parseStringOrNull(readAllSettings(sqlite).get(KEY_TURN_SECRET));
    },

    getGifStorage() {
      const row = sqlite.prepare('SELECT value FROM server_settings WHERE key = ?').get(KEY_GIF_STORAGE) as
        | { value: string }
        | undefined;
      return parseGifStorage(row?.value);
    },

    setIconHash(hash) {
      writeSetting(sqlite, KEY_ICON_HASH, JSON.stringify(hash));
    },

    getUpdateCheck() {
      const raw = readAllSettings(sqlite).get(KEY_UPDATE_CHECK);
      // Off unless it has been switched on: the check calls out to the internet.
      return raw ? parseBoolean(raw, false) : false;
    },

    setUpdateCheck(enabled) {
      writeSetting(sqlite, KEY_UPDATE_CHECK, JSON.stringify(enabled));
    },

    getUpdateBackupRetention() {
      const parsed = parseNumberOrNull(readAllSettings(sqlite).get(KEY_UPDATE_BACKUP_RETENTION));
      return parsed !== null ? clampRetention(parsed) : DEFAULT_UPDATE_BACKUP_RETENTION;
    },

    setUpdateBackupRetention(count) {
      writeSetting(sqlite, KEY_UPDATE_BACKUP_RETENTION, JSON.stringify(clampRetention(count)));
    },

    update(patch) {
      if (patch.serverName !== undefined) writeSetting(sqlite, KEY_SERVER_NAME, JSON.stringify(patch.serverName));
      if (patch.requireInvite !== undefined) {
        writeSetting(sqlite, KEY_REQUIRE_INVITE, JSON.stringify(patch.requireInvite));
      }
      if (patch.defaultChannelId !== undefined) {
        writeSetting(sqlite, KEY_DEFAULT_CHANNEL, JSON.stringify(patch.defaultChannelId));
      }
      if (patch.embedsEnabled !== undefined) {
        writeSetting(sqlite, KEY_EMBEDS_ENABLED, JSON.stringify(patch.embedsEnabled));
      }
      if (patch.theme?.background !== undefined) {
        writeSetting(sqlite, KEY_THEME_BACKGROUND, JSON.stringify(patch.theme.background));
      }
      if (patch.theme?.accent !== undefined) {
        writeSetting(sqlite, KEY_THEME_ACCENT, JSON.stringify(patch.theme.accent));
      }
      if (patch.icon?.padding !== undefined) {
        writeSetting(sqlite, KEY_ICON_PADDING, JSON.stringify(patch.icon.padding));
      }
      if (patch.icon?.background !== undefined) {
        writeSetting(sqlite, KEY_ICON_BACKGROUND, JSON.stringify(patch.icon.background));
      }
      if (patch.maxImageBytes !== undefined) {
        writeSetting(sqlite, KEY_IMAGE_BYTES, JSON.stringify(patch.maxImageBytes));
      }
      if (patch.maxVideoBytes !== undefined) {
        writeSetting(sqlite, KEY_VIDEO_BYTES, JSON.stringify(patch.maxVideoBytes));
      }
      if (patch.previewUserAgent !== undefined) {
        const trimmed = patch.previewUserAgent?.trim() ?? '';
        writeSetting(sqlite, KEY_PREVIEW_UA, JSON.stringify(trimmed.length > 0 ? trimmed : null));
      }
      if (patch.setupCompleted !== undefined) {
        writeSetting(sqlite, KEY_SETUP_COMPLETED, JSON.stringify(patch.setupCompleted));
      }
      if (patch.klipyApiKey !== undefined) {
        const trimmed = patch.klipyApiKey?.trim() ?? '';
        writeSetting(sqlite, KEY_KLIPY_KEY, JSON.stringify(trimmed.length > 0 ? trimmed : null));
      }
      if (patch.gifStorage !== undefined) {
        writeSetting(sqlite, KEY_GIF_STORAGE, JSON.stringify(patch.gifStorage));
      }
      if (patch.maxVoiceMembers !== undefined) {
        writeSetting(sqlite, KEY_MAX_VOICE_MEMBERS, JSON.stringify(patch.maxVoiceMembers));
      }
      if (patch.screenShareHeight !== undefined) {
        writeSetting(sqlite, KEY_SCREEN_SHARE_HEIGHT, JSON.stringify(patch.screenShareHeight));
      }
      if (patch.screenShareFrameRate !== undefined) {
        writeSetting(sqlite, KEY_SCREEN_SHARE_FRAME_RATE, JSON.stringify(patch.screenShareFrameRate));
      }
      if (patch.stunUrls !== undefined) {
        writeSetting(sqlite, KEY_STUN_URLS, JSON.stringify(patch.stunUrls));
      }
      if (patch.turnUrls !== undefined) {
        writeSetting(sqlite, KEY_TURN_URLS, JSON.stringify(patch.turnUrls));
      }
      if (patch.turnSecret !== undefined) {
        const trimmed = patch.turnSecret?.trim() ?? '';
        writeSetting(sqlite, KEY_TURN_SECRET, JSON.stringify(trimmed.length > 0 ? trimmed : null));
      }
      return get();
    },

    updateRetention(patch) {
      if (patch.imageRetentionDays !== undefined) {
        writeSetting(sqlite, KEY_IMAGE_DAYS, JSON.stringify(patch.imageRetentionDays));
      }
      if (patch.videoRetentionDays !== undefined) {
        writeSetting(sqlite, KEY_VIDEO_DAYS, JSON.stringify(patch.videoRetentionDays));
      }
      if (patch.messageRetentionDays !== undefined) {
        writeSetting(sqlite, KEY_MESSAGE_DAYS, JSON.stringify(patch.messageRetentionDays));
      }
      if (patch.auditRetentionDays !== undefined) {
        writeSetting(sqlite, KEY_AUDIT_DAYS, JSON.stringify(patch.auditRetentionDays));
      }
      if (patch.serverLogRetentionDays !== undefined) {
        writeSetting(sqlite, KEY_SERVER_LOG_DAYS, JSON.stringify(patch.serverLogRetentionDays));
      }
      if (patch.favoriteRetentionDays !== undefined) {
        writeSetting(sqlite, KEY_FAVORITE_DAYS, JSON.stringify(patch.favoriteRetentionDays));
      }
      if (patch.externalEmojiRetentionDays !== undefined) {
        writeSetting(sqlite, KEY_EXTERNAL_EMOJI_DAYS, JSON.stringify(patch.externalEmojiRetentionDays));
      }
      if (patch.stickerRetentionDays !== undefined) {
        writeSetting(sqlite, KEY_STICKER_DAYS, JSON.stringify(patch.stickerRetentionDays));
      }
      if (patch.storageLimitBytes !== undefined) {
        writeSetting(sqlite, KEY_STORAGE_LIMIT, JSON.stringify(patch.storageLimitBytes));
      }
      if (patch.storageTargetBytes !== undefined) {
        writeSetting(sqlite, KEY_STORAGE_TARGET, JSON.stringify(patch.storageTargetBytes));
      }
      return getRetention();
    },

    updateBridge(patch) {
      if (patch.token !== undefined) {
        writeSetting(sqlite, KEY_DISCORD_TOKEN, JSON.stringify(patch.token === '' ? null : patch.token));
      }
      if (patch.enabled !== undefined) {
        writeSetting(sqlite, KEY_BRIDGE_ENABLED, JSON.stringify(patch.enabled));
      }
      if (patch.publicBaseUrl !== undefined) {
        const trimmed = patch.publicBaseUrl?.trim() ?? '';
        writeSetting(sqlite, KEY_BRIDGE_PUBLIC_URL, JSON.stringify(trimmed.length > 0 ? trimmed : null));
      }
      return getBridgePublic();
    },

    updateDiscordAuth(patch) {
      if (patch.clientId !== undefined) {
        const trimmed = patch.clientId.trim();
        writeSetting(sqlite, KEY_DISCORD_CLIENT_ID, JSON.stringify(trimmed.length > 0 ? trimmed : null));
      }
      if (patch.clientSecret !== undefined) {
        const trimmed = patch.clientSecret.trim();
        writeSetting(sqlite, KEY_DISCORD_CLIENT_SECRET, JSON.stringify(trimmed.length > 0 ? trimmed : null));
      }
      if (patch.enabled !== undefined) {
        writeSetting(sqlite, KEY_DISCORD_AUTH_ENABLED, JSON.stringify(patch.enabled));
      }
      return getDiscordAuth();
    },
  };
}
