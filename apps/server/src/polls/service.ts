import type { DatabaseSync } from 'node:sqlite';
import {
  GatewayEvent,
  POLL_LIMITS,
  Permission,
  hasPermission,
  type CreatePollInput,
  type Message,
  type Poll,
  type PollUpdatePayload,
  type PollVotersResponse,
  type VotePollInput,
} from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';
import { assertNotTimedOut } from '../auth/guards.ts';
import { canAccessChannel, channelAccessFor } from '../access/service.ts';
import { findMessage, type MessageRow } from '../db/messages.ts';
import {
  closePoll,
  deleteVote,
  findPollByMessage,
  insertVote,
  listExpiredOpenPolls,
  listPollOptions,
  listVoters,
  listVotesOf,
  loadPollsForMessages,
  replaceVotes,
  type PollRow,
} from '../db/polls.ts';
import { findUserById, presentUser } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { MessageService } from '../messages/service.ts';
import type { GatewayHub } from '../realtime/hub.ts';

/** How often the clock is checked for polls whose time is up. */
const SWEEP_INTERVAL_MS = 15_000;

/**
 * Poll voting and closing.
 *
 * A poll is created through the message service, because it is a message. This
 * service owns what happens after: votes, ending, the clock, and the realtime
 * updates. Like the message service it separates what members do (checked, and
 * announced to the bridge through `onPollEnded`) from what the bridge applies on
 * Discord's behalf (the `*Bridged` variants, which skip permission checks and
 * notify nobody), so a vote or a close can never bounce between the two sides.
 */
export interface PollService {
  /** Creates a poll message. The options and limits were validated by the schema. */
  create(auth: AuthContext, channelId: string, input: CreatePollInput): Message;
  /** Replaces the caller's choice. An empty list withdraws their vote. */
  vote(auth: AuthContext, messageId: string, input: VotePollInput): Poll;
  /** Closes a poll early. The author or anyone with Manage Messages may. */
  end(auth: AuthContext, messageId: string): Poll;
  /** Who chose one option. Polls are not anonymous, but only members who can see the channel ask. */
  voters(auth: AuthContext, messageId: string, optionId: string): PollVotersResponse;
  /** Closes every poll whose time is up; returns how many. Runs on a timer too. */
  sweepExpired(): number;
  start(): void;
  stop(): void;
  /**
   * A Discord voter picked an answer (`add`) or took it back. `importing` lets the
   * first read of a poll that Discord has already closed record who voted, and
   * stays quiet: an import records every voter, so it announces once at the end
   * with `announceBridged` rather than once per vote.
   */
  voteBridged(messageId: string, discordAnswerId: number, userId: string, add: boolean, importing?: boolean): boolean;
  /** Tells the channel a poll's counts after a quiet import. */
  announceBridged(messageId: string): void;
  /** Discord closed a poll made there. */
  closeBridged(messageId: string): boolean;
  /** Notified when a member ends a poll by hand, never for bridged closes or the clock. */
  onPollEnded(listener: (message: Message) => void): void;
}

