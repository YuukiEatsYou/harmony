import type { DatabaseSync } from 'node:sqlite';
import {
  GatewayEvent,
  LIMITS,
  Permission,
  hasPermission,
  type Attachment,
  type Message,
  type MessageReference,
  type PinListResponse,
  type Reaction,
  type Sticker,
} from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';
import type { AuditService } from '../audit/service.ts';
import { canAccessChannel, channelAccessFor } from '../access/service.ts';
import { listAttachmentsForMessages } from '../db/attachments.ts';
import { findChannel } from '../db/channels.ts';
import { findMessage, parseMessageEmbed, type MessageRow } from '../db/messages.ts';
import { clearPinned, listPinnedMessages, setPinnedWithinCap } from '../db/pins.ts';
import { loadPollsForMessages } from '../db/polls.ts';
import { listReactionsForMessages } from '../db/reactions.ts';
import { listSavedAmong } from '../db/saved_messages.ts';
import { listStickersForMessages } from '../db/stickers.ts';
import { findUserById, presentUser } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { MessageService } from '../messages/service.ts';
import type { GatewayHub } from '../realtime/hub.ts';

/**
 * Pinned messages, per channel.
 *
 * The pin state rides on the message itself (`Message.pinnedAt`), so a change
 * goes out as an ordinary MESSAGE_UPDATE that every client already applies; there
 * is no pin event of its own. That broadcast goes straight to the hub rather than
 * through the message service's edit path, so a pin is never mistaken for an edit
 * and mirrored to Discord as one.
 *
 * It is shaped like the message service for the same reason: the Discord bridge
 * is expected to sync pins later. Local pins notify `onPinned` / `onUnpinned`,
 * which the bridge can subscribe to and pin on Discord; pins that came from
 * Discord go through the `*Bridged` variants, which skip permission checks and
 * notify nobody, so a pin can never bounce back and forth between the two. The
 * bridge (bridge/service.ts) is that subscriber. A bridged pin is still audited,
 * with no actor, which the log shows as Discord.
 */
export interface PinService {
  /** A channel's pins, newest pin first, for a member who can see the channel. */
  list(auth: AuthContext, channelId: string): PinListResponse;
  /** Pins a message. Pinning one that already is changes nothing. Requires ManageMessages. */
  pin(auth: AuthContext, channelId: string, messageId: string): Message;
  /** Unpins a message. Unpinning one that is not pinned changes nothing. Requires ManageMessages. */
  unpin(auth: AuthContext, channelId: string, messageId: string): Message;
  /**
   * Applies a pin made on Discord, without permission checks or notifying the
   * listeners. The cap still applies, so a full channel ignores the pin; null
   * means nothing changed.
   */
  pinBridged(messageId: string, pinnedAt?: string): Message | null;
  /** Applies an unpin made on Discord, without notifying the listeners. */
  unpinBridged(messageId: string): Message | null;
  /** Notified for local pins only, never for bridged ones. */
  onPinned(listener: (message: Message) => void): void;
  onUnpinned(listener: (message: Message) => void): void;
}

