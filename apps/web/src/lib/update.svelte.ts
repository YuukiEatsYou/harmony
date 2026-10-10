import {
  DEFAULT_UPDATE_BACKUP_RETENTION,
  HARMONY_VERSION,
  type UpdateAvailablePayload,
  type UpdatePanel,
  type UpdateSnapshotInfo,
  type UpdateStatus,
} from '@harmony/shared';
import { ApiError, api } from './api';
import { gateway, type GatewayFrame } from './gateway';
import { session } from './session.svelte';

/** The released version the owner put the notice away for, so it stays away. */
const DISMISSED_KEY = 'harmony:update-dismissed';

/** How long to watch for a restart before giving up on the button's spinner. */
const RESTART_WATCH_MS = 15 * 60 * 1000;
/** How often to ask whether the restart has happened. */
const RESTART_POLL_MS = 2000;

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  /** The configured apply command, or null when the button is switched off. */
  command = $state<string | null>(null);
  /** How many pre-update snapshots stay on disk. */
  backupRetention = $state(DEFAULT_UPDATE_BACKUP_RETENTION);
  /** An apply is running now (including the wait through the restart). */
  applying = $state(false);
  /** The tail of the running or last apply's output. */
  log = $state('');
  /** True when the last apply ended in failure. */
  failed = $state(false);
  /** The id of the process that answered last; a change means it restarted. */
  instanceId = $state('');
  /** The retained pre-update snapshots, newest first. */
  snapshots = $state<UpdateSnapshotInfo[]>([]);
  /** The latest version the owner has put the notice away for. */
  dismissed = $state<string | null>(readDismissed());

  #unsubscribe: (() => void) | null = null;
  #watching = false;

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
    this.#unsubscribe = gateway.onEvent((frame) => this.#handleEvent(frame));
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
      this.#applyPanel(await api<UpdatePanel>('/update'));
    } catch {
      // Offline, or the source is switched off; the tab can try again.
    }
  }

  /** Runs a check now. */
  async check(): Promise<void> {
    this.checking = true;
    try {
      this.#applyPanel(await api<UpdatePanel>('/update/check', { method: 'POST' }));
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
    await this.#patch({ autoCheck: enabled }, () => {
      this.autoCheck = previous;
    });
  }

  /** Changes how many pre-update snapshots stay on disk. */
  async setBackupRetention(count: number): Promise<void> {
    const previous = this.backupRetention;
    this.backupRetention = count;
    await this.#patch({ backupRetention: count }, () => {
      this.backupRetention = previous;
    });
  }

  /**
   * Starts an apply. With `backup` the server snapshots the database first. It then
   * runs the command and, on success, restarts, so this watches through the outage
   * and reloads the page once the new build answers.
   */
  async apply(backup: boolean): Promise<void> {
    if (this.applying) return;
    this.applying = true;
    this.log = '';
    this.failed = false;
    try {
      this.#applyPanel(await api<UpdatePanel>('/update/apply', { method: 'POST', body: JSON.stringify({ backup }) }));
    } catch (cause) {
      this.applying = false;
      this.error = cause instanceof ApiError ? cause.message : String(cause);
      return;
    }
    // A command that already stopped (a fast failure) is fully described by the panel.
    if (!this.applying) return;
    void this.#watchRestart(this.instanceId);
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

  /** Polls through the restart. The server goes away, then comes back as a new process. */
  async #watchRestart(instance: string): Promise<void> {
    if (this.#watching) return;
    this.#watching = true;
    const deadline = Date.now() + RESTART_WATCH_MS;
    try {
      while (Date.now() < deadline) {
        await delay(RESTART_POLL_MS);
        try {
          const panel = await api<UpdatePanel>('/update');
          this.#applyPanel(panel);
          // A different process is serving: the restart finished, load the new build.
          if (panel.instanceId !== instance) {
            location.reload();
            return;
          }
          // Answered but no longer applying: the command stopped without a restart.
          if (!panel.applying) return;
        } catch {
          // The server is down for the restart; keep waiting.
        }
      }
    } finally {
      this.#watching = false;
      this.applying = false;
    }
  }

  async #patch(body: Record<string, unknown>, rollback: () => void): Promise<void> {
    try {
      this.#applyPanel(await api<UpdatePanel>('/update', { method: 'PATCH', body: JSON.stringify(body) }));
    } catch (cause) {
      rollback();
      this.error = cause instanceof ApiError ? cause.message : String(cause);
    }
  }

  #handleEvent(frame: GatewayFrame): void {
    if (frame.t !== 'UPDATE_AVAILABLE') return;
    const payload = frame.d as UpdateAvailablePayload;
    this.running = payload.running;
    this.latest = payload.latest;
    this.available = true;
  }

  #applyPanel(panel: UpdatePanel): void {
    this.#applyStatus(panel);
    this.instanceId = panel.instanceId;
    this.command = panel.command;
    this.backupRetention = panel.backupRetention;
    this.applying = panel.applying;
    this.log = panel.log;
    this.failed = panel.failed;
    this.snapshots = panel.snapshots;
  }

  #applyStatus(status: UpdateStatus): void {
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
