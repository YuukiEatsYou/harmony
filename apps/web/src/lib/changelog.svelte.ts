import { tick } from 'svelte';
import { latestChangelog, type ChangelogEntry, type ChangelogSeenResponse } from '@harmony/shared';
import { api } from './api';
import { changelogSeenKey, planChangelog } from './changelog';

function readStoredSeen(userId: string): string | null {
  try {
    return localStorage.getItem(changelogSeenKey(userId));
  } catch {
    // Storage blocked: the server's copy is the only one there is.
    return null;
  }
}

function writeStoredSeen(userId: string, version: string): void {
  try {
    localStorage.setItem(changelogSeenKey(userId), version);
  } catch {
    // Storage blocked: the server's copy has to do on its own.
  }
}

/** Tells the server a release's notes were shown. Best-effort: the copy in this browser covers a failure. */
function reportSeen(version: string): void {
  void api('/users/@me/changelog', { method: 'PUT', body: JSON.stringify({ version }) }).catch(() => {
    // The next visit sends it again; see planChangelog.
  });
}

/**
 * The "What's new" dialog: whether there are notes the member signed in has not
 * seen, and which notes are on screen. The decisions are in changelog.ts.
 *
 * Notes found on opening are held in `due` rather than shown straight away, so
 * the dialog can wait for whatever has to come first (the setup wizard) without
 * the notes being counted as seen before anyone could read them.
 */
class ChangelogState {
  /** The notes on screen, or null while the dialog is closed. */
  shown = $state<ChangelogEntry | null>(null);
  /** Notes the member has not seen, waiting to be shown. */
  due = $state<ChangelogEntry | null>(null);
  /** The account the server was last asked about, so one sign-in asks once. */
  #checkedFor: string | null = null;
  /** Whatever had focus before the dialog opened, to hand focus back to. */
  #returnTo: HTMLElement | null = null;

  /** Asks the server what this member last saw, and holds the notes when they are news. */
  async check(userId: string): Promise<void> {
    if (this.#checkedFor === userId) return;
    this.#checkedFor = userId;
    let serverSeen: string | null;
    try {
      serverSeen = (await api<ChangelogSeenResponse>('/users/@me/changelog')).seen;
    } catch {
      // Without the server's answer there is no telling whether this is news,
      // and a stray dialog is worse than a late one, so say nothing until the
      // next visit asks again.
      return;
    }
    // Signed out, or in as someone else, while the answer was on its way.
    if (this.#checkedFor !== userId) return;

    const plan = planChangelog(serverSeen, readStoredSeen(userId));
    if (plan.report) reportSeen(plan.report);
    this.due = plan.show;
  }

  /**
   * Shows the held notes and records them as seen, here and on the server, as
   * soon as they appear rather than when they are closed: a reload or a second
   * tab should not bring them back, however the dialog ends.
   */
  showDue(): void {
    const entry = this.due;
    const userId = this.#checkedFor;
    if (!entry || !userId) return;
    this.due = null;
    this.#open(entry);
    writeStoredSeen(userId, entry.version);
    reportSeen(entry.version);
  }

  /** Opens the newest notes again on request, from About. What has been seen is left alone. */
  openLatest(): void {
    const entry = latestChangelog();
    if (entry) this.#open(entry);
  }

  /** Closes the dialog and hands focus back once it has gone. */
  async close(): Promise<void> {
    if (this.shown === null) return;
    this.shown = null;
    const target = this.#returnTo;
    this.#returnTo = null;
    await tick();
    // The opener may have gone meanwhile, and focusing a detached node does nothing.
    if (target?.isConnected) target.focus({ preventScroll: true });
  }

  /** Forgets everything, for when the chat goes away on signing out. */
  reset(): void {
    this.shown = null;
    this.due = null;
    this.#checkedFor = null;
    this.#returnTo = null;
  }

  #open(entry: ChangelogEntry): void {
    if (this.shown === null) {
      const focused = document.activeElement;
      this.#returnTo = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    }
    this.shown = entry;
  }
}

export const changelog = new ChangelogState();
