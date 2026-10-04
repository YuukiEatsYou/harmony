import type { BridgeStatus, DiscordChannelListResponse } from '@harmony/shared';

/**
 * Discord rejects message content longer than this. Harmony allows more, so the
 * bridge splits a longer message into several posts on the way out.
 */
export const DISCORD_MAX_CONTENT = 2000;

export interface DiscordIncomingAttachment {
  url: string;
  filename: string;
  contentType: string;
  size: number;
}

/** A user mentioned in a Discord message, as telling us something useful about them. */
export interface DiscordMention {
  id: string;
  /** Display name when known, otherwise the username. */
  name: string;
}

/** A sticker carried by a Discord message. */
export interface DiscordIncomingSticker {
  id: string;
  name: string;
  /** Discord's sticker format: 1 PNG, 2 APNG, 3 Lottie, 4 GIF. */
  formatType: number;
}

export interface DiscordIncomingMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  /** Public avatar URL, or null when the author has no custom picture. */
  authorAvatarUrl: string | null;
  /** Discord message this one replies to, or null. */
  replyToDiscordId: string | null;
  /** Users mentioned in the message, for rewriting `<@id>` mentions. */
  mentions: DiscordMention[];
  /** Stickers sent with the message, usually none. */
  stickers: DiscordIncomingSticker[];
  /** When the message was sent, ISO 8601. Imported history keeps this. */
  createdAt: string;
  content: string;
  attachments: DiscordIncomingAttachment[];
  /** True for any bot, including our own webhook mirrors. Never re-bridged. */
  fromBot: boolean;
  /**
   * True when the message forwards another one. Discord sends a forward with no
   * content of its own; the transport fills in the forwarded message's text and
   * attachments instead.
   */
  forwarded?: boolean;
}

export interface DiscordIncomingEdit {
  id: string;
  channelId: string;
  content: string;
  /** Users mentioned in the edited text, for rewriting `<@id>` mentions. */
  mentions: DiscordMention[];
  /**
   * True for any bot, including our own webhook mirrors. Our edits of a mirrored
   * message come back as updates too, and must never be applied to the original.
   */
  fromBot: boolean;
}

export interface DiscordIncomingDelete {
  id: string;
  channelId: string;
}

export interface WebhookRef {
  id: string;
  token: string;
}

/** A custom emoji that exists in the bridged Discord guild. */
export interface DiscordEmoji {
  id: string;
  name: string;
  animated: boolean;
}

/**
 * One Discord member's online state. Discord tells us this for a guild we have the
 * privileged GuildPresences intent for, both when the bot connects and on every
 * later change.
 */
export interface DiscordIncomingPresence {
  /** The Discord account this is about. */
  userId: string;
  /** False only for offline. Idle, do-not-disturb and invisible all count as away. */
  online: boolean;
}

/** A reaction change on a Discord message that we care about. */
export interface DiscordIncomingReaction {
  messageId: string;
  channelId: string;
  userId: string;
  userName: string;
  /** A unicode character, or the custom emoji's name. */
  emoji: string;
  /** The custom emoji id, or null for a unicode emoji. */
  emojiId: string | null;
  /** Whether a custom emoji is animated, so it can be learned as a gif. */
  animated: boolean;
}

/** Every reaction was cleared from a Discord message at once. */
export interface DiscordIncomingReactionsRemoved {
  messageId: string;
  channelId: string;
}

/** Minimal logger the bridge hands down to the transport. */
export interface BridgeLogger {
  info(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
}

export interface MirrorFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MirrorInput {
  discordChannelId: string;
  /** Cached webhook for the channel, if we have already created one. */
  webhook: WebhookRef | null;
  username: string;
  /** Absolute, publicly reachable avatar URL, or null to leave it default. */
  avatarUrl: string | null;
  /** Discord user ids allowed to be pinged by this message, usually none. */
  allowedUserMentions: string[];
  content: string;
  files: MirrorFile[];
}

export interface MirrorResult {
  messageId: string;
  /** The webhook that was used, which may have just been created. */
  webhook: WebhookRef;
}

export interface EditInput {
  webhook: WebhookRef;
  discordMessageId: string;
  content: string;
  /** Discord user ids allowed to be pinged by this edit, usually none. */
  allowedUserMentions: string[];
}

export interface DeleteInput {
  webhook: WebhookRef;
  discordMessageId: string;
}

export interface BotDeleteInput {
  /** Discord channel holding the message. */
  channelId: string;
  discordMessageId: string;
}

export interface ReactionInput {
  /** Discord channel holding the message. Reactions go through the bot, not the webhook. */
  channelId: string;
  discordMessageId: string;
  /**
   * Discord's emoji parameter, ready to drop into the URL: a percent-encoded
   * unicode character, or `name:id` (prefixed with `a:` when animated).
   */
  emoji: string;
}

/**
 * Everything the bridge needs from Discord, behind one small interface. The
 * real implementation wraps discord.js; tests substitute a fake so the
 * orchestration can be verified without a bot token.
 */
export interface DiscordTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): BridgeStatus;
  listTextChannels(): Promise<DiscordChannelListResponse>;
  onMessage(handler: (message: DiscordIncomingMessage) => void): void;
  onMessageEdited(handler: (message: DiscordIncomingEdit) => void): void;
  onMessageDeleted(handler: (message: DiscordIncomingDelete) => void): void;
  onReactionAdded(handler: (reaction: DiscordIncomingReaction) => void): void;
  onReactionRemoved(handler: (reaction: DiscordIncomingReaction) => void): void;
  /** Every reaction of one emoji was cleared from a message. */
  onReactionCleared(handler: (reaction: DiscordIncomingReaction) => void): void;
  /** Every reaction of every emoji was cleared from a message. */
  onReactionsRemovedAll(handler: (removed: DiscordIncomingReactionsRemoved) => void): void;
  /**
   * Who is online in the linked guild: once per member when the bot connects,
   * then whenever someone's status changes.
   */
  onPresence(handler: (presence: DiscordIncomingPresence) => void): void;
  mirror(input: MirrorInput): Promise<MirrorResult>;
  editMessage(input: EditInput): Promise<void>;
  deleteMessage(input: DeleteInput): Promise<void>;
  /**
   * Deletes a message through the bot rather than the webhook. A webhook can
   * only delete its own messages, so this is how a message somebody wrote on
   * Discord is removed when a moderator deletes it here.
   */
  deleteMessageAsBot(input: BotDeleteInput): Promise<void>;
  /** Custom emoji available in the guild, for translating `:name:` shortcodes. */
  guildEmojis(): Promise<DiscordEmoji[]>;
  addReaction(input: ReactionInput): Promise<void>;
  removeReaction(input: ReactionInput): Promise<void>;
  /** Fetches an attachment's bytes from the Discord CDN. */
  download(url: string): Promise<Buffer>;
  /**
   * A live, signed address for a Discord CDN link, through Discord's own refresh
   * endpoint, which signs any attachment address the bot may not otherwise be
   * able to reach. Null when the address cannot be refreshed.
   */
  refreshAttachmentUrl(url: string): Promise<string | null>;
  /**
   * The most recent messages in a Discord channel, oldest first, for backfilling
   * a newly linked channel. Bots and webhooks are included; the caller filters.
   */
  fetchRecentMessages(channelId: string, limit: number): Promise<DiscordIncomingMessage[]>;
}
