import {
  Permission,
  hasPermission,
  permissionsFromString,
  type CreateEventInput,
  type EventInterestedResponse,
  type EventListResponse,
  type EventReminderPayload,
  type EventUpdatePayload,
  type ServerEvent,
  type UpdateEventInput,
} from '@harmony/shared';
import { api } from './api';
import { chat } from './chat.svelte';
import { applyEventUpdate, removeEvent, reminderText, upsertEvent } from './event-form';
import type { GatewayFrame } from './gateway';
import { session } from './session.svelte';
import { playNotification } from './sounds';

/** A reminder that arrived while the app was open. */
export interface EventNotice {
  event: ServerEvent;
  text: string;
}

/**
 * The server events this member can see. The server owns the clock (it starts
 * and ends events and sends the reminder), so this only mirrors the list: it
 * loads it, follows `EVENT_UPDATE`, and turns `EVENT_REMINDER` into a notice with
 * the mention chime. Nothing is timed in the browser.
 */
class EventsState {
  items = $state<ServerEvent[]>([]);
  loaded = $state(false);
  /** The latest reminder, shown beside the header button until dismissed. */
  notice = $state<EventNotice | null>(null);

  /** How many events are happening right now, for the header button. */
  liveCount = $derived(this.items.filter((event) => event.status === 'active').length);

  #unsubscribe: (() => void) | null = null;

  /** Whether this member may create events, and so see the create button. */
  get canCreate(): boolean {
    return hasPermission(permissionsFromString(session.permissions), Permission.ManageEvents);
  }

  /** Creators can always change their own; otherwise it takes Manage Events. */
  canManage(event: ServerEvent): boolean {
    return this.canCreate || (event.creator !== null && event.creator.id === session.user?.id);
  }

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = chat.onGatewayEvent((frame) => this.#handleEvent(frame));
    void this.load();
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.items = [];
    this.loaded = false;
    this.notice = null;
  }

  async load(): Promise<void> {
    try {
      this.items = (await api<EventListResponse>('/events')).events;
      this.loaded = true;
    } catch {
      // Offline or signed out: keep what was known.
    }
  }

  async create(input: CreateEventInput): Promise<ServerEvent> {
    const event = await api<ServerEvent>('/events', { method: 'POST', body: JSON.stringify(input) });
    this.#adopt(event);
    return event;
  }

  async update(id: string, input: UpdateEventInput): Promise<ServerEvent> {
    const event = await api<ServerEvent>(`/events/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
    this.#adopt(event);
    return event;
  }

  async cancel(id: string): Promise<ServerEvent> {
    const event = await api<ServerEvent>(`/events/${id}/cancel`, { method: 'POST' });
    this.#adopt(event);
    return event;
  }

  /** Marks or withdraws the member's interest. The reply is applied at once; the broadcast follows. */
  async setInterested(id: string, interested: boolean): Promise<ServerEvent> {
    const event = await api<ServerEvent>(`/events/${id}/interested`, { method: interested ? 'PUT' : 'DELETE' });
    this.#adopt(event);
    return event;
  }

  /** The names behind an event's count, fetched when asked for. */
  interested(id: string): Promise<EventInterestedResponse> {
    return api<EventInterestedResponse>(`/events/${id}/interested`);
  }

  channelName(channelId: string | null): string {
    if (!channelId) return 'a channel';
    return chat.channels.find((channel) => channel.id === channelId)?.name ?? 'a channel';
  }

  /** A response is this member's own view, so it replaces the held copy outright. */
  #adopt(event: ServerEvent): void {
    this.items = upsertEvent(this.items, event);
  }

  #handleEvent(frame: GatewayFrame): void {
    switch (frame.t) {
      case 'EVENT_UPDATE':
        this.items = applyEventUpdate(this.items, frame.d as EventUpdatePayload, session.user?.id ?? null);
        break;
      case 'EVENT_REMINDER': {
        const { event } = frame.d as EventReminderPayload;
        // Keep the list's copy fresh, but the viewer is interested by definition.
        this.items = upsertEvent(this.items, { ...event, interested: true });
        this.notice = { event, text: reminderText(event, Date.now()) };
        if (session.user?.notifyMajor) playNotification('major');
        break;
      }
      case 'CHANNEL_DELETE': {
        // The server deletes a channel's events with it.
        const channelId = (frame.d as { id?: string }).id;
        if (channelId) {
          for (const event of this.items) {
            if (event.channelId === channelId) this.items = removeEvent(this.items, event.id);
          }
        }
        break;
      }
      case 'READY':
        // A reconnect may have missed updates, and channels may have been locked or opened meanwhile.
        void this.load();
        break;
    }
  }
}

export const events = new EventsState();
