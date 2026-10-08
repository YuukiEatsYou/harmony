import type {
  Message,
  MessageDeletePayload,
  SavedMessage,
  SavedMessageListResponse,
  SavedMessageUpdatePayload,
} from '@harmony/shared';
import { api } from './api';
import { chat } from './chat.svelte';
import type { GatewayFrame } from './gateway';
import { session } from './session.svelte';
import { playSound } from './sounds';

/** The longest delay `setTimeout` honors; anything longer fires at once. */
const maxTimerMs = 2 ** 31 - 1;
/** How many reminders are kept in view. More than this at once is not a reminder any more. */
const reminderLimit = 100;

/** Soonest reminder first, the order the server hands them out in. */
function bySoonest(a: SavedMessage, b: SavedMessage): number {
  return (a.remindAt ?? '').localeCompare(b.remindAt ?? '');
}

function isDue(entry: SavedMessage, now: number): boolean {
  return entry.remindAt !== null && Date.parse(entry.remindAt) <= now;
}

/**
 * The quick choices offered by "Remind me", as Discord offers them. "Tomorrow"
 * means tomorrow morning rather than this time tomorrow, which is what someone
 * putting a message off until then usually wants.
 */
export function reminderChoices(now = new Date()): Array<{ label: string; at: Date }> {
  const minutes = (count: number): Date => new Date(now.getTime() + count * 60_000);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [
    { label: 'In 30 minutes', at: minutes(30) },
    { label: 'In 1 hour', at: minutes(60) },
    { label: 'In 3 hours', at: minutes(180) },
    { label: 'Tomorrow', at: tomorrow },
  ];
}

/**
 * The member's own saved messages, as far as the rest of the app needs them.
 *
 * Whether a particular message is saved rides on the message itself
 * (`Message.saved`), so the menu label needs nothing from here; this store keeps
 * the loaded messages' flag in step when a save changes, here or in another of
 * the member's sessions. The full list is the saved panel's to page through.
 *
 * What it does hold is the reminders, because those have to work while the panel
 * is closed: it knows when the next one is due, marks the ones that are, and
 * sounds the mention chime and raises a notice when one comes due with the app
 * open. Nothing ever leaves the page; there is no push.
 */
