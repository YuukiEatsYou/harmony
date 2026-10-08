import type { LinkedGif } from './gif-hosts.ts';
import type { Poll } from './polls.ts';

export type SnowflakeId = string;
export type IsoTimestamp = string;
export type ChannelType = 'text' | 'voice';

/**
 * A badge drawn beside a member's name. Owner and admin are derived rather than
 * configured: one from the account flag, the other from the Administrator
 * permission. Moderator is the only one a role has to be told to confer.
 */
export type UserBadge = 'owner' | 'admin' | 'moderator';

/** The badge a role confers, if any. Only moderator is a role's to give. */
export type RoleBadge = 'none' | 'moderator';

/**
 * What kind of account a user row is. A `user` is a person who signed up. A
 * `ghost` is a Discord stand-in the bridge created and owns. A `bot` is an
 * account the owner set up in the admin panel, used through a token.
 */
export type AccountType = 'user' | 'bot' | 'ghost';

export interface User {
  id: SnowflakeId;
  username: string;
  displayName: string | null;
  avatarHash: string | null;
  /**
   * Color of the user's highest-positioned colored role, or null for the
   * default text color. Purely a display concern — it has no bearing on
   * permissions.
   */
  roleColor: number | null;
  /**
   * The packed RGB color the member chose from the instance's palette, or null
   * for none. Resolved from the palette entry they picked. Shown only when they
   * hold no colored role, so a role color always wins; a role color also glows,
   * the client's way of telling the two apart. Purely a display concern.
   */
  nameColor: number | null;
  /** Whether this is a person, a bot, or a Discord stand-in. */
  accountType: AccountType;
  isOwner: boolean;
  /** The badge to draw beside this member's name, or null for none. */
  badge: UserBadge | null;
  createdAt: IsoTimestamp;
  /** End of an active moderation timeout, or null when not timed out. */
  timedOutUntil: IsoTimestamp | null;
  /**
   * Whether typing indicators are on for this user. When false they neither
   * broadcast their own typing nor see anyone else's.
   */
  showTyping: boolean;
  /**
   * Whether the louder sound plays for a message that mentions this user, by
   * reply or by name. In-app only: nothing is ever pushed to a device.
   */
  notifyMajor: boolean;
  /** Whether the quieter sound plays for other messages. In-app only. */
  notifyMinor: boolean;
  /**
   * The Discord account this stand-in represents, or null for a real member.
   * Only ever set on accounts the bridge created for the other side of a link.
   */
  discordId: string | null;
  /**
   * Whether this member's profile picture follows their linked Discord account.
   * On by default. While it is on, the picture is Discord's to set and cannot be
   * changed here; turning it on syncs straight away. Always true without a link,
   * where it means nothing.
   */
  syncDiscordAvatar: boolean;
  /**
   * False for an account created by signing in with Discord, which has no
   * password until the member sets one.
   */
  hasPassword: boolean;
}

/** A ban, with the user it applies to and who issued it. */
export interface Ban {
  user: User;
  bannedBy: User | null;
  reason: string | null;
  createdAt: IsoTimestamp;
}

export interface Role {
  id: SnowflakeId;
  name: string;
  /** Packed RGB integer, or null for the neutral default color. */
  color: number | null;
  position: number;
  /** Permission bitfield as a decimal string (JSON cannot carry a bigint). */
  permissions: string;
  hoist: boolean;
  mentionable: boolean;
  isDefault: boolean;
  /** The badge this role confers on its members, `'none'` for most roles. */
  badge: RoleBadge;
}

/**
 * One color an administrator offers for members' usernames, the Discord
 * color-role idea streamlined: a member picks one in their profile instead of
 * needing a role per color. It grants nothing. A colored role the member holds
 * still wins over it.
 */
export interface NameColor {
  id: SnowflakeId;
  /** Packed RGB integer. */
  color: number;
  /** Optional name shown beside the swatch, or null for a bare color. */
  label: string | null;
  position: number;
}

export interface Category {
  id: SnowflakeId;
  name: string;
  position: number;
  /**
   * A role required to see this category and every channel in it, or null when
   * it is open to everyone. Categories are never more open than their role.
   */
  requiredRoleId: SnowflakeId | null;
}

