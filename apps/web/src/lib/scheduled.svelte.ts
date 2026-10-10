import type {
  CreateScheduledMessageInput,
  Message,
  ScheduledMessage,
  ScheduledMessageListResponse,
  ScheduledMessageUpdatePayload,
  UpdateScheduledMessageInput,
} from '@harmony/shared';
import { api } from './api';
import { chat } from './chat.svelte';
import { gateway, type GatewayFrame } from './gateway';
import { removeScheduled, scheduledBadge, upsertScheduled } from './schedule-time';

/** A line shown beside the header button: a delivery that failed, or a schedule just made. */
export interface ScheduledNotice {
  kind: 'failed' | 'scheduled';
  text: string;
}

/**
 * The member's own scheduled messages. The server sends them, so this only
 * mirrors the queue: it loads it, follows `SCHEDULED_MESSAGE_UPDATE` from every
 * session of the member's, and says so out loud when one fails. A delivered
 * message needs nothing here beyond leaving the list; it arrives in its channel
 * like any other message.
 */
class ScheduledState {
  items = $state<ScheduledMessage[]>([]);
  loaded = $state(false);
  notice = $state<ScheduledNotice | null>(null);

  /** How many entries there are, and how many of those failed. */
  badge = $derived(scheduledBadge(this.items));

  #unsubscribe: (() => void) | null = null;
  #noticeTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = gateway.onEvent((frame) => this.#handleEvent(frame));
    void this.load();
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    this.#noticeTimer = null;
    this.items = [];
    this.loaded = false;
    this.notice = null;
  }

  async load(): Promise<void> {
    try {
      this.items = (await api<ScheduledMessageListResponse>('/users/@me/scheduled')).scheduled;
      this.loaded = true;
    } catch {
      // Offline or signed out: keep what was known.
    }
  }

  /** Channels this member has entries in, for the panel's grouping and the composer's hint. */
  channelName(channelId: string): string {
    return chat.channels.find((channel) => channel.id === channelId)?.name ?? 'a channel';
  }

  async create(channelId: string, input: CreateScheduledMessageInput): Promise<ScheduledMessage> {
    const entry = await api<ScheduledMessage>(`/channels/${channelId}/scheduled`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    // Applied at once as well as through the gateway echo, so the badge never lags.
    this.items = upsertScheduled(this.items, entry);
    return entry;
  }

  async update(id: string, input: UpdateScheduledMessageInput): Promise<ScheduledMessage> {
    const entry = await api<ScheduledMessage>(`/users/@me/scheduled/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
    this.items = upsertScheduled(this.items, entry);
    return entry;
  }

  async cancel(id: string): Promise<void> {
    await api(`/users/@me/scheduled/${id}`, { method: 'DELETE' });
    this.items = removeScheduled(this.items, id);
  }

  /** Sends one right now. Its channel gets the message through the ordinary gateway event. */
  async sendNow(id: string): Promise<Message> {
    const message = await api<Message>(`/users/@me/scheduled/${id}/send`, { method: 'POST' });
    this.items = removeScheduled(this.items, id);
    return message;
  }

  /** Shows a line for a few seconds, or until dismissed when it is a failure. */
  announce(notice: ScheduledNotice): void {
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    this.#noticeTimer = null;
    this.notice = notice;
    if (notice.kind === 'scheduled') {
      this.#noticeTimer = setTimeout(() => {
        if (this.notice === notice) this.notice = null;
      }, 5000);
    }
  }

  #handleEvent(frame: GatewayFrame): void {
    switch (frame.t) {
      case 'SCHEDULED_MESSAGE_UPDATE': {
        const payload = frame.d as ScheduledMessageUpdatePayload;
        this.items = payload.scheduled
          ? upsertScheduled(this.items, payload.scheduled)
          : removeScheduled(this.items, payload.id);
        if (payload.reason === 'failed' && payload.scheduled) {
          this.announce({
            kind: 'failed',
            text: `A scheduled message for #${this.channelName(payload.scheduled.channelId)} was not sent: ${
              payload.scheduled.error ?? 'something went wrong.'
            }`,
          });
        }
        break;
      }
      case 'CHANNEL_DELETE': {
        // The server drops a deleted channel's entries along with it.
        const channelId = (frame.d as { id?: string }).id;
        if (channelId) this.items = this.items.filter((entry) => entry.channelId !== channelId);
        break;
      }
      case 'READY':
        // A reconnect may have missed entries made, sent or failed meanwhile.
        void this.load();
        break;
    }
  }
}

export const scheduled = new ScheduledState();
