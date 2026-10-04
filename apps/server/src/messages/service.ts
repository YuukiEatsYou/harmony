import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  GatewayEvent,
  Permission,
  bypassesSlowmode,
  hasPermission,
  listMentionUsernames,
  type Attachment,
  type Mention,
  type MentionListResponse,
  type MentionQuery,
  type Message,
  type MessageDeletePayload,
  type MessageHistoryQuery,
  type MessageListResponse,
  type MessageReference,
  type Reaction,
  type ReactionsClearPayload,
  type ReactionUpdatePayload,
  type SearchQuery,
  type Sticker,
} from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';
import type { AuditService } from '../audit/service.ts';
import { assertNotTimedOut } from '../auth/guards.ts';
import { canAccessChannel, channelAccessFor, visibleChannels } from '../access/service.ts';
import { attachToMessage, findAttachment, listAttachmentsForMessages } from '../db/attachments.ts';
import { markChannelRead } from '../db/channel_reads.ts';
import { findChannel, type ChannelRow } from '../db/channels.ts';
import { findEmoji } from '../db/emojis.ts';
import { deleteNameMentions, insertMention, listMentions, type MentionRow } from '../db/mentions.ts';
import {
  findMessage,
  insertMessage,
  lastMessageAt,
  listMessages,
  parseMessageEmbed,
  searchMessages,
  softDeleteMessage,
  updateMessageContent,
  type MessageRow,
} from '../db/messages.ts';
import {
  countReaction,
  deleteReaction,
  deleteReactionsForEmoji,
  insertReaction,
  listReactionsForMessages,
} from '../db/reactions.ts';
import { findUserById, findUserByUsername, presentUser } from '../db/users.ts';
import { attachStickerToMessage, listStickersForMessages } from '../db/stickers.ts';
import { HttpError } from '../http/errors.ts';
import type { GatewayHub } from '../realtime/hub.ts';

/** What the bridge needs to mirror a single reaction change out to Discord. */
export interface ReactionEvent {
  message: Message;
  emoji: string;
  emojiId: string | null;
}

export interface MessageService {
  history(channelId: string, query: MessageHistoryQuery, viewerId: string): MessageListResponse;
  /** Message search across the channels the caller can see, newest first. */
  search(auth: AuthContext, query: SearchQuery): MessageListResponse;
  /** The caller's own inbox: messages that named them or answered theirs. */
  mentions(auth: AuthContext, query: MentionQuery): MentionListResponse;
  create(
    auth: AuthContext,
    channelId: string,
    content: string,
    attachmentIds: string[],
    replyToId: string | null,
  ): Message;
  /**
   * Inserts a message on behalf of the bridge, skipping permission checks.
   * `silent` stores it without broadcasting, for a history import that is not a
   * live event. `stickerIds` are the stickers the message carried on Discord.
   */
  createBridged(
    channelId: string,
    authorId: string,
    content: string,
    attachmentIds: string[],
    replyToId: string | null,
    options?: { createdAt?: string; silent?: boolean; stickerIds?: string[] },
  ): Message;
  edit(auth: AuthContext, messageId: string, content: string): Message;
  /**
   * Applies a bridged edit, without notifying the outbound listeners. Null when
   * the message is gone or the text is unchanged.
   */
  editBridged(messageId: string, content: string): Message | null;
  /** Renders one message for a broadcast, or null when it is gone or deleted. */
  byId(messageId: string): Message | null;
  remove(auth: AuthContext, messageId: string): void;
  /** Applies a bridged deletion, without notifying the outbound listeners. */
  deleteBridged(messageId: string): void;
  /** Adds the caller's reaction, or removes it if they already reacted. */
  toggleReaction(auth: AuthContext, messageId: string, emoji: string, emojiId: string | null): Message;
  /** Removes every user's reaction of one emoji. Requires ManageMessages. */
  clearReactions(auth: AuthContext, messageId: string, emoji: string, emojiId: string | null): Message;
  /** Bridged variants apply a Discord reaction without permission checks. */
  addReactionBridged(messageId: string, userId: string, emoji: string, emojiId: string | null): void;
  removeReactionBridged(messageId: string, userId: string, emoji: string): void;
  clearReactionsBridged(messageId: string, emoji: string, emojiId: string | null): void;
  /** Notified for locally created messages only, never for bridged ones. */
  onMessageCreated(listener: (message: Message) => void): void;
  onMessageEdited(listener: (message: Message) => void): void;
  onMessageDeleted(listener: (info: MessageDeletePayload) => void): void;
  onReactionAdded(listener: (event: ReactionEvent) => void): void;
  onReactionRemoved(listener: (event: ReactionEvent) => void): void;
  onReactionsCleared(listener: (event: ReactionEvent) => void): void;
}

