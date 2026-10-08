import type {
  Attachment,
  AuditEntry,
  Ban,
  Category,
  Channel,
  Emoji,
  Invite,
  Mention,
  Message,
  NameColor,
  Role,
  SavedMessage,
  User,
  VoiceState,
} from './types.ts';
import type { GifStorageMode } from './gif-hosts.ts';
import type { ThemeSettings } from './theme.ts';
import type { ChannelNotificationSettings } from './channel-settings.ts';

/** Response for a successful register or login. */
export interface AuthResponse {
  user: User;
  /** Raw session token, for API clients that authenticate via `Authorization: Bearer`. */
  token: string;
}

/** Response for `GET /api/v1/auth/me`. */
export interface MeResponse {
  user: User;
  /** Effective permissions as a decimal bitfield string. */
  permissions: string;
}

/** Response for an administrator editing another member's account. */
export interface MemberUpdateResponse {
  user: User;
}

/** Consistent error body returned by every API endpoint. */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** Response for `GET /api/v1/channels`. */
export interface ChannelListResponse {
  categories: Category[];
  channels: Channel[];
  /**
   * Channels holding messages this member has not read. It lives beside the
   * channels rather than on them because it is per member: the same channel is
   * unread for one person and read for another.
   */
  unreadChannelIds: string[];
  /**
   * Channels holding an unread mention or reply for this member, which is what
   * puts a red mark beside them. A channel drops off this list exactly when it is
   * read, so it moves together with `unreadChannelIds`.
   */
  mentionChannelIds: string[];
  /**
   * How many unread mentions and replies each channel holds for this member,
   * for the number beside it. Only channels with at least one are listed, so
   * its keys are exactly `mentionChannelIds`.
   */
  mentionCounts: Record<string, number>;
  /**
   * How far this member has read each channel: the time of the newest message
   * they had seen. A channel they have never opened is absent. It is what lets a
   * client draw the line above the first new message when a channel is opened.
   */
  readMarkers: Record<string, string>;
  /** Channel a client should open on load, or null to fall back to the first one. */
  defaultChannelId: string | null;
}

/** Response for `GET /api/v1/users/@me/channel-settings`. */
export interface ChannelSettingsListResponse {
  /**
   * The caller's settings for every channel and category they have changed
   * anything on and can still see. Anything absent is on the defaults.
   */
  settings: ChannelNotificationSettings[];
}

/** Response for `GET /api/v1/mentions`. */
export interface MentionListResponse {
  mentions: Mention[];
}

/** Response for `GET /api/v1/channels/:id/messages`. */
export interface MessageListResponse {
  messages: Message[];
}

/** One earlier version of an edited message. */
export interface MessageEdit {
  id: string;
  /** The text before the edit. */
  content: string;
  /** When the edit that replaced this text happened. */
  editedAt: string;
  /** Who made that edit, or null when the account is gone. */
  editor: User | null;
  source: 'harmony' | 'discord';
}

/** Response for `GET /api/v1/messages/:id/edits`: previous versions, newest first. */
export interface MessageEditListResponse {
  edits: MessageEdit[];
}

/** Response for `GET /api/v1/channels/:id/pins`: the channel's pins, newest pin first. */
export interface PinListResponse {
  messages: Message[];
}

/**
 * Response for `GET /api/v1/users/@me/saved`: the caller's own saved messages,
 * newest save first, or their reminders soonest first when asked for those.
 */
export interface SavedMessageListResponse {
  saved: SavedMessage[];
}

