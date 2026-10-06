import type { DatabaseSync } from 'node:sqlite';
import {
  GatewayCloseCode,
  GatewayEvent,
  Permission,
  hasPermission,
  type Ban,
} from '@harmony/shared';
import { resolvePermissions } from '../auth/permissions.ts';
import type { AuthContext } from '../auth/service.ts';
import type { AuditService } from '../audit/service.ts';
import { deleteBan, findBan, insertBan, listBans } from '../db/bans.ts';
import { deleteSessionsForUser } from '../db/sessions.ts';
import { deleteUser, findUserById, presentUser, setUserTimeout, type UserRow } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { GatewayHub } from '../realtime/hub.ts';

export interface ModerationService {
  timeoutMember(actor: AuthContext, targetId: string, durationMinutes: number): void;
  clearTimeout(actor: AuthContext, targetId: string): void;
  kickMember(actor: AuthContext, targetId: string): void;
  banMember(actor: AuthContext, targetId: string, reason: string | null): void;
  unbanMember(actor: AuthContext, targetId: string): void;
  /** Deletes an ordinary account outright. The owner and administrators are
   * immune, even to each other, and it can never be aimed at yourself. */
  deleteMember(actor: AuthContext, targetId: string): void;
  listBans(): Ban[];
}

export interface ModerationDeps {
  sqlite: DatabaseSync;
  hub: GatewayHub;
  audit: AuditService;
}

export function createModerationService(deps: ModerationDeps): ModerationService {
  const { sqlite, hub, audit } = deps;

  /**
   * Every moderation action shares the same target rules. A full role hierarchy
   * is deliberately not modelled: the only protection is that nobody holding
   * Administrator can be moderated, which keeps roles flat and predictable.
   */
  function requireTarget(actor: AuthContext, targetId: string): UserRow {
    const target = findUserById(sqlite, targetId);
    if (!target) throw new HttpError(404, 'user_not_found', 'That member does not exist.');
    if (target.id === actor.user.id) {
      throw new HttpError(400, 'cannot_moderate_self', 'You cannot moderate yourself.');
    }
    if (target.account_type !== 'user') {
      throw new HttpError(400, 'cannot_moderate_bot', 'Bots and Discord stand-in accounts cannot be moderated.');
    }
    if (hasPermission(resolvePermissions(sqlite, target), Permission.Administrator)) {
      throw new HttpError(
        403,
        'target_is_admin',
        'Administrators cannot be moderated. Remove their admin role first.',
      );
    }
    return target;
  }

  /**
   * The target rules for deleting an account, which are stricter than moderation:
   * the owner and every administrator are protected even from each other, since
   * removing an account cannot be undone. Only ordinary members can go.
   */
  function requireDeletable(actor: AuthContext, targetId: string): UserRow {
    const target = findUserById(sqlite, targetId);
    if (!target) throw new HttpError(404, 'user_not_found', 'That member does not exist.');
    if (target.id === actor.user.id) {
      throw new HttpError(400, 'cannot_delete_self', 'You cannot delete your own account.');
    }
    if (target.account_type !== 'user') {
      throw new HttpError(400, 'cannot_delete_bot', 'Bots and Discord stand-in accounts are managed elsewhere.');
    }
    if (target.is_owner === 1) {
      throw new HttpError(403, 'target_is_owner', 'The owner cannot be deleted.');
    }
    if (hasPermission(resolvePermissions(sqlite, target), Permission.Administrator)) {
      throw new HttpError(403, 'target_is_admin', 'Administrators cannot be deleted.');
    }
    return target;
  }

  /** Member state changed, so clients refetch their roster and their own profile. */
  function announceMember(userId: string): void {
    hub.dispatch(GatewayEvent.MemberUpdate, { userId });
  }

  return {
    timeoutMember(actor, targetId, durationMinutes) {
      const target = requireTarget(actor, targetId);
      const until = new Date(Date.now() + durationMinutes * 60_000).toISOString();
      setUserTimeout(sqlite, target.id, until);
      audit.moderation('timeout_add', actor.user.id, target.id, { durationMinutes });
      announceMember(target.id);
    },

    clearTimeout(actor, targetId) {
      const target = requireTarget(actor, targetId);
      setUserTimeout(sqlite, target.id, null);
      audit.moderation('timeout_clear', actor.user.id, target.id);
      announceMember(target.id);
    },

    kickMember(actor, targetId) {
      const target = requireTarget(actor, targetId);
      // A kick ends their sessions and live connections; they may log back in.
      deleteSessionsForUser(sqlite, target.id);
      hub.disconnectUser(target.id, GatewayCloseCode.Removed, 'You were removed from this server.');
      audit.moderation('kick', actor.user.id, target.id);
      announceMember(target.id);
    },

    banMember(actor, targetId, reason) {
      const target = requireTarget(actor, targetId);
      const cleaned = reason && reason.length > 0 ? reason : null;
      insertBan(sqlite, {
        userId: target.id,
        bannedBy: actor.user.id,
        reason: cleaned,
        createdAt: new Date().toISOString(),
      });
      deleteSessionsForUser(sqlite, target.id);
      hub.disconnectUser(target.id, GatewayCloseCode.Removed, 'You were banned from this server.');
      audit.moderation('ban', actor.user.id, target.id, { reason: cleaned });
      announceMember(target.id);
    },

    unbanMember(actor, targetId) {
      if (!findBan(sqlite, targetId)) {
        throw new HttpError(404, 'not_banned', 'That member is not banned.');
      }
      deleteBan(sqlite, targetId);
      audit.moderation('unban', actor.user.id, targetId);
      announceMember(targetId);
    },

    deleteMember(actor, targetId) {
      const target = requireDeletable(actor, targetId);
      // End their sessions and live connections first, then remove the row. The
      // schema cascades what is theirs and nulls the rest; their messages stay
      // behind with no author.
      deleteSessionsForUser(sqlite, target.id);
      hub.disconnectUser(target.id, GatewayCloseCode.Removed, 'Your account was deleted.');
      audit.memberDeleted(actor.user.id, target.id);
      deleteUser(sqlite, target.id);
      announceMember(target.id);
    },

    listBans() {
      const bans: Ban[] = [];
      for (const row of listBans(sqlite)) {
        const user = findUserById(sqlite, row.user_id);
        if (!user) continue;
        const bannedBy = row.banned_by ? findUserById(sqlite, row.banned_by) : null;
        bans.push({
          user: presentUser(sqlite, user),
          bannedBy: bannedBy ? presentUser(sqlite, bannedBy) : null,
          reason: row.reason,
          createdAt: row.created_at,
        });
      }
      return bans;
    },
  };
}
