import {
  GatewayEvent,
  GatewayOp,
  type GatewayEventName,
  type PresenceUpdatePayload,
  type User,
} from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';

interface Client {
  send: (payload: string) => void;
  disconnect: (code: number, reason: string) => void;
  auth: AuthContext | null;
}

/**
 * What a dispatched event is about, when it belongs to one channel or category.
 * Events with neither are broadcast to everyone.
 */
export interface DispatchVisibility {
  channelId?: string;
  categoryId?: string;
}

/**
 * In-process registry of connected gateway clients, used to fan out dispatch
 * events and to end a specific member's connections. One instance means no need
 * for Redis or any cross-process bus.
 *
 * Presence falls out of this registry: a member is online while they hold at
 * least one authenticated connection. Nothing about it is stored, so a restart
 * simply starts everyone offline again.
 */
export class GatewayHub {
  #clients = new Map<number, Client>();
  #nextId = 1;
  /** How many live connections each member holds. */
  #onlineCounts = new Map<string, number>();
  /** Injected by the app so the hub can ask who may see a locked resource. */
  #canSee: (userId: string, visibility: DispatchVisibility) => boolean = () => true;

  /** Lets the hub keep locked channels out of a member's gateway traffic. */
  setVisibilityResolver(resolver: (userId: string, visibility: DispatchVisibility) => boolean): void {
    this.#canSee = resolver;
  }

  /** Registers a freshly connected (but not yet identified) client. */
  register(send: (payload: string) => void, disconnect: (code: number, reason: string) => void): number {
    const id = this.#nextId++;
    this.#clients.set(id, { send, disconnect, auth: null });
    return id;
  }

  /**
   * Marks a client as authenticated after a successful IDENTIFY, announcing the
   * member coming online if this is their first connection. A repeated IDENTIFY
   * on an already-identified socket is ignored, so the count cannot drift.
   */
  authenticate(id: number, auth: AuthContext): void {
    const client = this.#clients.get(id);
    if (!client || client.auth) return;

    client.auth = auth;
    const userId = auth.user.id;
    const count = this.#onlineCounts.get(userId) ?? 0;
    this.#onlineCounts.set(userId, count + 1);
    if (count === 0) this.#announcePresence(auth.user, true);
  }

  unregister(id: number): void {
    const client = this.#clients.get(id);
    this.#clients.delete(id);
    if (!client?.auth) return;

    const userId = client.auth.user.id;
    const remaining = (this.#onlineCounts.get(userId) ?? 1) - 1;
    if (remaining > 0) {
      this.#onlineCounts.set(userId, remaining);
      return;
    }

    this.#onlineCounts.delete(userId);
    this.#announcePresence(client.auth.user, false);
  }

  /** The ids of every member with at least one live connection. */
  onlineUserIds(): Set<string> {
    return new Set(this.#onlineCounts.keys());
  }

  /**
   * Closes every connection belonging to one user, used when they are kicked or
   * banned. The client sees the close code and drops to the login screen. Pass
   * `exceptSessionId` to spare one session, e.g. the device that just changed
   * the account's password.
   */
  disconnectUser(userId: string, code: number, reason: string, exceptSessionId?: string): void {
    for (const client of this.#clients.values()) {
      if (client.auth?.user.id !== userId) continue;
      if (exceptSessionId !== undefined && client.auth.sessionId === exceptSessionId) continue;
      try {
        client.disconnect(code, reason);
      } catch {
        // A dead socket will be cleaned up by its own close handler.
      }
    }
  }

  /**
   * Sends a dispatch event to every authenticated client. When the event belongs
   * to a locked channel or category, members who cannot see it are skipped, so a
   * locked channel's messages never reach them.
   */
  dispatch(event: GatewayEventName, payload: unknown, visibility?: DispatchVisibility): void {
    const frame = JSON.stringify({ op: GatewayOp.Dispatch, t: event, d: payload });
    // One access check per member per broadcast, however many connections they hold.
    const decided = new Map<string, boolean>();

    for (const client of this.#clients.values()) {
      if (!client.auth) continue;

      if (visibility) {
        const userId = client.auth.user.id;
        let allowed = decided.get(userId);
        if (allowed === undefined) {
          allowed = this.#canSee(userId, visibility);
          decided.set(userId, allowed);
        }
        if (!allowed) continue;
      }

      try {
        client.send(frame);
      } catch {
        // A dead socket will be cleaned up by its own close handler.
      }
    }
  }

  /**
   * The connected members who may currently see a resource. Taken just before a
   * change that can hide it (a delete, or a new role requirement), because once
   * the change lands the access check can no longer say who used to see it.
   */
  audience(visibility: DispatchVisibility): Set<string> {
    const userIds = new Set<string>();
    for (const client of this.#clients.values()) {
      if (!client.auth || userIds.has(client.auth.user.id)) continue;
      if (this.#canSee(client.auth.user.id, visibility)) userIds.add(client.auth.user.id);
    }
    return userIds;
  }

  /**
   * Sends a dispatch event to exactly these members, on every connection they
   * hold. The caller has already decided who may hear it, usually with
   * {@link audience}, so no further access check is made here.
   */
  dispatchToUsers(event: GatewayEventName, payload: unknown, userIds: ReadonlySet<string>): void {
    if (userIds.size === 0) return;
    const frame = JSON.stringify({ op: GatewayOp.Dispatch, t: event, d: payload });
    for (const client of this.#clients.values()) {
      if (!client.auth || !userIds.has(client.auth.user.id)) continue;
      try {
        client.send(frame);
      } catch {
        // A dead socket will be cleaned up by its own close handler.
      }
    }
  }

  /**
   * Tells the members in `before` who can no longer see a resource that it is
   * gone for them. Used after a lock change: the update itself only reaches
   * those who may still see it, so without this the rest would keep a channel in
   * their sidebar that every request now refuses. The payload is the bare id they
   * already knew, so nothing about the new requirement leaks.
   */
  dispatchLostAccess(
    event: GatewayEventName,
    payload: unknown,
    before: ReadonlySet<string>,
    visibility: DispatchVisibility,
  ): void {
    const lost = new Set<string>();
    for (const userId of before) {
      if (!this.#canSee(userId, visibility)) lost.add(userId);
    }
    this.dispatchToUsers(event, payload, lost);
  }

  #announcePresence(user: User, online: boolean): void {
    const payload: PresenceUpdatePayload = { user, online };
    this.dispatch(GatewayEvent.PresenceUpdate, payload);
  }
}
