import { z } from 'zod';
import { LIMITS } from './constants.ts';
import type { Attachment, IsoTimestamp, SnowflakeId } from './types.ts';

/** How many scheduled messages one member may hold at once, failed ones included. */
export const MAX_SCHEDULED_PER_MEMBER = 25;
/** The shortest wait the server accepts, so "later" is never "now". */
export const SCHEDULED_MIN_LEAD_MS = 30_000;
/** The furthest ahead a message may be scheduled. */
export const SCHEDULED_MAX_LEAD_MS = 365 * 86_400_000;

/**
 * `pending` waits for its time. `failed` was due but could not be sent (the
 * reason is in `error`); it stays in the list until the member retries it by
 * giving it a new time, sends it by hand or cancels it. A delivered message is
 * not listed at all: it is an ordinary message by then.
 */
export type ScheduledStatus = 'pending' | 'failed';

/** One of a member's own scheduled messages. Private to its author. */
export interface ScheduledMessage {
  id: SnowflakeId;
  channelId: SnowflakeId;
  content: string;
  /** Uploads waiting to go out with it. */
  attachments: Attachment[];
  replyToId: SnowflakeId | null;
  sendAt: IsoTimestamp;
  createdAt: IsoTimestamp;
  status: ScheduledStatus;
  /** Why a failed one could not be sent; null while pending. */
  error: string | null;
}

/** Response for `GET /api/v1/users/@me/scheduled`: soonest first. */
export interface ScheduledMessageListResponse {
  scheduled: ScheduledMessage[];
}

/**
 * One of a member's scheduled messages changed. It goes only to that member's
 * sessions. `scheduled` is the new state, or null once it left the list; `reason`
 * then says why, so a client can tell a delivery from a cancellation.
 */
export interface ScheduledMessageUpdatePayload {
  id: SnowflakeId;
  scheduled: ScheduledMessage | null;
  reason: 'created' | 'updated' | 'failed' | 'sent' | 'cancelled';
}

const sendAtSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Not a valid time.' });

export const createScheduledMessageSchema = z
  .object({
    content: z.string().max(LIMITS.messageLength).default(''),
    attachmentIds: z.array(z.string()).max(LIMITS.attachmentsPerMessage).optional(),
    replyToId: z.string().nullable().optional(),
    /** When to send, as an ISO timestamp. */
    sendAt: sendAtSchema,
  })
  .refine((value) => value.content.trim().length > 0 || (value.attachmentIds?.length ?? 0) > 0, {
    message: 'A message needs text or at least one attachment.',
    path: ['content'],
  });
export type CreateScheduledMessageInput = z.infer<typeof createScheduledMessageSchema>;

export const updateScheduledMessageSchema = z
  .object({
    content: z.string().max(LIMITS.messageLength).optional(),
    sendAt: sendAtSchema.optional(),
  })
  .refine((value) => value.content !== undefined || value.sendAt !== undefined, {
    message: 'Nothing to change.',
  });
export type UpdateScheduledMessageInput = z.infer<typeof updateScheduledMessageSchema>;
