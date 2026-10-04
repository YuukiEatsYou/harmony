import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import type { Metadata } from 'sharp';
import {
  ALLOWED_IMAGE_TYPES,
  DEFAULT_MAX_EMOJI_BYTES,
  GatewayEvent,
  rewriteChannelMentions,
  rewriteMentions,
  unwrapSuppressedLinks,
  type BridgeResponse,
  type DiscordChannelListResponse,
  type ImageContentType,
  type Message,
  type MessageDeletePayload,
  type MessageReference,
  type PresenceUpdatePayload,
} from '@harmony/shared';
import type { Config } from '../config.ts';
import { insertAttachment } from '../db/attachments.ts';
import {
  deleteBridgeMessage,
  findBridgeMessageByDiscordId,
  findBridgeMessageByHarmonyId,
  hasSeenBridgeMessage,
  insertBridgeMessage,
  rememberBridgeMessage,
} from '../db/bridge.ts';
import { findChannel, findChannelByDiscordId, listChannels, setChannelWebhook, type ChannelRow } from '../db/channels.ts';
import {
  findEmoji,
  findEmojiByDiscordId,
  findEmojiByName,
  insertEmoji,
  toEmoji,
  touchEmojiUsed,
  type EmojiRow,
} from '../db/emojis.ts';
import { findMessage } from '../db/messages.ts';
import { countLocalReaction, listReactionsForMessages } from '../db/reactions.ts';
import {
  findStickerByDiscordId,
  insertSticker,
  touchStickerUsed,
  type StickerRow,
} from '../db/stickers.ts';
import {
  findUserByDiscordId,
  findUserById,
  findUserByUsername,
  insertGhostUser,
  presentUser,
  updateUserProfile,
  type UserRow,
} from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { MessageService, ReactionEvent } from '../messages/service.ts';
import type { GatewayHub } from '../realtime/hub.ts';
import type { SettingsService } from '../settings/service.ts';
import type { UserService } from '../users/service.ts';
import { createBlobStore } from '../storage/blobs.ts';
import {
  DISCORD_MAX_CONTENT,
  type BridgeLogger,
  type DiscordEmoji,
  type DiscordIncomingAttachment,
  type DiscordIncomingDelete,
  type DiscordIncomingEdit,
  type DiscordIncomingMessage,
  type DiscordIncomingPresence,
  type DiscordIncomingReaction,
  type DiscordIncomingReactionsRemoved,
  type DiscordIncomingSticker,
  type DiscordMention,
  type DiscordTransport,
  type MirrorFile,
  type MirrorResult,
  type WebhookRef,
} from './transport.ts';

/** Discord's default upload ceiling for a non-boosted server. */
const DISCORD_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** A sticker never needs to be larger than this; Discord caps them well under it. */
const STICKER_MAX_BYTES = 1024 * 1024;

/** Discord sticker formats: Lottie is a vector graphic, GIF is an animation. */
const STICKER_FORMAT_LOTTIE = 3;
const STICKER_FORMAT_GIF = 4;

/**
 * Ends an edit that no longer fits in one Discord message. Only the first part
 * of a split message is ours to edit, so whatever is cut is left to Harmony.
 */
const DISCORD_SHORTENED_MARKER = '… *(continued in Harmony)*';

/** Marks a message that was forwarded on Discord rather than written there. */
const FORWARDED_MARKER = '*Forwarded*';

/** A pasted Discord sticker link, as the client's "copy link" produces it. */
const STICKER_LINK =
  /https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/stickers\/(\d+)\.(png|gif)(?:\?[^\s]*)?/gi;

export interface BridgeService {
  status(): BridgeResponse;
  /** Starts, stops or restarts the bot to match the saved settings. */
  applySettings(): Promise<void>;
  listDiscordChannels(): Promise<DiscordChannelListResponse>;
  /** Custom emoji in the linked guild, for the emoji import. */
  listGuildEmojis(): Promise<{ guildName: string | null; emojis: DiscordEmoji[] }>;
  /** Downloads one guild emoji's image from the Discord CDN. */
  downloadGuildEmoji(id: string, animated: boolean): Promise<{ data: Buffer; contentType: ImageContentType }>;
  /** Pulls recent Discord history into a bridged channel; returns how many. */
  importChannel(channelId: string, limit?: number): Promise<number>;
  /**
   * A live, signed address for a Discord CDN link, through Discord's own refresh
   * endpoint. Null when the bridge is down or the address cannot be refreshed.
   */
  refreshDiscordAttachment(url: string): Promise<string | null>;
  /** Sends a test message so an admin can verify a mapping and see any error. */
  testMirror(channelId: string): Promise<void>;
  /**
   * The Discord accounts the linked guild currently reports as online, by Discord
   * id. Empty while the bridge is down, because we can only see what Discord is
   * telling us right now.
   */
  onlineDiscordIds(): Set<string>;
  shutdown(): Promise<void>;
}

export interface BridgeDeps {
  sqlite: DatabaseSync;
  config: Config;
  settings: SettingsService;
  messages: MessageService;
  users: UserService;
  hub: GatewayHub;
  logger: BridgeLogger;
  transportFactory: (token: string, logger: BridgeLogger) => DiscordTransport;
  /**
   * Called with each message the bridge creates, so a link preview can resolve
   * for it too. Whatever it does must not notify the outbound listeners, or the
   * preview would mirror itself back to Discord.
   */
  resolvePreview?: (messageId: string, content: string) => void;
}

