import type {
  MemberRosterEntry,
  MemberRosterResponse,
  PresenceUpdatePayload,
  Role,
  RoleListResponse,
} from '@harmony/shared';
import { api } from './api';
import { ResponseOrder } from './response-order';

/**
 * Who is on the server, what roles they hold, and whether they are online. This
 * backs the member list: the directory store only knows profiles, while the
 * roster adds role ids and live presence.
 */
class Roster {
  members = $state<MemberRosterEntry[]>([]);
  roles = $state<Role[]>([]);
  /** Reloads can overlap; this keeps a slow, older answer from undoing a newer one. */
  #order = new ResponseOrder();

  async load(): Promise<void> {
    const ticket = this.#order.begin();
    try {
      const [roster, roleList] = await Promise.all([
        api<MemberRosterResponse>('/members/roster'),
        api<RoleListResponse>('/roles'),
      ]);
      if (!this.#order.accept(ticket)) return;
      this.members = roster.members;
      this.roles = roleList.roles;
    } catch {
      // Signed out or offline: keep whatever we already have.
    }
  }

  /**
   * Merges one presence change. A member we have never seen is a stranger to us,
   * so the whole roster is refetched to learn their roles.
   */
  applyPresence(payload: PresenceUpdatePayload): void {
    const index = this.members.findIndex((entry) => entry.user.id === payload.user.id);
    if (index === -1) {
      void this.load();
      return;
    }

    const existing = this.members[index];
    if (!existing || existing.online === payload.online) return;

    const next = this.members.slice();
    next[index] = { ...existing, online: payload.online };
    this.members = next;
  }

  reset(): void {
    // A load still out would otherwise refill the list after signing out.
    this.#order.cancel();
    this.members = [];
    this.roles = [];
  }
}

export const roster = new Roster();
