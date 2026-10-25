/**
 * How long the gateway has to stay quiet about members and roles before the
 * reload they call for runs. Long enough to gather an administrator's run of
 * clicks, or a palette change that announces each affected member in turn, and
 * short enough that the change still looks immediate.
 */
export const MEMBER_RELOAD_QUIET_MS = 300;

/**
 * The longest a reload is put off while changes keep arriving, so a long run of
 * them, such as the bridge bringing many members' pictures in step, still shows
 * progress instead of waiting for the very last one.
 */
export const MEMBER_RELOAD_MAX_WAIT_MS = 2000;

/** What one reload has to bring in step. */
export interface MemberReload {
  /**
   * The members whose messages on screen should be checked for a new name,
   * picture or color, or null for everyone, as after a role change, which can
   * recolor any number of people at once.
   */
  authors: ReadonlySet<string> | null;
  /** Whether a role changed, which can also lock or unlock channels. */
  channels: boolean;
}

/**
 * Gathers the member and role changes that arrive close together, so a burst
 * of them reloads the member directory and the roster once rather than once
 * per event. Every connected client hears every such event, so without this a
 * role handed to five people made every member's client fetch both lists five
 * times over.
 *
 * It only keeps the books; the caller owns the timer. Each change returns how
 * long to wait from now, and when that runs out the caller takes what has
 * gathered and reloads once for all of it.
 */
export class MemberReloadQueue {
  /** When the first change of the batch arrived, or null while it is empty. */
  #firstAt: number | null = null;
  #userIds = new Set<string>();
  #roles = false;

  /** Notes that one member changed. Returns how long to wait before reloading. */
  member(userId: string, now: number): number {
    this.#userIds.add(userId);
    return this.#delay(now);
  }

  /** Notes that a role was created, changed or deleted. Returns how long to wait. */
  role(now: number): number {
    this.#roles = true;
    return this.#delay(now);
  }

  /** Hands over what has gathered and starts a new batch, or null when nothing has. */
  take(): MemberReload | null {
    if (this.#firstAt === null) return null;
    const reload: MemberReload = {
      authors: this.#roles ? null : this.#userIds,
      channels: this.#roles,
    };
    this.clear();
    return reload;
  }

  /** Drops whatever has gathered, for signing out. */
  clear(): void {
    this.#firstAt = null;
    this.#userIds = new Set();
    this.#roles = false;
  }

  /** The quiet period, cut short once the batch has waited as long as it may. */
  #delay(now: number): number {
    this.#firstAt ??= now;
    const left = this.#firstAt + MEMBER_RELOAD_MAX_WAIT_MS - now;
    return Math.max(0, Math.min(MEMBER_RELOAD_QUIET_MS, left));
  }
}