/** Public instance metadata, used by clients before they sign in. */
export interface InstanceMeta {
  name: string;
  apiVersion: string;
  requireInvite: boolean;
  /** Instance colors, so even the sign-in screen is themed. */
  theme: ThemeSettings;
  /**
   * Content hash of the admin-uploaded server icon, or null to use the client's
   * built-in default. Clients fetch the icon at `GET /api/v1/icon`.
   */
  iconHash: string | null;
  /** Largest accepted image upload, in bytes. */
  maxImageBytes: number;
  /** Largest accepted video upload, in bytes. */
  maxVideoBytes: number;
  allowedImageTypes: readonly string[];
  allowedVideoTypes: readonly string[];
  limits: {
    messageLength: number;
    attachmentsPerMessage: number;
    channelNameMax: number;
    usernameMin: number;
    usernameMax: number;
    passwordMin: number;
  };
  /** The bounds a shared screen is captured at; the relay never transcodes. */
  screenShare: { height: number; frameRate: number };
  /**
   * Whether a hosted gif service is configured, and so whether the picker offers
   * its tab. The key itself is never exposed to clients.
   */
  klipyConfigured: boolean;
  /**
   * How gifs are kept: "store" saves a copy on this server, "link" points at the
   * hosted gif service for gifs from a few known gif hosts. Clients draw linked
   * gifs only while this is "link".
   */
  gifStorage: GifStorageMode;
  /**
   * Whether Discord sign-in is offered on the sign-in screen, i.e. OAuth is
   * configured, switched on, and the instance has a public URL. Off unless an
   * administrator turns it on.
   */
  discordAuthEnabled: boolean;
}

/** Response for `GET` / `PATCH /api/v1/discord/auth`, for the admin panel. */
export interface DiscordAuthResponse {
  /** OAuth2 client id, which is not secret, or null when unconfigured. */
  clientId: string | null;
  /** Whether a client id and secret are both saved. The secret is never returned. */
  configured: boolean;
  /** Whether members may use Discord sign-in and account linking. */
  enabled: boolean;
  /**
   * The callback URL to register in the Discord developer portal, or null when
   * the instance has no public base URL set (in which case the flow cannot run).
   */
  redirectUri: string | null;
}

/** Response for `PUT` / `DELETE /api/v1/icon`. */
export interface InstanceIconResponse {
  /** Content hash of the stored icon, or null when it has been reset. */
  iconHash: string | null;
}

/** Response for `GET` / `PATCH /api/v1/settings`. */
export interface ServerSettingsResponse {
  serverName: string;
  requireInvite: boolean;
  /** Channel opened by default on load, or null to fall back to the first one. */
  defaultChannelId: string | null;
  /** Whether the server unfurls link previews by fetching the linked pages. */
  embedsEnabled: boolean;
  /** Instance colors; everything else in the palette is derived from these. */
  theme: ThemeSettings;
  /** How the installed app icon is drawn. */
  icon: IconSettings;
  /** Largest accepted image upload, in bytes. */
  maxImageBytes: number;
  /** Largest accepted video upload, in bytes. */
  maxVideoBytes: number;
  /**
   * User agent used when unfurling a link, or null to identify as Harmony.
   * Some sites refuse unknown clients, so naming one they allow is the only way
   * to preview them.
   */
  previewUserAgent: string | null;
  /** True once the owner has been through the first-run setup wizard. */
  setupCompleted: boolean;
  /**
   * Whether a hosted gif service is configured, and so whether the picker offers
   * its tab. The key itself is write-only: it goes in through the settings and is
   * never sent back out.
   */
  klipyConfigured: boolean;
  /** How gifs are kept; see `InstanceMeta.gifStorage`. */
  gifStorage: GifStorageMode;
  /** The tallest a shared screen is captured, in pixels. */
  screenShareHeight: number;
  /** How many frames a second a shared screen is captured at. */
  screenShareFrameRate: number;
}

/** A user together with the roles assigned to them. */
export interface MemberSummary {
  user: User;
  roleIds: string[];
  /** Effective permissions as a decimal bitfield string. */
  permissions: string;
}

export interface MemberListResponse {
  members: MemberSummary[];
}

/**
 * A bot account the owner set up in the admin panel. The token is never part of
 * this: it is shown once when the bot is created or its token is regenerated, and
 * only the hash is kept.
 */
export interface BotSummary {
  user: User;
  /** The bot's own permission bitfield, as a decimal string. */
  permissions: string;
  /** When the bot's token was last used, or null. */
  lastUsedAt: string | null;
}

export interface BotListResponse {
  bots: BotSummary[];
}

/** Creating a bot returns its token once; it can be regenerated but never read back. */
export interface BotCreateResponse {
  bot: BotSummary;
  token: string;
}

