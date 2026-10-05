import type { DatabaseSync } from 'node:sqlite';
import {
  GatewayEvent,
  MAX_SCHEDULED_PER_MEMBER,
  Permission,
  SCHEDULED_MAX_LEAD_MS,
  hasPermission,
  type CreateScheduledMessageInput,
  type Message,
  type ScheduledMessage,
  type ScheduledMessageListResponse,
  type ScheduledMessageUpdatePayload,
  type UpdateScheduledMessageInput,
} from '@harmony/shared';
import { canAccessChannel, channelAccessFor } from '../access/service.ts';
import { resolvePermissions } from '../auth/permissions.ts';
import type { AuthContext } from '../auth/service.ts';
import { findAttachment, toAttachment } from '../db/attachments.ts';
import { findBan } from '../db/bans.ts';
import { findChannel } from '../db/channels.ts';
import { findMessage } from '../db/messages.ts';
import {
  attachmentIsScheduled,
  claimScheduled,
  countScheduledForUser,
  deleteScheduled,
  findScheduled,
  insertScheduled,
  listDueScheduled,
  listScheduledAttachmentIds,
  listScheduledForUser,
  markScheduledFailed,
  updateScheduled,
  type ScheduledRow,
} from '../db/scheduled_messages.ts';
import { findUserById, presentUser } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { ServerLogService } from '../log/service.ts';
import type { MessageService } from '../messages/service.ts';
import type { GatewayHub } from '../realtime/hub.ts';
import { randomUUID } from 'node:crypto';

/** How long a message held back by slowmode keeps being retried before it is given up on. */
const SLOWMODE_RETRY_MS = 5 * 60_000;
/** The most a single tick will deliver, so a long outage cannot monopolise the process. */
const TICK_BATCH = 100;

export interface ScheduledMessageService {
  /** The caller's scheduled messages, soonest first. */
  list(auth: AuthContext): ScheduledMessageListResponse;
  create(auth: AuthContext, channelId: string, input: CreateScheduledMessageInput): ScheduledMessage;
  /** Changes the text and/or time. A new time also retries a failed one. */
  update(auth: AuthContext, id: string, input: UpdateScheduledMessageInput): ScheduledMessage;
  /** Cancels one. Cancelling one that is already gone changes nothing. */
  cancel(auth: AuthContext, id: string): void;
  /** Sends one now, through the ordinary send path. Failures are thrown to the caller. */
  sendNow(auth: AuthContext, id: string): Message;
  /** Delivers everything due. Exposed for the timer and for tests. Returns how many were sent. */
  tick(): number;
  /** Delivers what is due now (catching up after downtime), then keeps checking on an interval. */
  start(): void;
  stop(): void;
}

export interface ScheduledMessageDeps {
  sqlite: DatabaseSync;
  hub: GatewayHub;
  messages: MessageService;
  tickMs: number;
  minLeadMs: number;
  log?: (message: string, detail?: unknown) => void;
  serverLog?: ServerLogService;
}

/**
 * Scheduled messages: a member's private "send later" queue, delivered by the
 * server so they go out with every tab closed.
 *
 * Delivery goes through the very same `MessageService.create` as a message sent
 * by hand, with the author's permissions worked out again at that moment: a
 * member who lost the channel, the Send Messages permission, or who is timed out
 * or banned by the time it is due gets a failed entry with the reason rather
 * than a message. Slowmode cannot be dodged by scheduling; the send is retried
 * for a few minutes until the window has passed, then given up on.
 *
 * Exactly-once: the queue row is deleted inside the same transaction that
 * inserts the message. Whoever deletes it owns the delivery, a crash in between
 * rolls both back, and a second caller (the timer racing a "send now") finds
 * nothing left to claim.
 */
