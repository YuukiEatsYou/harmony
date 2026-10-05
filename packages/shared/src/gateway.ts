import type { SavedMessage, User } from './types.ts';

/** Gateway opcodes, mirroring Discord's layout so tooling stays familiar. */
export const GatewayOp = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  Hello: 10,
  HeartbeatAck: 11,
} as const;
export type GatewayOpCode = (typeof GatewayOp)[keyof typeof GatewayOp];

/** Named dispatch events pushed from server to client. */
export const GatewayEvent = {
  Ready: 'READY',
  MessageCreate: 'MESSAGE_CREATE',
  MessageUpdate: 'MESSAGE_UPDATE',
  MessageDelete: 'MESSAGE_DELETE',
  MessageReactionAdd: 'MESSAGE_REACTION_ADD',
  MessageReactionRemove: 'MESSAGE_REACTION_REMOVE',
  MessageReactionsClear: 'MESSAGE_REACTIONS_CLEAR',
  TypingStart: 'TYPING_START',
  PresenceUpdate: 'PRESENCE_UPDATE',
  ChannelCreate: 'CHANNEL_CREATE',
  ChannelUpdate: 'CHANNEL_UPDATE',
  ChannelDelete: 'CHANNEL_DELETE',
  CategoryCreate: 'CATEGORY_CREATE',
  CategoryUpdate: 'CATEGORY_UPDATE',
  CategoryDelete: 'CATEGORY_DELETE',
  RoleCreate: 'ROLE_CREATE',
  RoleUpdate: 'ROLE_UPDATE',
  RoleDelete: 'ROLE_DELETE',
  MemberUpdate: 'MEMBER_UPDATE',
  EmojiCreate: 'EMOJI_CREATE',
  EmojiDelete: 'EMOJI_DELETE',
  RetentionApplied: 'RETENTION_APPLIED',
  SavedMessageUpdate: 'SAVED_MESSAGE_UPDATE',
  ScheduledMessageUpdate: 'SCHEDULED_MESSAGE_UPDATE',
  ChannelSettingsUpdate: 'CHANNEL_SETTINGS_UPDATE',
  PollUpdate: 'POLL_UPDATE',
  ServerGifsUpdate: 'SERVER_GIFS_UPDATE',
  EventUpdate: 'EVENT_UPDATE',
  EventReminder: 'EVENT_REMINDER',
  UpdateAvailable: 'UPDATE_AVAILABLE',
} as const;
export type GatewayEventName = (typeof GatewayEvent)[keyof typeof GatewayEvent];

/** WebSocket close codes used by the gateway (mirrors Discord's range). */
export const GatewayCloseCode = {
  /** The client never sent IDENTIFY. Reconnecting is fine. */
  NotAuthenticated: 4003,
  AuthenticationFailed: 4004,
  /** The session was ended by moderation (kicked or banned). */
  Removed: 4005,
  /** No heartbeat arrived in time, so the connection was presumed dead. Reconnecting is fine. */
  SessionTimedOut: 4009,
} as const;

/** Server -> client payload sent immediately on connect. */
export interface GatewayHello {
  /**
   * How often, in milliseconds, the client must send a heartbeat. A connection
   * that stays silent for about two intervals is closed with `SessionTimedOut`.
   */
  heartbeat_interval: number;
  gateway_version: number;
}

/** Client -> server payload that authenticates the connection. */
export interface GatewayIdentify {
  token: string;
}

/** First dispatch after a successful identify. */
export interface GatewayReady {
  user: User;
  gateway_version: number;
}

export interface MessageDeletePayload {
  id: string;
  channelId: string;
}

/**
 * One user's reaction being added or removed. Carries the reacting user so each
 * client can decide for itself whether the `me` badge applies, instead of the
 * server baking one viewer's perspective into a shared broadcast.
 */
export interface ReactionUpdatePayload {
  messageId: string;
  channelId: string;
  emoji: string;
  emojiId: string | null;
  userId: string;
  /** Total reactions for this emoji after the change. Zero means it is gone. */
  count: number;
}

/** Every reaction for one emoji was cleared from a message. */
export interface ReactionsClearPayload {
  messageId: string;
  channelId: string;
  emoji: string;
  emojiId: string | null;
}

/**
 * One of a member's own saves changed. It goes only to that member's sessions,
 * so their other tabs and devices follow along while nobody else learns of it.
 */
export interface SavedMessageUpdatePayload {
  messageId: string;
  channelId: string;
  /** The save as it now stands, or null once it was removed. */
  saved: SavedMessage | null;
}

export interface TypingStartPayload {
  channelId: string;
  user: User;
}

/**
 * Someone came online or went offline. Presence is ephemeral: it is derived from
 * live gateway connections and never stored.
 */
export interface PresenceUpdatePayload {
  user: User;
  online: boolean;
}

/**
 * A newer release is on the update branch. It is broadcast to everyone, but only
 * the owner acts on it; the versions are public information, so nothing is lost
 * by letting the others see it and ignore it.
 */
export interface UpdateAvailablePayload {
  running: string;
  latest: string;
}

/** Envelope for every gateway frame. */
export interface GatewayFrame<T = unknown> {
  op: GatewayOpCode;
  t?: GatewayEventName;
  d?: T;
}
