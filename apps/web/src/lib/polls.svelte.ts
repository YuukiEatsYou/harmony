import type { Message, Poll, PollVotersResponse } from '@harmony/shared';
import { api, ApiError } from './api';
import { chat } from './chat.svelte';
import { toCreatePollBody, type PollDraft } from './poll-draft';

/** How often countdowns are refreshed while a poll is on screen. */
const clockIntervalMs = 30_000;

/**
 * Poll actions and the clock their countdowns read. The polls themselves live on
 * the messages in the chat store, which the gateway keeps current; this store
 * only sends the member's requests and remembers which are in flight.
 */
class PollStore {
  /** The time countdowns count down to, refreshed while any poll is showing. */
  now = $state(Date.now());
  /** Messages with a vote or an end in flight, so a double click cannot race itself. */
  busy = $state<Record<string, boolean>>({});
  /** A refusal to show under a poll, by message id. */
  errors = $state<Record<string, string>>({});

  #watchers = 0;
  #timer: ReturnType<typeof setInterval> | null = null;

  /** Keeps `now` ticking while a poll is mounted. Returns the stop function. */
  watchClock(): () => void {
    this.now = Date.now();
    this.#watchers += 1;
    if (!this.#timer) {
      this.#timer = setInterval(() => {
        this.now = Date.now();
      }, clockIntervalMs);
    }
    return () => {
      this.#watchers -= 1;
      if (this.#watchers <= 0 && this.#timer) {
        clearInterval(this.#timer);
        this.#timer = null;
        this.#watchers = 0;
      }
    };
  }

  #fail(messageId: string, error: unknown): void {
    this.errors = {
      ...this.errors,
      [messageId]: error instanceof ApiError ? error.message : 'That did not go through. Try again.',
    };
  }

  #clear(messageId: string): void {
    if (!(messageId in this.errors)) return;
    const { [messageId]: _gone, ...rest } = this.errors;
    this.errors = rest;
  }

  /** Posts a poll to the open channel. Throws the server's refusal for the form to show. */
  async create(channelId: string, draft: PollDraft, replyToId: string | null): Promise<Message> {
    return api<Message>(`/channels/${channelId}/polls`, {
      method: 'POST',
      body: JSON.stringify({ ...toCreatePollBody(draft), replyToId }),
    });
  }

  /** Replaces the member's whole choice. An empty list withdraws it. */
  async vote(message: Message, optionIds: string[]): Promise<void> {
    if (this.busy[message.id]) return;
    this.busy = { ...this.busy, [message.id]: true };
    this.#clear(message.id);
    try {
      const poll = await api<Poll>(`/messages/${message.id}/poll/votes`, {
        method: 'PUT',
        body: JSON.stringify({ optionIds }),
      });
      chat.applyPoll(message.id, poll);
    } catch (error) {
      this.#fail(message.id, error);
    } finally {
      const { [message.id]: _done, ...rest } = this.busy;
      this.busy = rest;
    }
  }

  /** Closes a poll early. */
  async end(message: Message): Promise<void> {
    if (this.busy[message.id]) return;
    this.busy = { ...this.busy, [message.id]: true };
    this.#clear(message.id);
    try {
      const poll = await api<Poll>(`/messages/${message.id}/poll/end`, { method: 'POST' });
      chat.applyPoll(message.id, poll);
    } catch (error) {
      this.#fail(message.id, error);
    } finally {
      const { [message.id]: _done, ...rest } = this.busy;
      this.busy = rest;
    }
  }

  /** Who chose one option. */
  voters(messageId: string, optionId: string): Promise<PollVotersResponse> {
    return api<PollVotersResponse>(`/messages/${messageId}/poll/voters?optionId=${encodeURIComponent(optionId)}`);
  }
}

export const polls = new PollStore();