export interface BotTokenResponse {
  token: string;
}

/**
 * The public member directory: every user's profile, with no roles or
 * permissions. Used to resolve `@username` mentions and to autocomplete them.
 */
export interface UserDirectoryResponse {
  users: User[];
}

/**
 * One member of the public roster. Unlike the management view this carries no
 * permissions, but it does carry role ids so clients can group members the way
 * the server's hoisted roles describe, plus a live online flag.
 */
export interface MemberRosterEntry {
  user: User;
  roleIds: string[];
  online: boolean;
}

export interface MemberRosterResponse {
  members: MemberRosterEntry[];
}

/** Banned users, for `GET /api/v1/bans`. */
export interface BanListResponse {
  bans: Ban[];
}

/** A page of the audit log, newest first. */
export interface AuditListResponse {
  entries: AuditEntry[];
}

/** One stored image, resolved for the admin media gallery. */
export interface MediaItem {
  attachment: Attachment;
  uploader: User | null;
  /** Channel holding the attachment's message, or null for an abandoned upload. */
  channelId: string | null;
  channelName: string | null;
  /**
   * How many copies of this exact content are stored — the same bytes sent this
   * many times. Storage keeps one blob regardless; this is how often it was shared.
   */
  copies: number;
}

/** A page of the media gallery, newest first. */
export interface MediaListResponse {
  media: MediaItem[];
}

export interface RoleListResponse {
  roles: Role[];
}

/** The palette every member picks their username color from, in display order. */
export interface NameColorListResponse {
  nameColors: NameColor[];
}

/** The members currently in a voice channel, as a join or leave returns them. */
export interface VoiceRoomResponse {
  channelId: string;
  members: VoiceState[];
}

/**
 * Every voice channel that currently has members, for a client that has just
 * loaded: the roster otherwise only arrives as changes are broadcast.
 */
export interface VoiceRoomsResponse {
  channels: Array<{ channelId: string; members: VoiceState[] }>;
}

export interface InviteListResponse {
  invites: Invite[];
}

export interface EmojiListResponse {
  emojis: Emoji[];
}

/** A custom emoji that exists in the linked Discord server. */
export interface DiscordEmojiOption {
  id: string;
  name: string;
  animated: boolean;
  /** True when Harmony already has an emoji of this name. */
  imported: boolean;
}

export interface DiscordEmojiListResponse {
  /** The guild the bot is connected to, or null when the bridge is not running. */
  guildName: string | null;
  emojis: DiscordEmojiOption[];
}

/** How many Discord emoji an import created, skipped and could not read. */
export interface EmojiImportResponse {
  imported: number;
  /** Already present in Harmony. */
  skipped: number;
  /** Could not be downloaded or stored, e.g. a bad name or an oversized file. */
  failed: number;
}

/** When content is automatically deleted. `null` means "keep forever". */
/**
 * How the instance's installed app icon is drawn.
 *
 * An operating system crops an installed icon to a shape of its own, so how much
 * of the tile the artwork should fill is a judgment only the owner can make: a
 * logo wants room around it, a picture that already fills its own frame wants
 * none, and only the artwork itself can settle which it is.
 */
export interface IconSettings {
  /**
   * Share of the tile left clear around the artwork, as a percentage. Null works
   * it out from the image: none for a picture that fills its frame, and
   * `DEFAULT_ICON_PADDING` for a logo drawn on transparency.
   */
  padding: number | null;
  /**
   * What sits behind the artwork, or null to take the color from the artwork
   * itself. Only ever visible where the padding leaves a gap.
   */
  background: string | null;
}