export function createScheduledMessageService(deps: ScheduledMessageDeps): ScheduledMessageService {
  const { sqlite, hub, messages } = deps;
  let timer: ReturnType<typeof setInterval> | null = null;

  function toDto(row: ScheduledRow): ScheduledMessage {
    const attachments = listScheduledAttachmentIds(sqlite, row.id).flatMap((id) => {
      const attachment = findAttachment(sqlite, id);
      return attachment ? [toAttachment(attachment)] : [];
    });
    return {
      id: row.id,
      channelId: row.channel_id,
      content: row.content,
      attachments,
      replyToId: row.reply_to_id,
      sendAt: new Date(row.send_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
      status: row.status === 'failed' ? 'failed' : 'pending',
      error: row.error,
    };
  }

  /** Tells the author's own sessions, and only them, what became of a scheduled message. */
  function notify(userId: string, payload: ScheduledMessageUpdatePayload): void {
    hub.dispatchToUsers(GatewayEvent.ScheduledMessageUpdate, payload, new Set([userId]));
  }

  function requireOwn(auth: AuthContext, id: string): ScheduledRow {
    const row = findScheduled(sqlite, id);
    // Somebody else's is reported as missing, so ids cannot be probed.
    if (!row || row.user_id !== auth.user.id) {
      throw new HttpError(404, 'scheduled_not_found', 'That scheduled message does not exist.');
    }
    return row;
  }

  function parseSendAt(value: string): number {
    const time = Date.parse(value);
    const now = Date.now();
    if (time < now + deps.minLeadMs) {
      throw new HttpError(400, 'invalid_send_time', 'Pick a time further in the future.');
    }
    if (time > now + SCHEDULED_MAX_LEAD_MS) {
      throw new HttpError(400, 'invalid_send_time', 'Messages can be scheduled up to a year ahead.');
    }
    return time;
  }

  function validateReply(channelId: string, replyToId: string | null): void {
    if (!replyToId) return;
    const parent = findMessage(sqlite, replyToId);
    if (!parent || parent.deleted_at || parent.channel_id !== channelId) {
      throw new HttpError(400, 'invalid_reply', 'You can only reply to a message in the same channel.');
    }
  }

  function validateAttachments(auth: AuthContext, ids: string[]): void {
    if (ids.length === 0) return;
    if (!hasPermission(auth.permissions, Permission.AttachFiles)) {
      throw new HttpError(403, 'forbidden', 'You do not have permission to attach files.');
    }
    if (new Set(ids).size !== ids.length) {
      throw new HttpError(400, 'invalid_attachment', 'An attachment can only be listed once.');
    }
    for (const id of ids) {
      const attachment = findAttachment(sqlite, id);
      if (!attachment) throw new HttpError(400, 'invalid_attachment', 'One of the attachments does not exist.');
      if (attachment.message_id || attachmentIsScheduled(sqlite, id)) {
        throw new HttpError(400, 'attachment_in_use', 'One of the attachments is already in use.');
      }
      if (attachment.uploader_id !== auth.user.id) {
        throw new HttpError(403, 'forbidden', 'You can only attach your own uploads.');
      }
    }
  }

  /** The author's permissions as they stand right now, as the send path sees them. */
  function currentAuth(row: ScheduledRow): AuthContext {
    const user = findUserById(sqlite, row.user_id);
    if (!user || findBan(sqlite, user.id)) {
      throw new HttpError(403, 'forbidden', 'Your account can no longer post.');
    }
    const auth: AuthContext = {
      user: presentUser(sqlite, user),
      permissions: resolvePermissions(sqlite, user),
      sessionId: '',
      token: '',
    };
    if (!hasPermission(auth.permissions, Permission.SendMessages)) {
      throw new HttpError(403, 'forbidden', 'You no longer have permission to send messages.');
    }
    return auth;
  }

  /**
   * Sends one queued message, or throws why it cannot be. `statuses` are the
   * states it may be claimed from. On any error the transaction is rolled back,
   * so the row is exactly as it was.
   */
  function deliver(id: string, statuses: string[], dueBy: number | null): Message | null {
    const row = findScheduled(sqlite, id);
    if (!row) return null;
    if (!statuses.includes(row.status) || (dueBy !== null && row.send_at > dueBy)) return null;

    // Read before the claim, which clears the links along with the row.
    const ids = listScheduledAttachmentIds(sqlite, id);

    sqlite.exec('BEGIN');
    let message: Message;
    try {
      if (!claimScheduled(sqlite, id, statuses)) {
        sqlite.exec('ROLLBACK');
        return null;
      }
      const auth = currentAuth(row);
      message = messages.create(auth, row.channel_id, row.content, ids, row.reply_to_id);
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
    return message;
  }

  function run(id: string, statuses: string[], dueBy: number | null): Message | null {
    const row = findScheduled(sqlite, id);
    if (!row) return null;
    const message = deliver(id, statuses, dueBy);
    if (message) notify(row.user_id, { id, scheduled: null, reason: 'sent' });
    return message;
  }

  function fail(row: ScheduledRow, error: unknown): void {
    const reason =
      error instanceof HttpError ? error.message : 'Something went wrong while sending this message.';
    if (!(error instanceof HttpError)) {
      deps.log?.('scheduled message delivery failed', { id: row.id, error: String(error) });
      deps.serverLog?.error('scheduled_send_failed', `A scheduled message could not be sent: ${String(error)}`);
    }
    markScheduledFailed(sqlite, row.id, reason);
    const updated = findScheduled(sqlite, row.id);
    if (updated) notify(row.user_id, { id: row.id, scheduled: toDto(updated), reason: 'failed' });
  }

  function tick(): number {
    const now = Date.now();
    let sent = 0;
    for (const id of listDueScheduled(sqlite, now, TICK_BATCH)) {
      const row = findScheduled(sqlite, id);
      if (!row) continue;
      try {
        if (run(id, ['pending'], now)) sent += 1;
      } catch (error) {
        // Slowmode is a wait, not a refusal: try again shortly, within reason.
        if (error instanceof HttpError && error.code === 'slowmode' && now - row.send_at < SLOWMODE_RETRY_MS) {
          continue;
        }
        fail(row, error);
      }
    }
    return sent;
  }

  return {
    list(auth) {
      return { scheduled: listScheduledForUser(sqlite, auth.user.id).map(toDto) };
    },

    create(auth, channelId, input) {
      const channel = findChannel(sqlite, channelId);
      if (!channel) throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');
      if (!canAccessChannel(sqlite, channelAccessFor(sqlite, auth.user.id), channelId)) {
        throw new HttpError(403, 'channel_forbidden', 'You do not have access to that channel.');
      }
      if (countScheduledForUser(sqlite, auth.user.id) >= MAX_SCHEDULED_PER_MEMBER) {
        throw new HttpError(
          400,
          'too_many_scheduled',
          `You can have up to ${MAX_SCHEDULED_PER_MEMBER} scheduled messages. Send or cancel one first.`,
        );
      }
      const sendAt = parseSendAt(input.sendAt);
      const replyToId = input.replyToId ?? null;
      const ids = input.attachmentIds ?? [];
      validateReply(channelId, replyToId);
      validateAttachments(auth, ids);

      const id = randomUUID();
      insertScheduled(sqlite, {
        id,
        userId: auth.user.id,
        channelId,
        content: input.content,
        replyToId,
        sendAt,
        createdAt: Date.now(),
        attachmentIds: ids,
      });
      const created = toDto(findScheduled(sqlite, id)!);
      notify(auth.user.id, { id, scheduled: created, reason: 'created' });
      return created;
    },

    update(auth, id, input) {
      const row = requireOwn(auth, id);
      const sendAt = input.sendAt === undefined ? undefined : parseSendAt(input.sendAt);
      const content = input.content;
      if (content !== undefined && content.trim().length === 0 && listScheduledAttachmentIds(sqlite, id).length === 0) {
        throw new HttpError(400, 'invalid_content', 'A message needs text or at least one attachment.');
      }
      updateScheduled(sqlite, row.id, { content, sendAt });
      const updated = toDto(findScheduled(sqlite, id)!);
      notify(auth.user.id, { id, scheduled: updated, reason: 'updated' });
      return updated;
    },

    cancel(auth, id) {
      const row = findScheduled(sqlite, id);
      if (!row || row.user_id !== auth.user.id) return;
      if (deleteScheduled(sqlite, id)) notify(auth.user.id, { id, scheduled: null, reason: 'cancelled' });
    },

    sendNow(auth, id) {
      requireOwn(auth, id);
      const message = run(id, ['pending', 'failed'], null);
      if (!message) throw new HttpError(404, 'scheduled_not_found', 'That scheduled message does not exist.');
      return message;
    },

    tick,

    start() {
      if (timer) return;
      try {
        tick();
      } catch (error) {
        deps.log?.('initial scheduled delivery failed', { error: String(error) });
      }
      timer = setInterval(() => {
        try {
          tick();
        } catch (error) {
          deps.log?.('scheduled delivery failed', { error: String(error) });
          deps.serverLog?.error('scheduled_tick_failed', String(error));
        }
      }, deps.tickMs);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