export function createBridgeService(deps: BridgeDeps): BridgeService {
  const { logger } = deps;
  const blobs = createBlobStore(deps.config);
  let transport: DiscordTransport | null = null;
  let activeToken: string | null = null;

  function status(): BridgeResponse {
    const config = deps.settings.getBridgePublic();
    return {
      configured: config.configured,
      enabled: config.enabled,
      publicBaseUrl: config.publicBaseUrl,
      status: transport?.status() ?? { ready: false, botTag: null, guildName: null, error: null },
    };
  }

  function webhookFor(channel: ChannelRow): WebhookRef | null {
    return channel.discord_webhook_id && channel.discord_webhook_token
      ? { id: channel.discord_webhook_id, token: channel.discord_webhook_token }
      : null;
  }

  function authorName(message: Message): string {
    return message.author?.displayName ?? message.author?.username ?? 'Harmony';
  }

  /**
   * The Discord accounts the linked guild currently reports as not offline, by
   * Discord id. Filled in by the bridge only and never stored, so a restart
   * starts everybody offline again, exactly like Harmony's own presence.
   */
  const discordOnline = new Set<string>();

  /** Tells clients that one stand-in account came online or went away. */
  function announceDiscordPresence(discordId: string, online: boolean): void {
    const row = findUserByDiscordId(deps.sqlite, discordId);
    if (!row) return;
    const payload: PresenceUpdatePayload = { user: presentUser(deps.sqlite, row), online };
    deps.hub.dispatch(GatewayEvent.PresenceUpdate, payload);
  }

  /**
   * Records one Discord presence. Nothing is announced for somebody we have no
   * stand-in account for: a guild's presence list covers every member of the
   * Discord server, and inventing an account for each of them would bury the real
   * members. The id is remembered all the same, so an account created later
   * already knows whether its owner was around.
   */
  function applyDiscordPresence(presence: DiscordIncomingPresence): void {
    if (discordOnline.has(presence.userId) === presence.online) return;

    if (presence.online) discordOnline.add(presence.userId);
    else discordOnline.delete(presence.userId);

    announceDiscordPresence(presence.userId, presence.online);
  }

  /**
   * Forgets everything the bridge knew about Discord, telling clients that every
   * stand-in account went offline. Used when the bot stops, so a departed bot
   * does not leave green dots behind for a guild we can no longer see.
   */
  function forgetDiscordPresence(): void {
    for (const discordId of discordOnline) announceDiscordPresence(discordId, false);
    discordOnline.clear();
  }

  /**
   * Replaces `:name:` shortcodes with the real `<:name:id>` tags Discord renders,
   * using the guild's emoji of the same name. Unknown shortcodes are left alone.
   */
  async function translateOutboundEmoji(text: string): Promise<string> {
    const map = await discordEmojiMap();
    if (map.size === 0) return text;
    return text.replace(/:([a-zA-Z0-9_]{2,32}):/g, (whole, name: string) => {
      const emoji = map.get(name);
      return emoji ? `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>` : whole;
    });
  }

  /**
   * Seeing a learned emoji again counts as using it, so it is kept from ageing
   * out while it is still being sent. The instance's own emoji carry no Discord
   * id and are never touched. Writing at most once an hour keeps a busy channel
   * from writing on every message, which the day-scale rule does not need.
   */
  function touchLearnedEmoji(row: EmojiRow): void {
    if (row.discord_id === null) return;
    const usedAt = Date.parse(row.used_at ?? row.created_at);
    if (Number.isFinite(usedAt) && Date.now() - usedAt < 3_600_000) return;
    touchEmojiUsed(deps.sqlite, row.id);
  }

  /**
   * Makes sure an emoji a Discord message refers to can be rendered here, and
   * returns the name to use for it, or null when it cannot be fetched. An emoji
   * this instance already has under that name is reused, whether it was imported
   * from the guild or learned earlier. Anything else is downloaded from Discord's
   * own emoji CDN by id - this is how an emoji from another server gets to show
   * up here.
   */
  async function ensureExternalEmoji(
    active: DiscordTransport,
    id: string,
    name: string,
    animated: boolean,
  ): Promise<string | null> {
    const byDiscordId = findEmojiByDiscordId(deps.sqlite, id);
    if (byDiscordId) {
      touchLearnedEmoji(byDiscordId);
      return byDiscordId.name;
    }
    // A name already taken is reused rather than duplicated, the same rule the
    // guild import follows. It is what keeps a tag naming an emoji imported from
    // the guild, or learned from an earlier message, pointing at one picture.
    const byName = findEmojiByName(deps.sqlite, name);
    if (byName) {
      touchLearnedEmoji(byName);
      return byName.name;
    }

    try {
      const data = await active.download(`https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}`);
      if (data.length > DEFAULT_MAX_EMOJI_BYTES) return null;
      const metadata = await sharp(data).metadata();
      const isAnimated = (metadata.pages ?? 1) > 1;
      const now = new Date().toISOString();
      const emojiId = randomUUID();
      insertEmoji(deps.sqlite, {
        id: emojiId,
        name,
        hash: blobs.save(data),
        contentType: isAnimated ? 'image/gif' : 'image/png',
        animated: isAnimated,
        createdBy: null,
        createdAt: now,
        discordId: id,
        usedAt: now,
      });
      // Clients keep their own list of emoji and only refetch it when told to,
      // so without this the message that taught us the emoji would show its
      // shortcode as text for everyone already connected.
      const learned = findEmoji(deps.sqlite, emojiId);
      if (learned) deps.hub.dispatch(GatewayEvent.EmojiCreate, toEmoji(learned));
      return name;
    } catch (error) {
      logger.debug('could not learn a discord emoji', {
        emojiId: id,
        name,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Makes sure a sticker a Discord message carried can be rendered here, and
   * returns the sticker's Harmony id, or null when it cannot be fetched. A
   * sticker is a shared asset: the same one sent again reuses the row rather
   * than being stored twice. Lottie stickers are vector graphics rather than
   * pictures and cannot be drawn as one, so they are left to the caller's
   * fallback.
   */
  async function ensureSticker(active: DiscordTransport, sticker: DiscordIncomingSticker): Promise<string | null> {
    const existing = findStickerByDiscordId(deps.sqlite, sticker.id);
    if (existing) {
      touchStickerRow(existing);
      return existing.id;
    }
    if (sticker.formatType === STICKER_FORMAT_LOTTIE) return null;

    // PNG and APNG stickers are served as .png; only GIF ones use .gif.
    const extension = sticker.formatType === STICKER_FORMAT_GIF ? 'gif' : 'png';
    try {
      const data = await active.download(`https://cdn.discordapp.com/stickers/${sticker.id}.${extension}`);
      if (data.length > STICKER_MAX_BYTES) return null;
      const metadata = await sharp(data).metadata();
      const isAnimated = (metadata.pages ?? 1) > 1;
      const now = new Date().toISOString();
      const id = randomUUID();
      insertSticker(deps.sqlite, {
        id,
        discordStickerId: sticker.id,
        name: sticker.name,
        hash: blobs.save(data),
        contentType: extension === 'gif' || isAnimated ? 'image/gif' : 'image/png',
        animated: isAnimated,
        createdAt: now,
        usedAt: now,
      });
      return id;
    } catch (error) {
      logger.debug('could not learn a discord sticker', {
        stickerId: sticker.id,
        name: sticker.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Seeing a sticker again counts as using it, at most once an hour. */
  function touchStickerRow(row: StickerRow): void {
    const usedAt = Date.parse(row.used_at);
    if (Number.isFinite(usedAt) && Date.now() - usedAt < 3_600_000) return;
    touchStickerUsed(deps.sqlite, row.id);
  }

  /** The sticker name a copy-link URL carries in its `name` query, if any. */
  function stickerNameFromLink(url: string): string | null {
    const start = url.indexOf('?');
    if (start === -1) return null;
    for (const pair of url.slice(start + 1).split('&')) {
      const [key, value] = pair.split('=');
      if (key !== 'name' || !value) continue;
      try {
        // A query encodes spaces as `+`, which decodeURIComponent leaves alone.
        return decodeURIComponent(value.replace(/\+/g, ' '));
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Turns a pasted Discord sticker link into the sticker itself, the same as a
   * real sticker send, so it renders instead of sitting there as a URL. The id
   * in the link is what identifies the sticker; the name in its query, when
   * present, is the sticker's own. A link whose sticker cannot be fetched is
   * left in the text rather than dropped.
   */
  async function learnLinkedStickers(
    active: DiscordTransport,
    text: string,
  ): Promise<{ ids: string[]; text: string }> {
    if (!text.includes('/stickers/')) return { ids: [], text };
    const ids: string[] = [];
    let result = '';
    let cursor = 0;

    for (const match of text.matchAll(STICKER_LINK)) {
      const whole = match[0];
      const id = match[1] ?? '';
      const index = match.index ?? 0;
      result += text.slice(cursor, index);
      cursor = index + whole.length;

      const stored = await ensureSticker(active, {
        id,
        name: stickerNameFromLink(whole) ?? `sticker_${id}`,
        formatType: match[2]?.toLowerCase() === 'gif' ? STICKER_FORMAT_GIF : 1,
      });
      if (stored) ids.push(stored);
      else result += whole;
    }

    return { ids, text: result + text.slice(cursor) };
  }

  /**
   * Turns Discord's `<:name:id>` and `<a:name:id>` tags back into `:name:`
   * shortcodes. A tag naming an emoji this instance has renders directly; a tag
   * naming one it does not - an emoji from another server - is learned first by
   * its id, so it renders too. Only if that fails does it fall back to a plain
   * shortcode, which at least reads better than a raw id.
   */
  async function translateInboundEmoji(text: string): Promise<string> {
    if (!text.includes('<')) return text;
    const active = transport;
    let result = '';
    let cursor = 0;

    for (const match of text.matchAll(/<a?:([a-zA-Z0-9_]{2,32}):(\d+)>/g)) {
      const whole = match[0];
      const name = match[1] ?? '';
      const id = match[2] ?? '';
      const index = match.index ?? 0;
      result += text.slice(cursor, index);
      cursor = index + whole.length;

      const existing = findEmojiByName(deps.sqlite, name);
      if (existing) {
        touchLearnedEmoji(existing);
        result += `:${existing.name}:`;
        continue;
      }
      const learned = active ? await ensureExternalEmoji(active, id, name, whole.startsWith('<a:')) : null;
      result += `:${learned ?? name}:`;
    }

    return result + text.slice(cursor);
  }

  /**
   * Rewrites Discord's `<@id>` and `<@!id>` mentions into Harmony `@username`
   * mentions, creating a stand-in account for anyone we have not seen before so
   * the mention always resolves. Unknown ids are left alone.
   */
  function rewriteInboundMentions(content: string, mentions: DiscordMention[]): string {
    if (mentions.length === 0) return content;

    const usernames = new Map<string, string>();
    for (const mention of mentions) {
      usernames.set(mention.id, resolveGhostUser(mention.id, mention.name).username);
    }

    return content.replace(/<@!?(\d+)>/g, (whole, discordId: string) => {
      const username = usernames.get(discordId);
      return username ? `@${username}` : whole;
    });
  }

  /**
   * Discord's `<#id>` channel mention becomes a Harmony `#name` when that channel
   * is bridged here, so it reads as a channel to click. A mention of a Discord
   * channel we do not mirror is left alone, the same as an unknown user mention.
   */
  function rewriteInboundChannelMentions(content: string): string {
    if (!content.includes('<#')) return content;
    return content.replace(/<#(\d+)>/g, (whole, discordId: string) => {
      const channel = findChannelByDiscordId(deps.sqlite, discordId);
      return channel ? `#${channel.name}` : whole;
    });
  }

  /**
   * Discord webhooks cannot post real replies (Execute Webhook has no
   * message_reference), so a reply is mirrored as a quoted line above the text.
   * Discord renders `> ` as a blockquote, which reads like a reply.
   */
  async function outboundContent(
    message: Message,
  ): Promise<{ content: string; allowedUserMentions: string[] }> {
    const { text, discordIds } = rewriteOutboundMentions(message.content.trim());
    const withChannels = rewriteOutboundChannelMentions(text);
    const translated = await translateOutboundEmoji(withChannels);
    const reply = message.replyTo;
    const content = reply ? `${quoteFor(reply)}\n${translated}`.trim() : translated;
    return { content, allowedUserMentions: discordIds };
  }

  /**
   * A `@username` that belongs to a bridged stand-in account becomes a real
   * `<@id>` ping; a mention of someone with no Discord account is left as plain
   * text so it still reads sensibly.
   */
  function rewriteOutboundMentions(text: string): { text: string; discordIds: string[] } {
    const discordIds: string[] = [];
    const rewritten = rewriteMentions(text, (username) => {
      const row = findUserByUsername(deps.sqlite, username);
      if (!row?.discord_id) return null;
      if (!discordIds.includes(row.discord_id)) discordIds.push(row.discord_id);
      return `<@${row.discord_id}>`;
    });
    return { text: rewritten, discordIds };
  }

  /**
   * A `#channel` naming a bridged Harmony channel becomes a real Discord channel
   * mention, `<#id>`, so it reads as a channel and links on the other side. A
   * reference to a channel with no Discord counterpart is left as plain text.
   */
  function rewriteOutboundChannelMentions(text: string): string {
    const bridged = listChannels(deps.sqlite).filter((channel) => channel.discord_channel_id);
    if (bridged.length === 0) return text;

    const byName = new Map(
      bridged.map((channel) => [channel.name.toLowerCase(), channel.discord_channel_id as string]),
    );
    return rewriteChannelMentions(text, bridged.map((channel) => channel.name), (name) => {
      const discordId = byName.get(name.toLowerCase());
      return discordId ? `<#${discordId}>` : null;
    });
  }

  function quoteFor(reply: MessageReference): string {
    const who = reply.author?.displayName ?? reply.author?.username ?? 'someone';
    const snippet = reply.deleted
      ? '(deleted message)'
      : reply.content.replace(/\s+/g, ' ').trim().slice(0, 120);
    return `> **${who}**${snippet ? `: ${snippet}` : ''}`;
  }

  /**
   * Finds the stand-in account for a Discord author, creating it on first sight.
   * With `refreshName`, a stand-in's name follows a change on Discord. Only a
   * message's author asks for that: a reaction only knows the account's global
   * name, not the one the person goes by in the guild, and would flip the name
   * back and forth. A member who linked their own account chose their name here,
   * so theirs is never touched.
   */
  function resolveGhostUser(discordId: string, displayName: string, refreshName = false): UserRow {
    const existing = findUserByDiscordId(deps.sqlite, discordId);
    if (existing) {
      if (!refreshName || existing.is_bot !== 1 || !displayName || existing.display_name === displayName) {
        return existing;
      }
      updateUserProfile(deps.sqlite, existing.id, { displayName });
      // Clients refetch the member list on this, so the new name shows up
      // without a reload.
      deps.hub.dispatch(GatewayEvent.MemberUpdate, { userId: existing.id });
      return findUserByDiscordId(deps.sqlite, discordId) ?? existing;
    }

    const id = randomUUID();
    insertGhostUser(deps.sqlite, {
      id,
      // Never shown: the display name carries what users actually see.
      username: `discord_${discordId}`,
      displayName,
      discordId,
      createdAt: new Date().toISOString(),
    });

    const created = findUserByDiscordId(deps.sqlite, discordId);
    if (!created) throw new Error('Failed to create the bridged user');
    return created;
  }

  // The guild's custom emoji, resolved by name so `:name:` can be translated to
  // a real Discord `<:name:id>` tag. Cached until the bridge reconnects.
  let guildEmojiByName: Map<string, DiscordEmoji> | null = null;

  async function discordEmojiMap(): Promise<Map<string, DiscordEmoji>> {
    if (guildEmojiByName) return guildEmojiByName;
    if (!transport) return new Map();
    try {
      guildEmojiByName = new Map((await transport.guildEmojis()).map((emoji) => [emoji.name, emoji]));
    } catch (error) {
      logger.debug('could not list discord emojis', {
        error: error instanceof Error ? error.message : String(error),
      });
      guildEmojiByName = new Map();
    }
    return guildEmojiByName;
  }

  /**
   * Discord's emoji parameter for a reaction: a percent-encoded unicode
   * character, or `name:id` (with an `a:` prefix when animated) using the
   * guild's emoji. Returns null when a custom emoji has no counterpart.
   */
  async function discordReactionParam(emoji: string): Promise<string | null> {
    if (!emoji.startsWith(':')) return encodeURIComponent(emoji);
    const target = (await discordEmojiMap()).get(emoji.slice(1, -1));
    return target ? `${target.animated ? 'a:' : ''}${target.name}:${target.id}` : null;
  }

  // ---- Outbound: Harmony -> Discord ----

  /**
   * Absolute avatar URL that Discord can fetch, or null when we do not know our
   * own public address or the author has no picture. The hash doubles as the
   * capability that lets Discord in without a session.
   */
  function avatarUrlFor(message: Message): string | null {
    const base = deps.settings.getBridge().publicBaseUrl;
    const user = message.author;
    if (!base || !user?.avatarHash) return null;
    return `${base.replace(/\/+$/, '')}/api/v1/users/${user.id}/avatar?v=${user.avatarHash}`;
  }

  /**
   * Cuts text into pieces Discord accepts. Harmony allows longer messages than
   * Discord does, and cutting one short would lose the rest without a word. A
   * piece breaks at a line if it can, then at a space, so a word is only split
   * down the middle when there is no other choice.
   */
  function splitForDiscord(text: string): string[] {
    const parts: string[] = [];
    let rest = text;
    while (rest.length > DISCORD_MAX_CONTENT) {
      const window = rest.slice(0, DISCORD_MAX_CONTENT);
      // A break too near the start would leave a sliver of a message behind.
      const floor = DISCORD_MAX_CONTENT / 2;
      let cut = window.lastIndexOf('\n');
      if (cut < floor) cut = window.lastIndexOf(' ');
      if (cut < floor) {
        cut = DISCORD_MAX_CONTENT;
        // Never split an emoji or other character outside the basic plane.
        const last = rest.charCodeAt(cut - 1);
        if (last >= 0xd800 && last <= 0xdbff) cut--;
      }
      parts.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).replace(/^[\n ]/, '');
    }
    parts.push(rest);
    return parts.filter((part) => part.trim().length > 0);
  }

  /** Shortens an edit to what fits in the one Discord message it can change. */
  function fitForDiscord(text: string): string {
    if (text.length <= DISCORD_MAX_CONTENT) return text;
    return `${text.slice(0, DISCORD_MAX_CONTENT - DISCORD_SHORTENED_MARKER.length).trimEnd()}${DISCORD_SHORTENED_MARKER}`;
  }

  /**
   * Shared by normal mirroring and the admin's test message. Text too long for
   * one Discord message goes out as several, the files riding on the first. The
   * first is the one the result names, and so the one later edits, deletions and
   * reactions reach; the rest are only remembered, so they are never mistaken
   * for something said on Discord.
   */
  async function sendToDiscord(
    channel: ChannelRow,
    username: string,
    content: string,
    files: MirrorFile[],
    avatarUrl: string | null,
    allowedUserMentions: string[],
  ): Promise<MirrorResult> {
    if (!transport) {
      throw new HttpError(400, 'bridge_offline', 'The bridge is not connected. Save a token and enable it.');
    }
    if (!channel.discord_channel_id) {
      throw new HttpError(400, 'channel_not_bridged', 'That channel is not linked to a Discord channel.');
    }

    const [first = '', ...rest] = splitForDiscord(content);
    const result = await transport.mirror({
      discordChannelId: channel.discord_channel_id,
      webhook: webhookFor(channel),
      username,
      avatarUrl,
      allowedUserMentions,
      content: first,
      files,
    });
    setChannelWebhook(deps.sqlite, channel.id, result.webhook.id, result.webhook.token);

    for (const part of rest) {
      const continued = await transport.mirror({
        discordChannelId: channel.discord_channel_id,
        webhook: result.webhook,
        username,
        avatarUrl,
        allowedUserMentions,
        content: part,
        files: [],
      });
      rememberBridgeMessage(deps.sqlite, continued.messageId, new Date().toISOString());
    }
    return result;
  }

  function collectMirrorFiles(message: Message): MirrorFile[] {
    const files: MirrorFile[] = [];
    for (const attachment of message.attachments) {
      // A picture the server fetched out of the message's own text is not ours
      // to send: the link is right there in the content, and Discord unfurls
      // those itself, so uploading a copy would show the same gif twice.
      if (attachment.sourceUrl !== null) continue;
      if (attachment.size > DISCORD_MAX_FILE_BYTES) {
        logger.debug('skipping an attachment too large for discord', {
          filename: attachment.filename,
          size: attachment.size,
        });
        continue;
      }
      try {
        files.push({
          filename: attachment.filename,
          contentType: attachment.contentType,
          data: readFileSync(blobs.pathFor(attachment.hash)),
        });
      } catch (error) {
        logger.debug('could not read an attachment blob', {
          filename: attachment.filename,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return files;
  }

  async function mirror(message: Message): Promise<void> {
    if (!transport) return;

    const channel = findChannel(deps.sqlite, message.channelId);
    if (!channel?.discord_channel_id) {
      logger.debug('not mirroring: channel is not bridged', { channelId: message.channelId });
      return;
    }

    const { content, allowedUserMentions } = await outboundContent(message);
    const files = collectMirrorFiles(message);
    if (!content && files.length === 0) {
      logger.debug('not mirroring: message has no text or files', { channelId: message.channelId });
      return;
    }

    const result = await sendToDiscord(
      channel,
      authorName(message),
      content,
      files,
      avatarUrlFor(message),
      allowedUserMentions,
    );
    insertBridgeMessage(deps.sqlite, {
      harmonyMessageId: message.id,
      discordMessageId: result.messageId,
      createdAt: new Date().toISOString(),
    });
    // Our own webhook message is accounted for too, so it is never mistaken for
    // something a member said if it is ever fetched back.
    rememberBridgeMessage(deps.sqlite, result.messageId, new Date().toISOString());
  }

  /** Where a bridged Harmony message lives on the Discord side, if anywhere. */
  function mirrorTarget(harmonyMessageId: string, channelId: string) {
    const mapping = findBridgeMessageByHarmonyId(deps.sqlite, harmonyMessageId);
    if (!mapping) return null;

    const channel = findChannel(deps.sqlite, channelId);
    if (!channel) return null;

    const webhook = webhookFor(channel);
    if (!webhook) return null;

    return { webhook, discordMessageId: mapping.discord_message_id };
  }

  async function mirrorEdit(message: Message): Promise<void> {
    if (!transport) return;
    const target = mirrorTarget(message.id, message.channelId);
    if (!target) return;

    const { content, allowedUserMentions } = await outboundContent(message);
    await transport.editMessage({
      webhook: target.webhook,
      discordMessageId: target.discordMessageId,
      content: fitForDiscord(content),
      allowedUserMentions,
    });
  }

  /**
   * Removes a deleted message's Discord counterpart. Our webhook can delete only
   * what it posted itself, so a message somebody wrote on Discord - a stand-in's,
   * or a linked member's when the webhook refuses - is deleted by the bot. The
   * mapping goes either way: the Harmony message is gone, and a mapping left
   * behind would have every later attempt fail the same way.
   */
  async function mirrorDelete(info: MessageDeletePayload): Promise<void> {
    const active = transport;
    if (!active) return;
    const mapping = findBridgeMessageByHarmonyId(deps.sqlite, info.id);
    if (!mapping) return;

    try {
      const channel = findChannel(deps.sqlite, info.channelId);
      if (!channel?.discord_channel_id) return;

      const row = findMessage(deps.sqlite, info.id);
      const author = row?.author_id ? findUserById(deps.sqlite, row.author_id) : null;
      const webhook = webhookFor(channel);
      if (webhook && author?.is_bot !== 1) {
        try {
          await active.deleteMessage({ webhook, discordMessageId: mapping.discord_message_id });
          return;
        } catch (error) {
          logger.debug('the webhook could not delete a message, asking the bot', {
            discordMessageId: mapping.discord_message_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await active.deleteMessageAsBot({
        channelId: channel.discord_channel_id,
        discordMessageId: mapping.discord_message_id,
      });
    } finally {
      deleteBridgeMessage(deps.sqlite, info.id);
    }
  }

  /**
   * Where a bridged Harmony message lives on the Discord side, for reactions.
   * Reactions cannot use the webhook (Discord has no such route), so they need
   * the channel id and go through the bot.
   */
  function reactionTarget(
    harmonyMessageId: string,
    channelId: string,
  ): { discordChannelId: string; discordMessageId: string } | null {
    const mapping = findBridgeMessageByHarmonyId(deps.sqlite, harmonyMessageId);
    if (!mapping) return null;

    const channel = findChannel(deps.sqlite, channelId);
    if (!channel?.discord_channel_id) return null;

    return { discordChannelId: channel.discord_channel_id, discordMessageId: mapping.discord_message_id };
  }

  /**
   * Mirrors a reaction change out to Discord. Reactions are placed by the bot,
   * because Discord has no webhook reaction route. Since the bot can only hold
   * one reaction per emoji, it represents the whole Harmony tally: it is added
   * when the first person reacts and removed only once the last one does.
   */
  async function mirrorReaction(event: ReactionEvent, kind: 'add' | 'remove' | 'clear'): Promise<void> {
    if (!transport) return;
    const target = reactionTarget(event.message.id, event.message.channelId);
    if (!target) return;

    // For a removal, keep the bot's reaction while others remain in Harmony.
    // Discord users' own reactions are stored here under their stand-ins too, but
    // those are theirs on Discord already; only Harmony's reactors are what the
    // bot is standing in for.
    if (kind !== 'add' && countLocalReaction(deps.sqlite, event.message.id, event.emoji) > 0) return;

    const emoji = await discordReactionParam(event.emoji);
    if (!emoji) {
      logger.debug('not mirroring a reaction: no matching discord emoji', { emoji: event.emoji });
      return;
    }

    const input = { channelId: target.discordChannelId, discordMessageId: target.discordMessageId, emoji };
    if (kind === 'add') await transport.addReaction(input);
    else await transport.removeReaction(input);
  }

  // ---- Inbound: Discord -> Harmony ----

  async function storeInboundAttachment(
    active: DiscordTransport,
    author: UserRow,
    attachment: DiscordIncomingAttachment,
  ): Promise<string | null> {
    const isVideo = attachment.contentType.startsWith('video/');
    if (!isVideo && !ALLOWED_IMAGE_TYPES.includes(attachment.contentType as ImageContentType)) return null;

    // Discord may hand us any video container; clips are stored as they are and
    // it is left to the viewer's browser which formats it can play.
    const limits = deps.settings.get();
    const limit = isVideo ? limits.maxVideoBytes : limits.maxImageBytes;
    if (attachment.size > limit) return null;

    try {
      const data = await active.download(attachment.url);
      if (data.length > limit) return null;

      let width: number | null = null;
      let height: number | null = null;
      if (!isVideo) {
        let metadata: Metadata;
        try {
          metadata = await sharp(data).metadata();
        } catch {
          return null; // Not a real image.
        }
        width = metadata.width ?? null;
        height = metadata.height ?? null;
      }

      const id = randomUUID();
      insertAttachment(deps.sqlite, {
        id,
        uploaderId: author.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: data.length,
        width,
        height,
        hash: blobs.save(data),
        createdAt: new Date().toISOString(),
      });
      return id;
    } catch (error) {
      logger.debug('could not mirror a discord attachment', {
        url: attachment.url,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Imports a Discord author's picture the first time we see one, so bridged
   * users show their real avatar. Skipped once they have one, to avoid
   * re-downloading on every message.
   */
  async function mirrorGhostAvatar(
    active: DiscordTransport,
    author: UserRow,
    message: DiscordIncomingMessage,
  ): Promise<void> {
    if (author.avatar_hash || !message.authorAvatarUrl) return;
    try {
      const data = await active.download(message.authorAvatarUrl);
      await deps.users.setAvatarFromData(author.id, data);
    } catch (error) {
      logger.debug('could not mirror a discord avatar', {
        authorId: message.authorId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Discord messages being ingested right now. The permanent record below is
   * only written once a message is stored, after its downloads, so a live event
   * and a history import of the same message could both get past it meanwhile.
   */
  const ingesting = new Set<string>();

  async function ingest(message: DiscordIncomingMessage, silent = false): Promise<boolean> {
    if (ingesting.has(message.id)) return false;
    ingesting.add(message.id);
    try {
      return await ingestOnce(message, silent);
    } finally {
      ingesting.delete(message.id);
    }
  }

  async function ingestOnce(message: DiscordIncomingMessage, silent: boolean): Promise<boolean> {
    const active = transport;
    // Ignore bots, including our own mirrored webhook messages.
    if (!active || message.fromBot) return false;
    // Already accounted for: a backfill may meet a message whose Harmony copy was
    // deleted or pruned. The permanent record answers that even when the mapping
    // is gone, so removed content is not brought back.
    if (hasSeenBridgeMessage(deps.sqlite, message.id)) return false;

    const channel = findChannelByDiscordId(deps.sqlite, message.channelId);
    if (!channel) return false;

    const author = resolveGhostUser(message.authorId, message.authorName, true);
    await mirrorGhostAvatar(active, author, message);

    const attachmentIds: string[] = [];
    const skipped: string[] = [];
    for (const attachment of message.attachments) {
      const stored = await storeInboundAttachment(active, author, attachment);
      if (stored) attachmentIds.push(stored);
      else skipped.push(attachment.url);
    }

    // A sticker is a shared asset, learned by its Discord id. One that cannot be
    // fetched - a Lottie vector, or a download that failed - is kept as its name
    // rather than dropped, the same way an unmirrorable attachment becomes a link.
    const stickerIds: string[] = [];
    for (const sticker of message.stickers) {
      const stored = await ensureSticker(active, sticker);
      if (stored) stickerIds.push(stored);
      else skipped.push(sticker.name);
    }
    if (message.stickers.length > 0) {
      logger.debug('bridge read stickers off a message', {
        messageId: message.id,
        sent: message.stickers.length,
        stored: stickerIds.length,
      });
    }

    // A pasted sticker link becomes the sticker, so it renders like a send rather
    // than sitting there as a URL.
    const linked = await learnLinkedStickers(active, message.content);
    stickerIds.push(...linked.ids);

    // Anything we cannot mirror is preserved as text rather than dropped: an
    // attachment that will not download as its link, a sticker that cannot be
    // drawn as its name. Discord hides the preview of a suppressed link by
    // wrapping it in angle brackets; drop them so the link unfurls here exactly
    // as a typed one does. Emoji are learned above, so one from another server
    // renders rather than falling back.
    const translated = await translateInboundEmoji(linked.text);
    const said = [
      rewriteInboundChannelMentions(
        rewriteInboundMentions(unwrapSuppressedLinks(translated), message.mentions),
      ),
      ...skipped,
    ]
      .filter((part) => part.trim().length > 0)
      .join('\n');
    if (!said && attachmentIds.length === 0 && stickerIds.length === 0) return false;
    // A forward carries someone else's words, so it says so, as Discord does.
    const content = message.forwarded ? `${FORWARDED_MARKER}\n${said}`.trim() : said;

    // A Discord reply becomes a real Harmony reply when the parent was bridged.
    // One whose parent has since been deleted here simply arrives as a message.
    const replyToId = message.replyToDiscordId
      ? (findBridgeMessageByDiscordId(deps.sqlite, message.replyToDiscordId)?.harmony_message_id ?? null)
      : null;

    const created = deps.messages.createBridged(
      channel.id,
      author.id,
      content,
      attachmentIds,
      replyToId,
      { createdAt: message.createdAt, silent, stickerIds },
    );
    insertBridgeMessage(deps.sqlite, {
      harmonyMessageId: created.id,
      discordMessageId: message.id,
      createdAt: new Date().toISOString(),
    });
    rememberBridgeMessage(deps.sqlite, message.id, new Date().toISOString());
    // A link posted on Discord previews here too, exactly as if it were typed here.
    deps.resolvePreview?.(created.id, content);
    return true;
  }

  /** How many recent Discord messages a plain backfill pulls in. */
  const HISTORY_IMPORT_LIMIT = 50;

  /**
   * Pulls recent Discord history into a bridged channel. Messages already known
   * are skipped by their Discord id, so this is safe to run on every link, on
   * startup and on demand.
   */
  async function importChannel(channelId: string, requestedLimit?: number): Promise<number> {
    const active = transport;
    if (!active) {
      throw new HttpError(400, 'bridge_offline', 'The bridge is not connected. Save a token and enable it.');
    }

    const channel = findChannel(deps.sqlite, channelId);
    if (!channel) throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');
    if (!channel.discord_channel_id) {
      throw new HttpError(400, 'channel_not_bridged', 'That channel is not linked to a Discord channel.');
    }

    const limit = Math.min(Math.max(requestedLimit ?? HISTORY_IMPORT_LIMIT, 1), 100);
    const messages = await active.fetchRecentMessages(channel.discord_channel_id, limit);

    let imported = 0;
    for (const message of messages) {
      // Imported as history, never as a live event: the messages are old, so
      // they must not be broadcast or they would ring notifications for content
      // the clients already have (or already read).
      if (await ingest(message, true)) imported++;
    }
    if (imported > 0) logger.info('imported discord history', { channelId, imported });
    return imported;
  }

  /** Backfills every bridged channel, best effort, without blocking startup. */
  async function importAllBridged(): Promise<void> {
    for (const channel of listChannels(deps.sqlite)) {
      if (!channel.discord_channel_id) continue;
      try {
        await importChannel(channel.id);
      } catch (error) {
        logger.debug('could not import discord history', {
          channelId: channel.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async function ingestEdit(edit: DiscordIncomingEdit): Promise<void> {
    // Our own edit of a mirrored message comes back from Discord in Discord's
    // form: a reply's quote line on top, mentions as raw ids, cut to Discord's
    // length. Applying it would overwrite what was written here.
    if (edit.fromBot) return;
    const mapping = findBridgeMessageByDiscordId(deps.sqlite, edit.id);
    if (!mapping) return;
    // Rewritten like a fresh message, so an edit that adds a mention reads the
    // same as one sent with it, and one that adds or newly suppresses a link
    // previews on the Harmony side to match.
    const content = rewriteInboundChannelMentions(
      rewriteInboundMentions(unwrapSuppressedLinks(await translateInboundEmoji(edit.content)), edit.mentions),
    );
    if (!deps.messages.editBridged(mapping.harmony_message_id, content)) return;
    deps.resolvePreview?.(mapping.harmony_message_id, content);
  }

  async function ingestDelete(deletion: DiscordIncomingDelete): Promise<void> {
    const mapping = findBridgeMessageByDiscordId(deps.sqlite, deletion.id);
    if (!mapping) return;

    deps.messages.deleteBridged(mapping.harmony_message_id);
    deleteBridgeMessage(deps.sqlite, mapping.harmony_message_id);
  }

  /**
   * Maps a Discord reaction to the canonical Harmony reaction key, learning an
   * emoji from another server by its id so the reaction renders here too.
   */
  async function toHarmonyReaction(
    reaction: DiscordIncomingReaction,
  ): Promise<{ emoji: string; emojiId: string | null }> {
    if (!reaction.emojiId) return { emoji: reaction.emoji, emojiId: null };
    // A custom emoji: reuse the Harmony emoji of the same name so it renders.
    const existing = findEmojiByName(deps.sqlite, reaction.emoji);
    if (existing) {
      touchLearnedEmoji(existing);
      return { emoji: `:${existing.name}:`, emojiId: existing.id };
    }

    const learned = transport
      ? await ensureExternalEmoji(transport, reaction.emojiId, reaction.emoji, reaction.animated)
      : null;
    const row = learned ? findEmojiByName(deps.sqlite, learned) : null;
    return row ? { emoji: `:${row.name}:`, emojiId: row.id } : { emoji: `:${reaction.emoji}:`, emojiId: null };
  }

  async function ingestReaction(reaction: DiscordIncomingReaction): Promise<void> {
    const mapping = findBridgeMessageByDiscordId(deps.sqlite, reaction.messageId);
    if (!mapping) return;

    const author = resolveGhostUser(reaction.userId, reaction.userName);
    const { emoji, emojiId } = await toHarmonyReaction(reaction);
    deps.messages.addReactionBridged(mapping.harmony_message_id, author.id, emoji, emojiId);
  }

  async function ingestReactionRemoved(reaction: DiscordIncomingReaction): Promise<void> {
    const mapping = findBridgeMessageByDiscordId(deps.sqlite, reaction.messageId);
    if (!mapping) return;

    const author = resolveGhostUser(reaction.userId, reaction.userName);
    const { emoji } = await toHarmonyReaction(reaction);
    deps.messages.removeReactionBridged(mapping.harmony_message_id, author.id, emoji);
  }

  async function ingestReactionCleared(reaction: DiscordIncomingReaction): Promise<void> {
    const mapping = findBridgeMessageByDiscordId(deps.sqlite, reaction.messageId);
    if (!mapping) return;

    const { emoji, emojiId } = await toHarmonyReaction(reaction);
    deps.messages.clearReactionsBridged(mapping.harmony_message_id, emoji, emojiId);
  }

  /**
   * Every reaction was removed from a Discord message at once. Each emoji is
   * cleared in turn, which is what clients already know how to show.
   */
  function ingestReactionsRemovedAll(removed: DiscordIncomingReactionsRemoved): void {
    const mapping = findBridgeMessageByDiscordId(deps.sqlite, removed.messageId);
    if (!mapping) return;

    const messageId = mapping.harmony_message_id;
    const reactions = listReactionsForMessages(deps.sqlite, [messageId], '').get(messageId) ?? [];
    for (const reaction of reactions) {
      deps.messages.clearReactionsBridged(messageId, reaction.emoji, reaction.emojiId);
    }
  }

  // Messages created or changed in Harmony are mirrored out; bridged-in changes
  // are applied through the *Bridged methods, which never notify, so nothing
  // ever bounces back to Discord.
  function watch(action: () => Promise<void>, channelId: string | undefined): void {
    void action().catch((error: unknown) => {
      logger.info('bridge could not sync a change to Discord', {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  deps.messages.onMessageCreated((message) => watch(() => mirror(message), message.channelId));
  deps.messages.onMessageEdited((message) => watch(() => mirrorEdit(message), message.channelId));
  deps.messages.onMessageDeleted((info) => watch(() => mirrorDelete(info), info.channelId));
  deps.messages.onReactionAdded((event) => watch(() => mirrorReaction(event, 'add'), event.message.channelId));
  deps.messages.onReactionRemoved((event) => watch(() => mirrorReaction(event, 'remove'), event.message.channelId));
  deps.messages.onReactionsCleared((event) => watch(() => mirrorReaction(event, 'clear'), event.message.channelId));

  return {
    status,

    async applySettings() {
      const bridge = deps.settings.getBridge();
      const desired = bridge.enabled ? bridge.token : null;

      if (desired === activeToken) return;

      if (transport) {
        await transport.stop();
        transport = null;
        activeToken = null;
        guildEmojiByName = null;
        forgetDiscordPresence();
      }
      if (!desired) return;

      transport = deps.transportFactory(desired, logger);
      transport.onMessage((message) => {
        void ingest(message).catch((error: unknown) => logger.info('bridge ingest failed', error));
      });
      transport.onMessageEdited((edit) => {
        void ingestEdit(edit).catch((error: unknown) => logger.info('bridge edit sync failed', error));
      });
      transport.onMessageDeleted((deletion) => {
        void ingestDelete(deletion).catch((error: unknown) => logger.info('bridge delete sync failed', error));
      });
      transport.onReactionAdded((reaction) => {
        void ingestReaction(reaction).catch((error: unknown) => logger.info('bridge reaction sync failed', error));
      });
      transport.onReactionRemoved((reaction) => {
        void ingestReactionRemoved(reaction).catch((error: unknown) =>
          logger.info('bridge reaction sync failed', error),
        );
      });
      transport.onReactionCleared((reaction) => {
        void ingestReactionCleared(reaction).catch((error: unknown) =>
          logger.info('bridge reaction sync failed', error),
        );
      });
      transport.onReactionsRemovedAll((removed) => {
        try {
          ingestReactionsRemovedAll(removed);
        } catch (error) {
          logger.info('bridge reaction sync failed', error);
        }
      });
      transport.onPresence((presence) => applyDiscordPresence(presence));
      activeToken = desired;
      await transport.start();
      // Backfill any history we have not seen yet, without blocking startup.
      void importAllBridged();
    },

    async listDiscordChannels() {
      if (!transport) return { guildName: null, categories: [], channels: [] };
      return transport.listTextChannels();
    },

    async listGuildEmojis() {
      if (!transport) return { guildName: null, emojis: [] };
      return { guildName: transport.status().guildName, emojis: await transport.guildEmojis() };
    },

    async downloadGuildEmoji(id, animated) {
      if (!transport) throw new HttpError(503, 'bridge_offline', 'The Discord bridge is not connected.');
      // Discord serves animated emoji as GIF and everything else as PNG.
      const ext = animated ? 'gif' : 'png';
      const data = await transport.download(`https://cdn.discordapp.com/emojis/${id}.${ext}`);
      return { data, contentType: animated ? 'image/gif' : 'image/png' };
    },

    importChannel,

    async refreshDiscordAttachment(url) {
      if (!transport) return null;
      return transport.refreshAttachmentUrl(url);
    },

    onlineDiscordIds() {
      return new Set(discordOnline);
    },

    async testMirror(channelId) {
      const channel = findChannel(deps.sqlite, channelId);
      if (!channel) throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');

      await sendToDiscord(channel, 'Harmony', 'Harmony bridge test — this channel is connected.', [], null, []);
    },

    async shutdown() {
      if (transport) {
        await transport.stop();
        transport = null;
        activeToken = null;
      }
      forgetDiscordPresence();
    },
  };
}
