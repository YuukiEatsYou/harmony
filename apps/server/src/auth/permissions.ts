import type { DatabaseSync } from 'node:sqlite';
import { ALL_PERMISSIONS, type PermissionValue } from '@harmony/shared';
import { getDefaultRolePermissions, getUserRolePermissions } from '../db/roles.ts';
import type { UserRow } from '../db/users.ts';

/**
 * Effective permissions for a user: the instance owner implicitly has
 * everything; otherwise it is `@everyone` OR-ed with the user's roles.
 */
export function resolvePermissions(sqlite: DatabaseSync, user: UserRow): PermissionValue {
  // A bot's authority is exactly the bitfield the owner granted its token: it holds
  // no roles, and its Administrator bit implies the rest as it does for anyone.
  if (user.account_type === 'bot') return parseBits(user.bot_permissions);
  if (user.is_owner === 1) return ALL_PERMISSIONS;
  return getDefaultRolePermissions(sqlite) | getUserRolePermissions(sqlite, user.id);
}

/** A stored bot bitfield as a bigint; anything unreadable is none. */
function parseBits(raw: string): PermissionValue {
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}