export function createMessageService(sqlite: DatabaseSync, hub: GatewayHub, audit: AuditService): MessageService {
  function buildReply(row: MessageRow): MessageReference | null {
    if (!row.reply_to_id) return null;
    const parent = findMessage(sqlite, row.reply_to_id);
    if (!parent) return null;
    const authorRow = parent.author_id ? findUserById(sqlite, parent.author_id) : null;
    return {
      id: parent.id,
      author: authorRow ? presentUser(sqlite, authorRow) : null,
      // A deleted parent keeps its slot, but the text is gone.
      content: parent.deleted_at ? '' : parent.content,
      deleted: parent.deleted_at != null,
    };
  }

  function toMessage(
    row: MessageRow,
    attachments: Attachment[],
    reactions: Reaction[],
    stickers: Sticker[],
  ): Message {
    const authorRow = row.author_id ? findUserById(sqlite, row.author_id) : null;
    return {
      id: row.id,
      channelId: row.channel_id,
      author: authorRow ? presentUser(sqlite, authorRow) : null,
      content: row.content,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      attachments,
      stickers,
      replyTo: buildReply(row),
      reactions,
      embed: parseMessageEmbed(row.embed),
    };
  }

  function reactionsFor(messageId: string, viewerId: string): Reaction[] {
    return listReactionsForMessages(sqlite, [messageId], viewerId).get(messageId) ?? [];
  }

  function stickersFor(messageId: string): Sticker[] {
    return listStickersForMessages(sqlite, [messageId]).get(messageId) ?? [];
  }

  function render(row: MessageRow, viewerId: string): Message {
    return toMessage(row, attachmentsFor(row.id), reactionsFor(row.id, viewerId), stickersFor(row.id));
  }

  /** Validates a reply target: it must exist, be visible and be in the same channel. */
  function resolveReplyTo(channelId: string, replyToId: string | null): string | null {
    if (!replyToId) return null;
    const parent = findMessage(sqlite, replyToId);
    if (!parent || parent.deleted_at) {
      throw new HttpError(400, 'invalid_reply', 'The message you are replying to no longer exists.');
    }
    if (parent.channel_id !== channelId) {
      throw new HttpError(400, 'invalid_reply', 'You can only reply to a message in the same channel.');
    }
    return parent.id;
  }

  /**
   * A bridged reply's parent, or null when it can no longer be one. Discord does
   * not know a message was deleted here, so somebody there may still answer it;
   * their message must arrive all the same, just not as a reply.
   */
  function bridgedReplyTo(channelId: string, replyToId: string | null): string | null {
    if (!replyToId) return null;
    const parent = findMessage(sqlite, replyToId);
    return parent && !parent.deleted_at && parent.channel_id === channelId ? parent.id : null;
  }

  function requireChannel(channelId: string): ChannelRow {
    const channel = findChannel(sqlite, channelId);
    if (!channel) {
      throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');
    }
    return channel;
  }

  /**
   * Channel slowmode: one message per member per window. Members who manage the
   * channel or its messages skip it, as do Discord's own messages, which never
   * come through here. The remaining wait is spelled out so a client can show it.
   */
  function assertSlowmode(auth: AuthContext, channel: ChannelRow): void {
    const seconds = channel.slowmode_seconds;
    if (seconds <= 0 || bypassesSlowmode(auth.permissions)) return;

    const last = lastMessageAt(sqlite, channel.id, auth.user.id);
    if (!last) return;

    const remainingMs = seconds * 1000 - (Date.now() - new Date(last).getTime());
    if (remainingMs <= 0) return;

    const remaining = Math.ceil(remainingMs / 1000);
    throw new HttpError(
      429,
      'slowmode',
      `Slowmode is on in this channel. Wait ${remaining} more second${remaining === 1 ? '' : 's'}.`,
    );
  }

  /**
   * Channel locking: a member may only read or touch channels they can see. Like
   * a missing channel, a locked one is reported as forbidden rather than hidden.
   */
  function assertChannelAccess(userId: string, channelId: string): void {
    if (!canAccessChannel(sqlite, channelAccessFor(sqlite, userId), channelId)) {
      throw new HttpError(403, 'channel_forbidden', 'You do not have access to that channel.');
    }
  }

  function requireMessage(messageId: string): MessageRow {
    const row = findMessage(sqlite, messageId);
    if (!row || row.deleted_at) throw new HttpError(404, 'message_not_found', 'That message does not exist.');
    return row;
  }

  function attachmentsFor(messageId: string): Attachment[] {
    return listAttachmentsForMessages(sqlite, [messageId]).get(messageId) ?? [];
  }

  function isAuthor(auth: AuthContext, row: MessageRow): boolean {
    return row.author_id === auth.user.id;
  }

  /** Like Discord, only the author may change a message's text. */
  function assertCanEdit(auth: AuthContext, row: MessageRow): void {
    if (!isAuthor(auth, row)) {
      throw new HttpError(403, 'forbidden', 'You can only edit your own messages.');
    }
  }

  /** The author, or anyone with Manage Messages, may delete it. */
  function assertCanDelete(auth: AuthContext, row: MessageRow): void {
    if (!isAuthor(auth, row) && !hasPermission(auth.permissions, Permission.ManageMessages)) {
      throw new HttpError(403, 'forbidden', 'You can only delete your own messages.');
    }
  }

  /**
   * Turns a client's reaction target into the canonical stored form. For custom
   * emoji the database name is authoritative, so a stale or spoofed shortcode
   * cannot desync the row from the image it points at.
   *
   * A custom emoji can be deleted while reactions still use it. Those must stay
   * removable, so a reaction already on the message is matched as stored and
   * flagged `gone`; only adding a fresh one is refused.
   */
  function canonicalReaction(
    messageId: string,
    emoji: string,
    emojiId: string | null,
  ): { emoji: string; emojiId: string | null; gone: boolean } {
    if (!emojiId) return { emoji, emojiId: null, gone: false };
    const row = findEmoji(sqlite, emojiId);
    if (row) return { emoji: `:${row.name}:`, emojiId: row.id, gone: false };
    if (countReaction(sqlite, messageId, emoji) > 0) return { emoji, emojiId, gone: true };
    throw new HttpError(400, 'invalid_emoji', 'That emoji does not exist.');
  }

  /**
   * Notes who a message is aimed at, so the inbox can list it later without
   * re-reading anyone's text. A reply to someone counts, and so does naming them;
   * a message that does both writes a single row, the reply winning. Nobody is
   * told about their own message, and the stand-in accounts kept for Discord
   * users are skipped: they can never sign in to read what was collected.
   *
   * The skip is on `is_bot`, not on having a Discord id: a real member linked to a
   * Discord account also carries one, and they are every bit as much a member.
   */
  function recordMentions(
    messageId: string,
    channelId: string,
    authorId: string,
    content: string,
    replyToId: string | null,
    createdAt: string,
  ): void {
    if (replyToId) {
      const parent = findMessage(sqlite, replyToId);
      const target = parent?.author_id ? findUserById(sqlite, parent.author_id) : null;
      if (target && target.id !== authorId && target.is_bot === 0) {
        insertMention(sqlite, { messageId, userId: target.id, channelId, kind: 'reply', createdAt });
      }
    }
    // Written after the reply, whose row then wins for someone who is both.
    recordNameMentions(messageId, channelId, authorId, content, createdAt);
  }

  /** The naming half of `recordMentions`, which an edit runs again on its own. */
  function recordNameMentions(
    messageId: string,
    channelId: string,
    authorId: string,
    content: string,
    createdAt: string,
  ): void {
    for (const username of listMentionUsernames(content)) {
      const user = findUserByUsername(sqlite, username);
      if (!user || user.id === authorId || user.is_bot === 1) continue;
      insertMention(sqlite, { messageId, userId: user.id, channelId, kind: 'mention', createdAt });
    }
  }

  /**
   * Brings who a message names in line with its edited text: somebody named for
   * the first time finds it in their inbox, and somebody no longer named stops
   * finding it there. Rows keep the message's own time, as they had when it was
   * sent, so an edit never makes an already read channel unread again; like
   * Discord, adding a name by editing does not ping.
   */
  function rerecordNameMentions(row: MessageRow, content: string): void {
    deleteNameMentions(sqlite, row.id);
    if (row.author_id) recordNameMentions(row.id, row.channel_id, row.author_id, content, row.created_at);
  }

  function insertWithAttachments(
    channelId: string,
    authorId: string,
    content: string,
    attachmentIds: string[],
    replyToId: string | null,
    createdAt?: string,
    stickerIds: string[] = [],
  ): Message {
    // Uploads belong to the message that claims them; reject anything already
    // used or belonging to someone else.
    for (const attachmentId of attachmentIds) {
      const attachment = findAttachment(sqlite, attachmentId);
      if (!attachment) throw new HttpError(400, 'invalid_attachment', 'One of the attachments does not exist.');
      if (attachment.message_id) {
        throw new HttpError(400, 'attachment_in_use', 'One of the attachments is already in use.');
      }
      if (attachment.uploader_id !== authorId) {
        throw new HttpError(403, 'forbidden', 'You can only attach your own uploads.');
      }
    }

    const id = randomUUID();
    const postedAt = createdAt ?? new Date().toISOString();
    const resolvedReplyTo = resolveReplyTo(channelId, replyToId);
    insertMessage(sqlite, {
      id,
      channelId,
      authorId,
      content,
      // Imported history keeps its original Discord timestamp.
      createdAt: postedAt,
      replyToId: resolvedReplyTo,
    });
    for (const attachmentId of attachmentIds) attachToMessage(sqlite, attachmentId, id);
    stickerIds.forEach((stickerId, position) => attachStickerToMessage(sqlite, id, stickerId, position));
    recordMentions(id, channelId, authorId, content, resolvedReplyTo, postedAt);

    // A brand new message has no reactions yet.
    return toMessage(requireMessage(id), attachmentsFor(id), [], stickersFor(id));
  }

  const createdListeners = new Set<(message: Message) => void>();
  const editedListeners = new Set<(message: Message) => void>();
  const deletedListeners = new Set<(info: MessageDeletePayload) => void>();
  const reactionAddedListeners = new Set<(event: ReactionEvent) => void>();
  const reactionRemovedListeners = new Set<(event: ReactionEvent) => void>();
  const reactionsClearedListeners = new Set<(event: ReactionEvent) => void>();

  /** A misbehaving listener must never break the message operation itself. */
  function safeNotify<T>(listener: (value: T) => void, value: T): void {
    try {
      listener(value);
    } catch (error) {
      void error;
    }
  }

  function announce(message: Message): void {
    hub.dispatch(GatewayEvent.MessageCreate, message, { channelId: message.channelId });
    for (const listener of createdListeners) safeNotify(listener, message);
  }

  function announceEdit(message: Message): void {
    hub.dispatch(GatewayEvent.MessageUpdate, message, { channelId: message.channelId });
    for (const listener of editedListeners) safeNotify(listener, message);
  }

  function announceDelete(info: MessageDeletePayload): void {
    hub.dispatch(GatewayEvent.MessageDelete, info, { channelId: info.channelId });
    for (const listener of deletedListeners) safeNotify(listener, info);
  }

  function announceReaction(kind: 'add' | 'remove', payload: ReactionUpdatePayload, message: Message): void {
    hub.dispatch(
      kind === 'add' ? GatewayEvent.MessageReactionAdd : GatewayEvent.MessageReactionRemove,
      payload,
      { channelId: payload.channelId },
    );
    const event: ReactionEvent = { message, emoji: payload.emoji, emojiId: payload.emojiId };
    const listeners = kind === 'add' ? reactionAddedListeners : reactionRemovedListeners;
    for (const listener of listeners) safeNotify(listener, event);
  }

  function announceReactionsCleared(payload: ReactionsClearPayload, message: Message): void {
    hub.dispatch(GatewayEvent.MessageReactionsClear, payload, { channelId: payload.channelId });
    const event: ReactionEvent = { message, emoji: payload.emoji, emojiId: payload.emojiId };
    for (const listener of reactionsClearedListeners) safeNotify(listener, event);
  }

  /** Turns a page of rows into rendered messages, batching the lookups. */
  function renderPage(rows: MessageRow[], viewerId: string): MessageListResponse {
    const ids = rows.map((row) => row.id);
    const byMessage = listAttachmentsForMessages(sqlite, ids);
    const reactions = listReactionsForMessages(sqlite, ids, viewerId);
    const stickers = listStickersForMessages(sqlite, ids);
    return {
      messages: rows.map((row) =>
        toMessage(row, byMessage.get(row.id) ?? [], reactions.get(row.id) ?? [], stickers.get(row.id) ?? []),
      ),
    };
  }

  /** Turns a page of mention rows into the inbox entries a client renders. */
  function renderMentions(rows: MentionRow[], viewerId: string): MentionListResponse {
    const ids = rows.map((row) => row.id);
    const byMessage = listAttachmentsForMessages(sqlite, ids);
    const reactions = listReactionsForMessages(sqlite, ids, viewerId);
    const stickers = listStickersForMessages(sqlite, ids);
    const mentions: Mention[] = rows.map((row) => ({
      kind: row.mention_kind === 'reply' ? 'reply' : 'mention',
      unread: row.mention_unread === 1,
      message: toMessage(row, byMessage.get(row.id) ?? [], reactions.get(row.id) ?? [], stickers.get(row.id) ?? []),
    }));
    return { mentions };
  }

  return {
    history(channelId, query, viewerId) {
      requireChannel(channelId);
      assertChannelAccess(viewerId, channelId);
      const rows = listMessages(sqlite, channelId, {
        limit: query.limit,
        before: query.before,
        beforeId: query.beforeId,
      });
      return renderPage(rows, viewerId);
    },

    search(auth, query) {
      // Only the channels this member can see are ever searched, so a locked
      // channel cannot leak through a result even if its text matches.
      const visible = visibleChannels(sqlite, channelAccessFor(sqlite, auth.user.id)).map(
        (channel) => channel.id,
      );

      let channelIds = visible;
      if (query.channelId !== undefined) {
        if (!visible.includes(query.channelId)) {
          throw new HttpError(403, 'channel_forbidden', 'You do not have access to that channel.');
        }
        channelIds = [query.channelId];
      }

      const rows = searchMessages(sqlite, {
        query: query.q,
        channelIds,
        authorId: query.authorId,
        limit: query.limit,
        before: query.before,
        beforeId: query.beforeId,
      });
      return renderPage(rows, auth.user.id);
    },

    mentions(auth, query) {
      // Only the channels this member can see are asked about, so a mention in a
      // channel that has since been locked away cannot be read back here either.
      const visible = visibleChannels(sqlite, channelAccessFor(sqlite, auth.user.id)).map(
        (channel) => channel.id,
      );
      const rows = listMentions(sqlite, auth.user.id, visible, {
        limit: query.limit,
        before: query.before,
        beforeId: query.beforeId,
      });
      return renderMentions(rows, auth.user.id);
    },

    create(auth, channelId, content, attachmentIds, replyToId) {
      assertNotTimedOut(auth);
      const channel = requireChannel(channelId);
      assertChannelAccess(auth.user.id, channelId);
      assertSlowmode(auth, channel);
      const message = insertWithAttachments(channelId, auth.user.id, content, attachmentIds, replyToId);
      // Sending is reading: whatever else was waiting in this channel has been seen
      // by whoever just posted in it, and a message you sent must never come back as
      // unread for you.
      markChannelRead(sqlite, auth.user.id, channelId, message.createdAt);
      announce(message);
      return message;
    },

    createBridged(channelId, authorId, content, attachmentIds, replyToId, options = {}) {
      requireChannel(channelId);
      const message = insertWithAttachments(
        channelId,
        authorId,
        content,
        attachmentIds,
        bridgedReplyTo(channelId, replyToId),
        options.createdAt,
        options.stickerIds ?? [],
      );
      // Broadcast to clients, but do not announce: this came from Discord and
      // must not be mirrored straight back. A history import is left unspoken:
      // broadcasting it would let an old, already-read message ring a client's
      // notification sound as though it had just arrived.
      if (!options.silent) hub.dispatch(GatewayEvent.MessageCreate, message, { channelId: message.channelId });
      return message;
    },

    byId(messageId) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return null;
      // The viewer is only used for the `me` reaction badge, which the clients
      // keep themselves for an update, so no particular viewer is needed.
      return render(row, '');
    },

    onMessageCreated(listener) {
      createdListeners.add(listener);
    },

    onMessageEdited(listener) {
      editedListeners.add(listener);
    },

    onMessageDeleted(listener) {
      deletedListeners.add(listener);
    },

    onReactionAdded(listener) {
      reactionAddedListeners.add(listener);
    },

    onReactionRemoved(listener) {
      reactionRemovedListeners.add(listener);
    },

    onReactionsCleared(listener) {
      reactionsClearedListeners.add(listener);
    },

    edit(auth, messageId, content) {
      assertNotTimedOut(auth);
      const row = requireMessage(messageId);
      assertChannelAccess(auth.user.id, row.channel_id);
      assertCanEdit(auth, row);

      const before = row.content;
      updateMessageContent(sqlite, messageId, content, new Date().toISOString());
      rerecordNameMentions(row, content);
      const message = render(requireMessage(messageId), auth.user.id);
      announceEdit(message);
      audit.messageEdited(auth.user.id, row.channel_id, before, content);
      return message;
    },

    editBridged(messageId, content) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return null;
      // Discord reports link unfurls as updates; the same text is not an edit.
      if (row.content === content) return null;

      updateMessageContent(sqlite, messageId, content, new Date().toISOString());
      rerecordNameMentions(row, content);
      const message = render(requireMessage(messageId), row.author_id ?? '');
      hub.dispatch(GatewayEvent.MessageUpdate, message, { channelId: message.channelId });
      return message;
    },

    remove(auth, messageId) {
      const row = requireMessage(messageId);
      assertChannelAccess(auth.user.id, row.channel_id);
      assertCanDelete(auth, row);

      softDeleteMessage(sqlite, messageId, new Date().toISOString());
      // The text and images are gone from every client, so keep a copy for the log.
      audit.messageDeleted(
        auth.user.id,
        row.channel_id,
        row.content,
        attachmentsFor(messageId).map((attachment) => ({ id: attachment.id, filename: attachment.filename })),
      );
      announceDelete({ id: messageId, channelId: row.channel_id });
    },

    deleteBridged(messageId) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return;

      softDeleteMessage(sqlite, messageId, new Date().toISOString());
      hub.dispatch(GatewayEvent.MessageDelete, { id: messageId, channelId: row.channel_id }, {
        channelId: row.channel_id,
      });
    },

    toggleReaction(auth, messageId, emoji, emojiId) {
      assertNotTimedOut(auth);
      const row = requireMessage(messageId);
      assertChannelAccess(auth.user.id, row.channel_id);
      const target = canonicalReaction(row.id, emoji, emojiId);

      // Deleting first makes this a toggle: a row that was there is removed.
      const removed = deleteReaction(sqlite, row.id, auth.user.id, target.emoji);
      if (!removed) {
        if (target.gone) throw new HttpError(400, 'invalid_emoji', 'That emoji does not exist.');
        insertReaction(sqlite, {
          messageId: row.id,
          userId: auth.user.id,
          emoji: target.emoji,
          emojiId: target.emojiId,
          createdAt: new Date().toISOString(),
        });
      }

      const payload: ReactionUpdatePayload = {
        messageId: row.id,
        channelId: row.channel_id,
        emoji: target.emoji,
        emojiId: target.emojiId,
        userId: auth.user.id,
        count: countReaction(sqlite, row.id, target.emoji),
      };
      const message = render(row, auth.user.id);
      announceReaction(removed ? 'remove' : 'add', payload, message);
      return message;
    },

    clearReactions(auth, messageId, emoji, emojiId) {
      const row = requireMessage(messageId);
      assertChannelAccess(auth.user.id, row.channel_id);
      if (!hasPermission(auth.permissions, Permission.ManageMessages)) {
        throw new HttpError(403, 'forbidden', 'You need Manage Messages to clear reactions.');
      }

      const target = canonicalReaction(row.id, emoji, emojiId);
      deleteReactionsForEmoji(sqlite, row.id, target.emoji);

      const payload: ReactionsClearPayload = {
        messageId: row.id,
        channelId: row.channel_id,
        emoji: target.emoji,
        emojiId: target.emojiId,
      };
      const message = render(row, auth.user.id);
      announceReactionsCleared(payload, message);
      return message;
    },

    addReactionBridged(messageId, userId, emoji, emojiId) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return;

      insertReaction(sqlite, {
        messageId: row.id,
        userId,
        emoji,
        emojiId,
        createdAt: new Date().toISOString(),
      });
      hub.dispatch(GatewayEvent.MessageReactionAdd, {
        messageId: row.id,
        channelId: row.channel_id,
        emoji,
        emojiId,
        userId,
        count: countReaction(sqlite, row.id, emoji),
      } satisfies ReactionUpdatePayload, { channelId: row.channel_id });
    },

    removeReactionBridged(messageId, userId, emoji) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return;
      if (!deleteReaction(sqlite, row.id, userId, emoji)) return;

      hub.dispatch(GatewayEvent.MessageReactionRemove, {
        messageId: row.id,
        channelId: row.channel_id,
        emoji,
        emojiId: null,
        userId,
        count: countReaction(sqlite, row.id, emoji),
      } satisfies ReactionUpdatePayload, { channelId: row.channel_id });
    },

    clearReactionsBridged(messageId, emoji, emojiId) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return;

      deleteReactionsForEmoji(sqlite, row.id, emoji);
      hub.dispatch(GatewayEvent.MessageReactionsClear, {
        messageId: row.id,
        channelId: row.channel_id,
        emoji,
        emojiId,
      } satisfies ReactionsClearPayload, { channelId: row.channel_id });
    },
  };
}
