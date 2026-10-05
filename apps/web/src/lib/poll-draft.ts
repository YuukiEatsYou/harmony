import { POLL_LIMITS, pollDraftProblem, type CreatePollInput } from '@harmony/shared';

/** One row of the poll form. The key is only for the keyed list; it is never sent. */
export interface PollDraftOption {
  key: number;
  text: string;
  emoji: string;
}

/** The poll form as the member is filling it in. */
export interface PollDraft {
  question: string;
  options: PollDraftOption[];
  allowMultiple: boolean;
  /** Hours until it closes, or null for a poll that stays open. */
  durationHours: number | null;
  nextKey: number;
}

/** A fresh form: two empty options, one answer each, closing in a day. */
export function newPollDraft(): PollDraft {
  return {
    question: '',
    options: [
      { key: 1, text: '', emoji: '' },
      { key: 2, text: '', emoji: '' },
    ],
    allowMultiple: false,
    durationHours: POLL_LIMITS.defaultHours,
    nextKey: 3,
  };
}

/** The form with one more empty option, up to the limit. */
export function withAddedOption(draft: PollDraft): PollDraft {
  if (draft.options.length >= POLL_LIMITS.optionsMax) return draft;
  return {
    ...draft,
    options: [...draft.options, { key: draft.nextKey, text: '', emoji: '' }],
    nextKey: draft.nextKey + 1,
  };
}

/** The form without one option, never going below the minimum. */
export function withoutOption(draft: PollDraft, key: number): PollDraft {
  if (draft.options.length <= POLL_LIMITS.optionsMin) return draft;
  return { ...draft, options: draft.options.filter((option) => option.key !== key) };
}

/** What the form still lacks, or null when it can be sent. */
export function draftProblem(draft: PollDraft): string | null {
  return pollDraftProblem(draft);
}

/**
 * The request body for a form: blank options are dropped (a half-filled form
 * with a spare row is normal), and text is trimmed.
 */
export function toCreatePollBody(draft: PollDraft): Omit<CreatePollInput, 'replyToId'> {
  return {
    question: draft.question.trim(),
    options: draft.options
      .filter((option) => option.text.trim().length > 0)
      .map((option) => ({
        text: option.text.trim(),
        emoji: option.emoji.trim().length > 0 ? option.emoji.trim() : null,
      })),
    allowMultiple: draft.allowMultiple,
    durationHours: draft.durationHours,
  };
}