export function createPollService(
  sqlite: DatabaseSync,
  hub: GatewayHub,
  messages: MessageService,
  options: { sweepMs?: number } = {},
): PollService {
  const endedListeners = new Set<(message: Message) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function requirePoll(messageId: string): { message: MessageRow; poll: PollRow } {
    const message = findMessage(sqlite, messageId);
    const poll = message && !message.deleted_at ? findPollByMessage(sqlite, messageId) : null;
    if (!message || !poll) throw new HttpError(404, 'poll_not_found', 'That poll does not exist.');
    return { message, poll };
  }

  function assertChannelAccess(userId: string, channelId: string): void {
    if (!canAccessChannel(sqlite, channelAccessFor(sqlite, userId), channelId)) {
      throw new HttpError(403, 'channel_forbidden', 'You do not have access to that channel.');
    }
  }

  function isClosed(poll: PollRow, now = Date.now()): boolean {
    if (poll.closed_at !== null) return true;
    return poll.closes_at !== null && Date.parse(poll.closes_at) <= now;
  }

  function viewOf(messageId: string, viewerId: string): Poll {
    const poll = loadPollsForMessages(sqlite, [messageId], viewerId).get(messageId);
    if (!poll) throw new HttpError(404, 'poll_not_found', 'That poll does not exist.');
    return poll;
  }

  /** Sends the new counts to everyone who can see the channel. */
  function announce(message: MessageRow, actorId: string | null): void {
    const poll = viewOf(message.id, actorId ?? '');
    const payload: PollUpdatePayload = {
      messageId: message.id,
      channelId: message.channel_id,
      closedAt: poll.closedAt,
      options: poll.options.map((option) => ({ id: option.id, count: option.count })),
      totalVoters: poll.totalVoters,
      actorId,
      actorVotes: actorId === null ? null : poll.myVotes,
    };
    hub.dispatch(GatewayEvent.PollUpdate, payload, { channelId: message.channel_id });
  }

  /** Closes a poll whose clock ran out. Idempotent, so a racing sweep is harmless. */
  function closeByClock(message: MessageRow, poll: PollRow): void {
    if (closePoll(sqlite, poll.id, poll.closes_at ?? new Date().toISOString())) announce(message, null);
  }

  /** A closed poll reads as closed even in the moments before the sweep notices. */
  function assertOpen(message: MessageRow, poll: PollRow): void {
    if (!isClosed(poll)) return;
    if (poll.closed_at === null) closeByClock(message, poll);
    throw new HttpError(409, 'poll_closed', 'This poll is closed.');
  }

  function safeNotify(listener: (message: Message) => void, message: Message): void {
    try {
      listener(message);
    } catch (error) {
      void error;
    }
  }

  return {
    create(auth, channelId, input) {
      const closesAt =
        input.durationHours === null ? null : new Date(Date.now() + input.durationHours * 3_600_000).toISOString();
      return messages.createPoll(
        auth,
        channelId,
        {
          question: input.question,
          options: input.options.map((option) => ({
            text: option.text,
            emoji: option.emoji && option.emoji.length > 0 ? option.emoji : null,
          })),
          allowMultiple: input.allowMultiple,
          closesAt,
          source: 'harmony',
        },
        input.replyToId ?? null,
      );
    },

    vote(auth, messageId, input) {
      assertNotTimedOut(auth);
      const { message, poll } = requirePoll(messageId);
      assertChannelAccess(auth.user.id, message.channel_id);
      assertOpen(message, poll);

      const valid = new Set(listPollOptions(sqlite, poll.id).map((option) => option.id));
      const chosen = [...new Set(input.optionIds)];
      if (chosen.some((id) => !valid.has(id))) {
        throw new HttpError(400, 'invalid_option', 'One of those options is not part of this poll.');
      }
      if (poll.allow_multiple === 0 && chosen.length > 1) {
        throw new HttpError(400, 'single_choice', 'This poll takes one answer.');
      }

      replaceVotes(sqlite, poll.id, auth.user.id, chosen, new Date().toISOString());
      announce(message, auth.user.id);
      return viewOf(messageId, auth.user.id);
    },

    end(auth, messageId) {
      const { message, poll } = requirePoll(messageId);
      assertChannelAccess(auth.user.id, message.channel_id);
      if (message.author_id !== auth.user.id && !hasPermission(auth.permissions, Permission.ManageMessages)) {
        throw new HttpError(403, 'forbidden', 'Only the poll author or a moderator can end it.');
      }
      if (poll.source === 'discord') {
        throw new HttpError(409, 'poll_external', 'This poll lives on Discord. End it there.');
      }
      if (poll.closed_at !== null) throw new HttpError(409, 'poll_closed', 'This poll is already closed.');

      closePoll(sqlite, poll.id, new Date().toISOString());
      announce(message, null);
      const rendered = messages.byId(messageId, auth.user.id);
      if (rendered) for (const listener of endedListeners) safeNotify(listener, rendered);
      return viewOf(messageId, auth.user.id);
    },

    voters(auth, messageId, optionId) {
      const { message, poll } = requirePoll(messageId);
      assertChannelAccess(auth.user.id, message.channel_id);
      const option = listPollOptions(sqlite, poll.id).find((candidate) => candidate.id === optionId);
      if (!option) throw new HttpError(404, 'option_not_found', 'That option does not exist.');

      const total = viewOf(messageId, '').options.find((candidate) => candidate.id === optionId)?.count ?? 0;
      const voters = [];
      for (const voter of listVoters(sqlite, optionId, POLL_LIMITS.votersPage)) {
        const row = findUserById(sqlite, voter.userId);
        if (row) voters.push({ user: presentUser(sqlite, row), votedAt: voter.votedAt });
      }
      return { optionId, total, voters };
    },

    sweepExpired() {
      let closed = 0;
      for (const poll of listExpiredOpenPolls(sqlite, new Date().toISOString())) {
        const message = findMessage(sqlite, poll.message_id);
        if (!message) continue;
        // A poll whose message was deleted is closed quietly: nobody can see it.
        if (message.deleted_at) {
          closePoll(sqlite, poll.id, poll.closes_at ?? new Date().toISOString());
          continue;
        }
        closeByClock(message, poll);
        closed++;
      }
      return closed;
    },

    start() {
      if (timer) return;
      this.sweepExpired();
      timer = setInterval(() => {
        try {
          this.sweepExpired();
        } catch (error) {
          void error;
        }
      }, options.sweepMs ?? SWEEP_INTERVAL_MS);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    voteBridged(messageId, discordAnswerId, userId, add, importing = false) {
      const message = findMessage(sqlite, messageId);
      if (!message || message.deleted_at) return false;
      const poll = findPollByMessage(sqlite, messageId);
      if (!poll || (isClosed(poll) && !importing)) return false;
      const option = listPollOptions(sqlite, poll.id).find((candidate) => candidate.discord_answer_id === discordAnswerId);
      if (!option) return false;

      let changed: boolean;
      if (add) {
        // Discord enforces one answer itself, but this person may also have voted
        // here: a single-answer poll holds one choice per person, the latest.
        if (poll.allow_multiple === 0) {
          for (const held of listVotesOf(sqlite, poll.id, userId)) {
            if (held !== option.id) deleteVote(sqlite, held, userId);
          }
        }
        changed = insertVote(sqlite, poll.id, option.id, userId, new Date().toISOString());
      } else {
        changed = deleteVote(sqlite, option.id, userId);
      }
      if (changed && !importing) announce(message, userId);
      return changed;
    },

    announceBridged(messageId) {
      const message = findMessage(sqlite, messageId);
      if (message && !message.deleted_at && findPollByMessage(sqlite, messageId)) announce(message, null);
    },

    closeBridged(messageId) {
      const message = findMessage(sqlite, messageId);
      if (!message || message.deleted_at) return false;
      const poll = findPollByMessage(sqlite, messageId);
      // Only a poll made on Discord is Discord's to close; one made here is ours.
      if (!poll || poll.source !== 'discord') return false;
      if (!closePoll(sqlite, poll.id, new Date().toISOString())) return false;
      announce(message, null);
      return true;
    },

    onPollEnded(listener) {
      endedListeners.add(listener);
    },
  };
}