export function createPinService(
  sqlite: DatabaseSync,
  hub: GatewayHub,
  audit: AuditService,
  messages: MessageService,
): PinService {
  const pinnedListeners = new Set<(message: Message) => void>();
  const unpinnedListeners = new Set<(message: Message) => void>();

  /** A misbehaving listener must never break the pin itself. */
  function safeNotify(listener: (message: Message) => void, message: Message): void {
    try {
      listener(message);
    } catch (error) {
      void error;
    }
  }

  /**
   * The same rule as reading history: a locked channel is forbidden to anyone
   * without its role, and a missing one is simply not found.
   */
  function assertChannel(userId: string, channelId: string): void {
    if (!findChannel(sqlite, channelId)) {
      throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');
    }
    if (!canAccessChannel(sqlite, channelAccessFor(sqlite, userId), channelId)) {
      throw new HttpError(403, 'channel_forbidden', 'You do not have access to that channel.');
    }
  }

  /** A live message in the named channel; one from elsewhere is as good as missing. */
  function requireMessage(channelId: string, messageId: string): MessageRow {
    const row = findMessage(sqlite, messageId);
    if (!row || row.deleted_at || row.channel_id !== channelId) {
      throw new HttpError(404, 'message_not_found', 'That message does not exist.');
    }
    return row;
  }

  function assertCanPin(auth: AuthContext): void {
    if (!hasPermission(auth.permissions, Permission.ManageMessages)) {
      throw new HttpError(403, 'forbidden', 'You need Manage Messages to pin or unpin messages.');
    }
  }

  /** Sends the new pin state to everyone who can see the channel. */
  function broadcast(messageId: string): Message | null {
    const message = messages.byId(messageId);
    if (message) hub.dispatch(GatewayEvent.MessageUpdate, message, { channelId: message.channelId });
    return message;
  }

  function render(messageId: string, viewerId: string): Message {
    const message = messages.byId(messageId, viewerId);
    if (!message) throw new HttpError(404, 'message_not_found', 'That message does not exist.');
    return message;
  }

  /** The reply a message answers, with its parent's author resolved. */
  function buildReply(row: MessageRow): MessageReference | null {
    if (!row.reply_to_id) return null;
    const parent = findMessage(sqlite, row.reply_to_id);
    if (!parent) return null;
    const authorRow = parent.author_id ? findUserById(sqlite, parent.author_id) : null;
    return {
      id: parent.id,
      author: authorRow ? presentUser(sqlite, authorRow) : null,
      content: parent.deleted_at ? '' : parent.content,
      deleted: parent.deleted_at != null,
    };
  }

  /** One pin row plus its already-batched related rows, as the API shape. */
  function toMessage(
    row: MessageRow,
    attachments: Attachment[],
    reactions: Reaction[],
    stickers: Sticker[],
    saved: boolean,
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
      pinnedAt: row.pinned_at,
      saved,
      poll: null,
    };
  }

  /**
   * Renders a page of pin rows the way the message service renders a history
   * page: the per-message lookups (attachments, reactions, stickers, saves) are
   * batched into one query each, so a full page costs a bounded handful of
   * queries rather than a round trip per pin. The shape matches `renderPage` in
   * messages/service.ts, which is private to that service, so it is mirrored here.
   */
  function renderPins(rows: MessageRow[], viewerId: string): Message[] {
    const ids = rows.map((row) => row.id);
    const attachments = listAttachmentsForMessages(sqlite, ids);
    const reactions = listReactionsForMessages(sqlite, ids, viewerId);
    const stickers = listStickersForMessages(sqlite, ids);
    const saved = listSavedAmong(sqlite, viewerId, ids);
    const polls = loadPollsForMessages(sqlite, ids, viewerId);
    return rows.map((row) => ({
      ...toMessage(
        row,
        attachments.get(row.id) ?? [],
        reactions.get(row.id) ?? [],
        stickers.get(row.id) ?? [],
        saved.has(row.id),
      ),
      poll: polls.get(row.id) ?? null,
    }));
  }

  return {
    list(auth, channelId) {
      assertChannel(auth.user.id, channelId);
      const rows = listPinnedMessages(sqlite, channelId);
      return { messages: renderPins(rows, auth.user.id) };
    },

    pin(auth, channelId, messageId) {
      assertChannel(auth.user.id, channelId);
      const row = requireMessage(channelId, messageId);
      assertCanPin(auth);
      if (row.pinned_at) return render(row.id, auth.user.id);

      // Counted and written in one statement, so two pins racing for the last
      // slot cannot both pass the cap.
      const result = setPinnedWithinCap(
        sqlite,
        row.id,
        auth.user.id,
        new Date().toISOString(),
        channelId,
        LIMITS.pinsPerChannel,
      );
      if (result === 'full') {
        throw new HttpError(
          400,
          'too_many_pins',
          `This channel already has ${LIMITS.pinsPerChannel} pinned messages. Unpin one before pinning another.`,
        );
      }

      if (result === 'pinned') {
        const message = broadcast(row.id);
        audit.messagePinned(auth.user.id, channelId, row.author_id, row.content, true);
        if (message) for (const listener of pinnedListeners) safeNotify(listener, message);
      }
      return render(row.id, auth.user.id);
    },

    unpin(auth, channelId, messageId) {
      assertChannel(auth.user.id, channelId);
      const row = requireMessage(channelId, messageId);
      assertCanPin(auth);

      if (clearPinned(sqlite, row.id)) {
        const message = broadcast(row.id);
        audit.messagePinned(auth.user.id, channelId, row.author_id, row.content, false);
        if (message) for (const listener of unpinnedListeners) safeNotify(listener, message);
      }
      return render(row.id, auth.user.id);
    },

    pinBridged(messageId, pinnedAt) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return null;
      // Nobody here pinned it, so there is no one to credit.
      const result = setPinnedWithinCap(
        sqlite,
        row.id,
        null,
        pinnedAt ?? new Date().toISOString(),
        row.channel_id,
        LIMITS.pinsPerChannel,
      );
      if (result !== 'pinned') return null;
      audit.messagePinned(null, row.channel_id, row.author_id, row.content, true);
      return broadcast(row.id);
    },

    unpinBridged(messageId) {
      const row = findMessage(sqlite, messageId);
      if (!row || row.deleted_at) return null;
      if (!clearPinned(sqlite, row.id)) return null;
      audit.messagePinned(null, row.channel_id, row.author_id, row.content, false);
      return broadcast(row.id);
    },

    onPinned(listener) {
      pinnedListeners.add(listener);
    },

    onUnpinned(listener) {
      unpinnedListeners.add(listener);
    },
  };
}