class SavedState {
  /** The saves carrying a reminder, soonest first. */
  reminders = $state<SavedMessage[]>([]);
  /**
   * The clock `due` is measured against. It moves only when a reminder comes due
   * or the list changes, so nothing re-renders on a tick.
   */
  #now = $state(Date.now());
  /** Reminders whose time has come, which the header button marks. */
  due = $derived(this.reminders.filter((entry) => isDue(entry, this.#now)));
  /** A reminder that came due while the app was open, for the notice. Whoever shows it clears it. */
  notice = $state<SavedMessage | null>(null);

  #timer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribe: (() => void) | null = null;

  isDue(entry: SavedMessage): boolean {
    return isDue(entry, this.#now);
  }

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = chat.onGatewayEvent((frame) => this.#handleEvent(frame));
    void this.load();
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.reminders = [];
    this.notice = null;
  }

  async load(): Promise<void> {
    try {
      const first = await api<SavedMessageListResponse>(`/users/@me/saved?reminders=true&limit=${reminderLimit}`);
      // A full page means there may be more behind it, and the reminders view has
      // no cursor to ask for them; a member with more reminders than one page
      // would otherwise have the rest left unscheduled. Fall back to walking the
      // paginated saved list, the only listing the server pages through.
      this.reminders = first.saved.length < reminderLimit ? first.saved : await this.#loadAllReminders();
      this.#schedule();
    } catch {
      // Offline or signed out: keep whatever reminders were already known.
    }
  }

  /**
   * Every save carrying a reminder, gathered by paging the saved list until a
   * short page comes back. Used only when the reminders view fills a whole page,
   * so the cost is paid only by a member with more reminders than one page holds.
   */
  async #loadAllReminders(): Promise<SavedMessage[]> {
    const reminders: SavedMessage[] = [];
    let before: SavedMessage | undefined;
    for (;;) {
      const query = new URLSearchParams({ limit: String(reminderLimit) });
      if (before) {
        query.set('before', before.savedAt);
        query.set('beforeId', before.message.id);
      }
      const body = await api<SavedMessageListResponse>(`/users/@me/saved?${query}`);
      reminders.push(...body.saved.filter((entry) => entry.remindAt !== null));
      const oldest = body.saved.at(-1);
      if (body.saved.length < reminderLimit || !oldest) break;
      before = oldest;
    }
    return reminders.sort(bySoonest);
  }

  /**
   * Saves a message. Without `remindAt` a save already holding a reminder keeps
   * it; null clears it. The gateway echoes the change to every session, this one
   * included, but the response is applied at once so the menu never lags.
   */
  async save(message: Message, remindAt?: string | null): Promise<SavedMessage> {
    const saved = await api<SavedMessage>(`/users/@me/saved/${message.id}`, {
      method: 'PUT',
      body: remindAt === undefined ? undefined : JSON.stringify({ remindAt }),
    });
    this.#apply({ messageId: message.id, channelId: message.channelId, saved });
    return saved;
  }

  async unsave(message: Message): Promise<void> {
    await api(`/users/@me/saved/${message.id}`, { method: 'DELETE' });
    this.#apply({ messageId: message.id, channelId: message.channelId, saved: null });
  }

  /** Done with a reminder: the message stays saved, it just stops reminding. */
  async clearReminder(entry: SavedMessage): Promise<SavedMessage> {
    return this.save(entry.message, null);
  }

  #apply(payload: SavedMessageUpdatePayload): void {
    const isSaved = payload.saved !== null;
    if (chat.messages.some((message) => message.id === payload.messageId && message.saved !== isSaved)) {
      chat.messages = chat.messages.map((message) =>
        message.id === payload.messageId ? { ...message, saved: isSaved } : message,
      );
    }

    const others = this.reminders.filter((entry) => entry.message.id !== payload.messageId);
    this.reminders = payload.saved?.remindAt ? [...others, payload.saved].sort(bySoonest) : others;
    if (this.notice?.message.id === payload.messageId && !payload.saved?.remindAt) this.notice = null;
    this.#schedule();
  }

  /** Waits for the next reminder still to come, if any. */
  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#now = Date.now();

    const next = this.reminders.find((entry) => !isDue(entry, this.#now));
    if (!next?.remindAt) return;
    // A few milliseconds late rather than early, so the reminder is due when it fires.
    const wait = Date.parse(next.remindAt) - Date.now() + 50;
    // A time that cannot be parsed leaves `wait` NaN, which a timer fires at once
    // and then re-arms forever over; leave that reminder unscheduled instead.
    if (!Number.isFinite(wait)) return;
    this.#timer = setTimeout(() => this.#fire(), Math.min(wait, maxTimerMs));
  }

  /**
   * A reminder came due. Only those that turned due just now get the chime and
   * the notice; one that was already overdue when the app opened is marked in
   * the panel instead, since sounding off at startup would only startle.
   */
  #fire(): void {
    this.#timer = null;
    const before = this.#now;
    const now = Date.now();
    const fresh = this.reminders.filter((entry) => !isDue(entry, before) && isDue(entry, now));
    const latest = fresh.at(-1);
    if (latest) {
      this.notice = latest;
      if (session.user?.notifyMajor) playSound('major');
    }
    this.#schedule();
  }

  #handleEvent(frame: GatewayFrame): void {
    switch (frame.t) {
      case 'SAVED_MESSAGE_UPDATE':
        this.#apply(frame.d as SavedMessageUpdatePayload);
        break;
      case 'MESSAGE_UPDATE': {
        // An edit to a message with a reminder should show in the notice and the
        // panel. The broadcast is nobody's in particular, so it says nothing about
        // whether this member saved it: keep what we know.
        const message = frame.d as Message;
        if (!this.reminders.some((entry) => entry.message.id === message.id)) break;
        this.reminders = this.reminders.map((entry) =>
          entry.message.id === message.id
            ? { ...entry, message: { ...message, reactions: entry.message.reactions, saved: true } }
            : entry,
        );
        break;
      }
      case 'MESSAGE_DELETE': {
        const payload = frame.d as MessageDeletePayload;
        this.reminders = this.reminders.filter((entry) => entry.message.id !== payload.id);
        if (this.notice?.message.id === payload.id) this.notice = null;
        break;
      }
      case 'READY':
        // A reconnect may have missed saves made elsewhere, and channels may
        // have been locked or opened meanwhile.
        void this.load();
        break;
    }
  }
}

export const saved = new SavedState();