export interface RetentionSettings {
  /** Delete image attachments older than this many days. */
  imageRetentionDays: number | null;
  /** Delete video attachments older than this many days. */
  videoRetentionDays: number | null;
  /** Delete messages older than this many days. */
  messageRetentionDays: number | null;
  /** Delete audit log entries older than this many days. */
  auditRetentionDays: number | null;
  /**
   * Delete server-log entries older than this many days. The log is small and
   * lives in the database, so unlike the media rules this only bounds its size;
   * null keeps entries forever.
   */
  serverLogRetentionDays: number | null;
  /**
   * Delete a saved gif this many days after it was last favorited or sent.
   * Favorites are exempt from the image and message rules, so this is the only
   * thing that ever ages them out; null keeps them forever.
   */
  favoriteRetentionDays: number | null;
  /**
   * Delete an emoji learned from a Discord message this many days after it was
   * last seen in one. Only learned emoji are ever aged out; the instance's own
   * emoji are kept whatever it says. Null keeps learned emoji forever.
   */
  externalEmojiRetentionDays: number | null;
  /**
   * Delete a sticker learned from a Discord message this many days after it was
   * last seen in one. Like learned emoji, only stickers acquired from Discord
   * are aged out; null keeps them forever.
   */
  stickerRetentionDays: number | null;
  /** Start emergency pruning once stored media exceeds this many bytes. */
  storageLimitBytes: number | null;
  /** Emergency pruning deletes oldest content until usage is back under this. */
  storageTargetBytes: number | null;
}

export interface RetentionUsage {
  /** Bytes of stored media (attachments and emoji). */
  blobBytes: number;
  attachmentCount: number;
  messageCount: number;
}

/**
 * A gif somebody kept. It is held by content hash, not by any message, so it
 * outlives the message it was found in and is only ever aged out by the rule for
 * favorites.
 */
export interface GifFavorite {
  id: string;
  /** Content hash of the stored bytes; the same gif is stored once. */
  hash: string;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  /** The link it was fetched from, or null for something uploaded here. */
  sourceUrl: string | null;
  createdAt: string;
  /** When it was last favorited or sent, which its retention counts from. */
  usedAt: string;
}

export interface GifFavoriteListResponse {
  favorites: GifFavorite[];
}

/**
 * A gif this instance already holds, for the picker's local tab. One per picture:
 * the same bytes are stored once however many times they were sent, so the newest
 * copy of each is what is listed.
 */
export interface GifItem {
  /** The attachment serving the bytes. */
  id: string;
  hash: string;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  sourceUrl: string | null;
  createdAt: string;
  /** The caller's own saved copy of it, when they have one. */
  favoriteId: string | null;
}

export interface GifListResponse {
  gifs: GifItem[];
}

/**
 * A gif offered by the hosted service the picker is configured with. Nothing is
 * stored until one is picked or saved; these are the service's own addresses.
 */
/**
 * A row of the server's gif list. `curated` is a gif an administrator chose to
 * keep for everyone: its bytes are a stored copy, so it outlives the message it
 * came from and any link rot. `hidden` is an administrator removing a gif from
 * the auto-collected list, kept as a row so the choice survives; it holds no
 * claim on the bytes, so retention treats it as nothing.
 */
export type ServerGifKind = 'curated' | 'hidden';

export interface ServerGif {
  id: string;
  kind: ServerGifKind;
  hash: string;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  /** A display name; the picker falls back to the filename when it is empty. */
  name: string;
  /** Search tags, already split and lower-cased. */
  tags: string[];
  position: number;
  pinned: boolean;
  addedBy: string | null;
  createdAt: string;
}

/** One tile of the picker's Server tab: a curated gif or an auto-collected one. */
export interface ServerGifItem {
  /** Curated: the ServerGif id. Auto: the attachment id serving the bytes. */
  id: string;
  source: 'curated' | 'auto';
  hash: string;
  name: string;
  tags: string[];
  filename: string;
  contentType: string;
  width: number | null;
  height: number | null;
  pinned: boolean;
  /** The caller's own saved copy of it, when they have one. */
  favoriteId: string | null;
}

export interface ServerGifListResponse {
  gifs: ServerGifItem[];
}

/** The admin view: curated gifs in display order, hidden ones, and the visible auto-collected rest. */
export interface ServerGifManageResponse {
  curated: ServerGif[];
  hidden: ServerGif[];
  auto: GifItem[];
}

export interface GifSearchResult {
  /** The gif itself, which is what gets fetched if this is picked or saved. */
  url: string;
  /** A smaller one, for the grid. */
  previewUrl: string;
  width: number | null;
  height: number | null;
  title: string;
}