export interface Channel {
  id: SnowflakeId;
  name: string;
  topic: string | null;
  type: ChannelType;
  categoryId: SnowflakeId | null;
  position: number;
  createdAt: IsoTimestamp;
  /** Discord channel this one is bridged with, or null when not bridged. */
  discordChannelId: string | null;
  /**
   * A role required to see this channel, or null to inherit from its category
   * and ultimately to be open to everyone.
   */
  requiredRoleId: SnowflakeId | null;
  /** Seconds a member must wait between messages; 0 means slowmode is off. */
  slowmodeSeconds: number;
}

/**
 * One member's presence in a voice channel. Audio itself never touches the
 * server, so this is only who is in the room and how they are set: the flags
 * here are what a client draws mute and deafen icons from.
 */
export interface VoiceState {
  channelId: SnowflakeId;
  user: User;
  /** The member muted their own microphone. */
  muted: boolean;
  /** The member stopped hearing everyone, which also mutes them, as on Discord. */
  deafened: boolean;
  /** The member is sharing their screen. */
  sharing: boolean;
}

export interface Attachment {
  id: string;
  messageId: string | null;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  hash: string;
  createdAt: IsoTimestamp;
  /**
   * The link this was copied from, for an image the server fetched out of a
   * message's own text rather than one somebody uploaded. Null for an upload.
   * A client can ignore it; the bridge uses it to avoid handing Discord a file
   * for a link Discord is perfectly able to unfurl itself.
   */
  sourceUrl: string | null;
}

/**
 * A Discord sticker learned from a bridged message. It is a shared asset rather
 * than a per-message upload: one row stands behind every message that sent it,
 * served by id and aged out once no bridged message has carried it for a while.
 * Harmony has no stickers of its own, so a sticker only ever arrives this way.
 */
export interface Sticker {
  id: string;
  name: string;
  hash: string;
  animated: boolean;
}

/**
 * A basic link preview unfurled from a message's first embeddable URL. Only text
 * is kept: no remote images are fetched or stored.
 */
export interface LinkEmbed {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  /**
   * A preview image the page advertises, or the link itself when it points
   * straight at an image. Clients load it through `GET /api/v1/embeds/media`
   * rather than from the remote host.
   */
  imageUrl: string | null;
  /** An inline player to offer, when the link is one we can play ourselves. */
  player: EmbedPlayer | null;
  /**
   * Set when the link is a gif the instance chose to link to rather than store
   * (gif storage mode "link"): `url` is then the gif itself, on an allowlisted
   * gif host, and clients draw it directly from there.
   */
  gif?: LinkedGif | null;
}

/**
 * A playable embed. The id is all that crosses the wire: a client builds the
 * player URL from a provider it knows, so the origin is never taken from the
 * page we scraped.
 */
export interface EmbedPlayer {
  provider: 'youtube';
  id: string;
}

/** What an audit entry records. */
export type AuditKind =
  | 'message_delete'
  | 'message_edit'
  | 'media_delete'
  | 'timeout_add'
  | 'timeout_clear'
  | 'kick'
  | 'ban'
  | 'unban'
  | 'role_add'
  | 'role_remove'
  | 'member_update'
  | 'member_delete'
  | 'password_reset'
  | 'message_pin'
  | 'message_unpin'
  | 'backup_download'
  | 'channel_export'
  | 'server_gif_add'
  | 'server_gif_remove'
  | 'server_gif_hide'
  | 'server_gif_unhide'
  | 'gif_archive'
  | 'gif_free'
  | 'event_create'
  | 'event_edit'
  | 'event_cancel';

/**
 * The kind-specific fields of an audit entry. Every field is optional because
 * each kind fills in only the ones it needs:
 *
 * - `message_delete` / `message_edit`: `channelName` and `before`, plus `after`
 *   for an edit, and `attachments` for a deletion that carried images.
 * - `media_delete`: `filename` and `channelName`.
 * - `timeout_add`: `durationMinutes`. `ban`: `reason`.
 * - `role_add` / `role_remove`: `roleName`.
 * - `member_update`: `fields`, the account fields an administrator changed.
 * - `message_pin` / `message_unpin`: `channelName`, and `before` holding the
 *   message text as it read when it was pinned or unpinned. The target is the
 *   message's author.
 * - `backup_download`: `filename`. `channel_export`: `channelName` and `filename`.
 * - `server_gif_*`: `filename`, and `gifName` for a curated gif's display name.
 * - `event_create` / `event_edit` / `event_cancel`: `eventTitle`, and `channelName` for a channel event.
 *
 * `actorName` and `targetName` are snapshots taken when the entry was written,
 * so it stays readable after a rename or a deletion.
 */
