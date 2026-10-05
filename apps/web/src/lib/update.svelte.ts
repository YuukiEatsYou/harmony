import { HARMONY_VERSION, type UpdateAvailablePayload, type UpdateStatus } from '@harmony/shared';
import { ApiError, api } from './api';
import { chat } from './chat.svelte';
import type { GatewayFrame } from './gateway';
import { session } from './session.svelte';

/** The released version the owner put the notice away for, so it stays away. */
const DISMISSED_KEY = 'harmony:update-dismissed';

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/**
 * The owner's view of the update check. The server does the checking (it has the
 * update source and the clock); this only mirrors the status and raises the
 * notice when a release turns up. Everything is owner-only, since the owner is
 * the one who holds the machine and would apply a release.
 */
class UpdateState {
  running = HARMONY_VERSION;
  latest = $state<string | null>(null);
  available = $state(false);
  checkedAt = $state<string | null>(null);
  error = $state<string | null>(null);
  autoCheck = $state(false);
  /** False when the instance has no update source configured. */
  enabled = $state(true);
  /** A manual check is in flight, so the button can say so. */
  checking = $state(false);
  /** The latest version the owner has put the notice away for. */
  dismissed = $state<string | null>(readDismissed());

  #unsubscribe: (() => void) | null = null;

  /** Whether the owner still needs to be told about the release on hand. */
  get notice(): boolean {
    return (
      session.user?.isOwner === true &&
      this.available &&
      this.latest !== null &&
      this.latest !== this.dismissed
    );
  }

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = chat.onGatewayEvent((frame) => this.#handleEvent(frame));
    void this.load();
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /** Reads the cached status; a no-op for anyone but the owner. */
  async load(): Promise<void> {
    if (session.user?.isOwner !== true) return;
    try {
      this.#apply(await api<UpdateStatus>('/update'));
    } catch {
      // Offline, or the source is switched off; the tab can try again.
    }
  }

  /** Runs a check now. */
  async check(): Promise<void> {
    this.checking = true;
    try {
      this.#apply(await api<UpdateStatus>('/update/check', { method: 'POST' }));
    } catch (cause) {
      this.error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      this.checking = false;
    }
  }

  /** Turns the daily automatic check on or off. */
  async setAutoCheck(enabled: boolean): Promise<void> {
    const previous = this.autoCheck;
    this.autoCheck = enabled;
    try {
      this.#apply(await api<UpdateStatus>('/update', { method: 'PATCH', body: JSON.stringify({ autoCheck: enabled }) }));
    } catch (cause) {
      this.autoCheck = previous;
      this.error = cause instanceof ApiError ? cause.message : String(cause);
    }
  }

  dismiss(): void {
    this.dismissed = this.latest;
    if (this.latest === null) return;
    try {
      localStorage.setItem(DISMISSED_KEY, this.latest);
    } catch {
      // A private window without storage: the notice simply comes back next time.
    }
  }

  #handleEvent(frame: GatewayFrame): void {
    if (frame.t !== 'UPDATE_AVAILABLE') return;
    const payload = frame.d as UpdateAvailablePayload;
    this.running = payload.running;
    this.latest = payload.latest;
    this.available = true;
  }

  #apply(status: UpdateStatus): void {
    this.running = status.running;
    this.latest = status.latest;
    this.available = status.available;
    this.checkedAt = status.checkedAt;
    this.autoCheck = status.autoCheck;
    this.enabled = status.enabled;
    this.error = status.error;
  }
}

export const update = new UpdateState();