/** Response for `POST /api/v1/gifs/link`: the checked address to put in a message. */
export interface GifLinkResponse {
  url: string;
  contentType: string;
}

/**
 * How the recorded gif sources stand (`GET /api/v1/gifs/sources`). A source is a
 * remote gif address paired with the copy this server may hold of it.
 */
export interface GifSourceStats {
  /** Every address recorded. */
  total: number;
  /** Recorded addresses with no copy here yet (and not dead): what an archive run would fetch. */
  linked: number;
  /** Addresses with a copy stored here. */
  archived: number;
  /** Addresses given up on after repeated failed fetches. */
  dead: number;
  /** Bytes held by the copies. */
  archivedBytes: number;
}

/** Response for `POST /api/v1/gifs/sources/archive`: one bounded batch. */
export interface GifArchiveResponse {
  /** Addresses looked at in this batch. */
  attempted: number;
  /** Copies made. */
  copied: number;
  /** Fetches that failed (the address stays recorded and is retried later). */
  failed: number;
  /** Addresses given up on in this batch. */
  markedDead: number;
  /** Whether more addresses are waiting; run it again to continue. */
  more: boolean;
  stats: GifSourceStats;
}

/** Response for `POST /api/v1/gifs/sources/free`. */
export interface GifFreeResponse {
  /** Copies released (the address stays recorded and can be copied again). */
  released: number;
  /** Bytes of stored files removed because nothing else refers to them any more. */
  freedBytes: number;
  stats: GifSourceStats;
}

export interface GifSearchResponse {
  gifs: GifSearchResult[];
}

export interface PruneSummary {
  ranAt: string;
  deletedAttachments: number;
  deletedMessages: number;
  deletedAuditEntries: number;
  deletedFavorites: number;
  deletedExternalEmojis: number;
  deletedStickers: number;
  deletedBlobs: number;
  freedBytes: number;
}

export interface RetentionResponse {
  settings: RetentionSettings;
  usage: RetentionUsage;
  lastRun: PruneSummary | null;
}

export interface RetentionRunResponse {
  summary: PruneSummary;
  usage: RetentionUsage;
}

/** State of the Discord bot connection. */
export interface BridgeStatus {
  ready: boolean;
  /** The bot's own tag, e.g. `harmony#1234`. */
  botTag: string | null;
  guildName: string | null;
  error: string | null;
}

export interface BridgeResponse {
  /** Whether a token has been saved. The token itself is never returned. */
  configured: boolean;
  enabled: boolean;
  /** Public base URL, or null when outbound avatars are disabled. */
  publicBaseUrl: string | null;
  status: BridgeStatus;
}

export interface DiscordChannelOption {
  id: string;
  name: string;
  /** The Discord category this channel sits in, or null at the top level. */
  categoryId: string | null;
}

export interface DiscordCategoryOption {
  id: string;
  name: string;
}

export interface DiscordChannelListResponse {
  guildName: string | null;
  /** Discord categories in display order, for the channel import. */
  categories: DiscordCategoryOption[];
  channels: DiscordChannelOption[];
}

/** One Discord channel offered to the channel import. */
export interface DiscordChannelImportOption {
  id: string;
  name: string;
  /** True when a Harmony channel already syncs with it. */
  bridged: boolean;
}

/** The Discord channels that share a category, as the import preview groups them. */
export interface DiscordChannelImportGroup {
  /** The Discord category's name, or null for uncategorized channels. */
  categoryName: string | null;
  channels: DiscordChannelImportOption[];
}

export interface DiscordChannelImportPreview {
  /** The guild the bot is connected to, or null when the bridge is not running. */
  guildName: string | null;
  groups: DiscordChannelImportGroup[];
}

/** How a Discord channel import went. */
export interface ChannelImportResponse {
  /** Channels created and bridged. */
  imported: number;
  /** Discord channels already bridged in Harmony. */
  skipped: number;
  /** Channels whose name does not fit Harmony's rules. */
  failed: number;
  /** New Harmony categories made to hold the imports. */
  categoriesCreated: number;
}

/** How many Discord messages a history import pulled in. */
export interface BridgeImportResponse {
  imported: number;
}