export interface AuditDetail {
  channelName?: string;
  roleName?: string;
  filename?: string;
  /** server_gif_add / server_gif_remove: the curated gif's display name. */
  gifName?: string;
  /** event_*: the event's title as it read at the time. */
  eventTitle?: string;
  actorName?: string;
  targetName?: string;
  before?: string;
  after?: string;
  durationMinutes?: number;
  reason?: string | null;
  /** gif_archive / gif_free: how many gifs the action copied or released. */
  count?: number;
  /** gif_free: how many bytes of stored copies were released. */
  bytes?: number;
  /** member_update: the account fields that were changed, by name. */
  fields?: string[];
  /** Images that went with a deleted message, so the log can still show them. */
  attachments?: Array<{ id: SnowflakeId; filename: string }>;
}

/** One recorded admin or moderation action. */
export interface AuditEntry {
  id: SnowflakeId;
  kind: AuditKind;
  /** Who performed it, or null once that account is gone. */
  actor: User | null;
  /** Who it happened to, when the kind has a target. */
  target: User | null;
  createdAt: IsoTimestamp;
  detail: AuditDetail;
}

export interface Message {
  id: SnowflakeId;
  channelId: SnowflakeId;
  author: User | null;
  content: string;
  createdAt: IsoTimestamp;
  editedAt: IsoTimestamp | null;
  attachments: Attachment[];
  /** Stickers sent with the message. Only Discord has these, so usually empty. */
  stickers: Sticker[];
  /** The message this one replies to, or null for a normal message. */
  replyTo: MessageReference | null;
  /** Distinct emoji reactions, aggregated. Empty when there are none. */
  reactions: Reaction[];
  /** A preview of the first embeddable link in `content`, or null. */
  embed: LinkEmbed | null;
  /** When the message was pinned to its channel, or null when it is not pinned. */
  pinnedAt: IsoTimestamp | null;
  /**
   * Whether the viewer has saved this message for later. Like a reaction's `me`
   * it is one member's perspective, so a broadcast always carries false and
   * clients keep the value they already hold.
   */
  saved: boolean;
  /** The poll this message carries, or null for an ordinary message. */
  poll: Poll | null;
}

/**
 * One message a member saved for later, as their saved list shows it. Saves are
 * private: nobody but the member who made one ever sees it.
 */
export interface SavedMessage {
  message: Message;
  savedAt: IsoTimestamp;
  /** When to remind them about it, or null for a plain save. */
  remindAt: IsoTimestamp | null;
}

/**
 * One emoji's worth of reactions on a message. Individual reactors are not
 * exposed; the client only needs the tally and whether it is one of them.
 */
export interface Reaction {
  /** A unicode character, or `:name:` for a custom Harmony emoji. */
  emoji: string;
  /** The custom emoji id when `emoji` is a `:name:` shortcode, else null. */
  emojiId: SnowflakeId | null;
  count: number;
  /** Whether the requesting user is among the reactors. */
  me: boolean;
}

/**
 * A compact view of the parent of a reply, enough to render the inline preview
 * without shipping the whole message (and its attachments) again.
 */
export interface MessageReference {
  id: SnowflakeId;
  author: User | null;
  /** The original text, or an empty string when it has been deleted. */
  content: string;
  deleted: boolean;
}

/** How a message came to be aimed at someone. */
export type MentionKind = 'mention' | 'reply';

/**
 * One entry in a member's own inbox: a message that named them or answered
 * theirs. It is private to the recipient, in the same spirit as the read marker:
 * nobody else can see what has been collected here.
 */
export interface Mention {
  /** The message that did the mentioning, ready to render. */
  message: Message;
  /** Whether a reply or a name brought it about. */
  kind: MentionKind;
  /**
   * Whether the caller has not read the channel since, so it is still new. It
   * follows the channel's read cursor rather than a second one of its own: a
   * mention is read exactly when the channel it landed in is.
   */
  unread: boolean;
}

export interface Emoji {
  id: SnowflakeId;
  name: string;
  hash: string;
  animated: boolean;
  /**
   * Learned from a Discord message rather than added here. It renders and reacts
   * like any other emoji, but is kept out of the pickers: it is only here to show
   * what came across the bridge.
   */
  external: boolean;
}

export interface Invite {
  code: string;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp | null;
  maxUses: number | null;
  uses: number;
}
