import { z } from 'zod';
import type { IsoTimestamp, SnowflakeId, User } from './types.ts';

/**
 * Polls. A poll belongs to one message, whose text is the question, so search,
 * reply quotes and notifications all read sensibly without knowing about polls.
 *
 * The limits follow Discord's, so a poll made here can always be posted there as
 * a native poll: a question up to 300 characters, 2 to 10 answers of up to 55
 * characters each, and a duration of 1 hour up to 32 days.
 */
export const POLL_LIMITS = {
  question: 300,
  optionText: 55,
  optionsMin: 2,
  optionsMax: 10,
  minHours: 1,
  /** 32 days, Discord's longest poll. */
  maxHours: 768,
  defaultHours: 24,
  /** How many voters one voter-list page returns. */
  votersPage: 100,
} as const;

/** The durations the composer offers, in hours; null is a poll that never closes. */
export const POLL_DURATION_CHOICES: ReadonlyArray<{ hours: number | null; label: string }> = [
  { hours: 1, label: '1 hour' },
  { hours: 4, label: '4 hours' },
  { hours: 8, label: '8 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '1 week' },
  { hours: 336, label: '2 weeks' },
  { hours: 768, label: '32 days' },
  { hours: null, label: 'No expiry' },
];

/** Where a poll was created, which decides who may end it and what mirrors it. */
export type PollSource = 'harmony' | 'discord';

export interface PollOption {
  id: SnowflakeId;
  text: string;
  /** A unicode emoji shown beside the text, or null. */
  emoji: string | null;
  /** How many people chose this option. */
  count: number;
}

export interface Poll {
  messageId: SnowflakeId;
  question: string;
  /** Whether a voter may pick more than one option. */
  allowMultiple: boolean;
  /** When the poll closes by itself, or null when it never does. */
  closesAt: IsoTimestamp | null;
  /** When it was closed, by the clock or by hand, or null while it is open. */
  closedAt: IsoTimestamp | null;
  source: PollSource;
  options: PollOption[];
  /** How many distinct people voted. With multiple answers this is below the sum of the counts. */
  totalVoters: number;
  /**
   * The option ids the viewer picked. Like a reaction's `me` it is one member's
   * perspective, so a broadcast carries an empty list and clients keep their own.
   */
  myVotes: SnowflakeId[];
}

/** One person who chose an option, for the voter list. Polls are not anonymous. */
export interface PollVoter {
  user: User;
  votedAt: IsoTimestamp;
}

/** Who chose one option, earliest first, capped at {@link POLL_LIMITS.votersPage}. */
export interface PollVotersResponse {
  optionId: SnowflakeId;
  /** The option's full count, which can exceed the voters listed. */
  total: number;
  voters: PollVoter[];
}

/** Counts after a vote or a close, sent to everyone who can see the channel. */
export interface PollUpdatePayload {
  messageId: SnowflakeId;
  channelId: SnowflakeId;
  closedAt: IsoTimestamp | null;
  options: Array<{ id: SnowflakeId; count: number }>;
  totalVoters: number;
  /** Who voted, so their own clients can pick up `myVotes`; null for a close. */
  actorId: SnowflakeId | null;
  /** That member's choices after the change; null when `actorId` is. */
  actorVotes: SnowflakeId[] | null;
}

const emojiPattern = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

export const pollOptionInputSchema = z.object({
  text: z.string().trim().min(1, 'Every option needs some text.').max(POLL_LIMITS.optionText),
  emoji: z
    .string()
    .trim()
    .max(16)
    .refine((value) => value === '' || emojiPattern.test(value), 'That is not an emoji.')
    .nullable()
    .optional(),
});
export type PollOptionInput = z.infer<typeof pollOptionInputSchema>;

export const createPollSchema = z.object({
  question: z.string().trim().min(1, 'A poll needs a question.').max(POLL_LIMITS.question),
  options: z.array(pollOptionInputSchema).min(POLL_LIMITS.optionsMin).max(POLL_LIMITS.optionsMax),
  allowMultiple: z.boolean().default(false),
  /** Hours until it closes, or null for a poll that stays open. */
  durationHours: z
    .number()
    .int()
    .min(POLL_LIMITS.minHours)
    .max(POLL_LIMITS.maxHours)
    .nullable()
    .default(POLL_LIMITS.defaultHours),
  replyToId: z.string().nullable().optional(),
});
export type CreatePollInput = z.infer<typeof createPollSchema>;

/** The caller's whole choice for a poll; an empty list withdraws their vote. */
export const votePollSchema = z.object({
  optionIds: z.array(z.string().min(1)).max(POLL_LIMITS.optionsMax),
});
export type VotePollInput = z.infer<typeof votePollSchema>;

export const pollVotersQuerySchema = z.object({
  optionId: z.string().min(1),
});
export type PollVotersQuery = z.infer<typeof pollVotersQuerySchema>;

// ---- Pure helpers shared by the client and its smoke test ----

/** A whole-number share for a progress bar; 0 when nobody has voted. */
export function pollPercent(count: number, totalVoters: number): number {
  if (totalVoters <= 0 || count <= 0) return 0;
  return Math.min(100, Math.round((count / totalVoters) * 100));
}

/** Ids of the options in the lead, empty while there are no votes. Ties all lead. */
export function pollLeaders(poll: Pick<Poll, 'options'>): SnowflakeId[] {
  const top = Math.max(0, ...poll.options.map((option) => option.count));
  if (top === 0) return [];
  return poll.options.filter((option) => option.count === top).map((option) => option.id);
}

/** Whether a poll no longer takes votes, by hand or because its time ran out. */
export function isPollClosed(poll: Pick<Poll, 'closedAt' | 'closesAt'>, now = Date.now()): boolean {
  if (poll.closedAt !== null) return true;
  return poll.closesAt !== null && Date.parse(poll.closesAt) <= now;
}

/** "3 days left", "45 minutes left", "Closing soon", or "" for a poll that never closes. */
export function pollTimeLeft(closesAt: IsoTimestamp | null, now = Date.now()): string {
  if (closesAt === null) return '';
  const ms = Date.parse(closesAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'Closing soon';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} left`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} left`;
  const days = Math.ceil(hours / 24);
  return `${days} days left`;
}

/**
 * The choice a click produces. A poll with one answer swaps to the clicked
 * option (clicking the chosen one again withdraws it); one with several toggles it.
 */
export function nextPollChoice(
  poll: Pick<Poll, 'allowMultiple'>,
  current: readonly SnowflakeId[],
  optionId: SnowflakeId,
): SnowflakeId[] {
  const has = current.includes(optionId);
  if (poll.allowMultiple) return has ? current.filter((id) => id !== optionId) : [...current, optionId];
  return has ? [] : [optionId];
}

/** Folds a POLL_UPDATE into the poll a client holds, keeping the viewer's own choice in step. */
export function applyPollUpdate(poll: Poll, update: PollUpdatePayload, viewerId: SnowflakeId | null): Poll {
  const counts = new Map(update.options.map((option) => [option.id, option.count]));
  const mine = viewerId !== null && update.actorId === viewerId ? (update.actorVotes ?? []) : poll.myVotes;
  return {
    ...poll,
    closedAt: update.closedAt,
    totalVoters: update.totalVoters,
    myVotes: mine,
    options: poll.options.map((option) => ({ ...option, count: counts.get(option.id) ?? option.count })),
  };
}

/** What a draft poll form still lacks, or null when it can be sent. */
export function pollDraftProblem(draft: {
  question: string;
  options: ReadonlyArray<{ text: string }>;
}): string | null {
  if (draft.question.trim().length === 0) return 'Ask a question first.';
  const filled = draft.options.filter((option) => option.text.trim().length > 0).length;
  if (filled < POLL_LIMITS.optionsMin) return `Give at least ${POLL_LIMITS.optionsMin} options.`;
  return null;
}
