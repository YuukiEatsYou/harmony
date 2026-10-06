import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ALL_PERMISSIONS,
  permissionsToString,
  type BotListResponse,
  type BotSummary,
  type PermissionValue,
} from '@harmony/shared';
import { generateSessionToken } from '../auth/tokens.ts';
import { listBotTokens, setBotToken } from '../db/bot_tokens.ts';
import {
  deleteUser,
  findUserById,
  findUserByUsername,
  insertBotUser,
  listBots,
  parsePermissionBits,
  presentUser,
  setBotPermissions,
  setUsername,
  updateUserProfile,
  type UserRow,
} from '../db/users.ts';
import { HttpError } from '../http/errors.ts';

/**
 * Keeps only the permission bits this instance knows, so a token can never carry a
 * phantom permission from a typo or a flag a future version removes. Administrator
 * survives this, as it should: it is a real bit that implies the rest.
 */
export function maskPermissions(bits: PermissionValue): PermissionValue {
  return bits & ALL_PERMISSIONS;
}

export interface BotService {
  list(): BotListResponse;
  /** A single bot's summary, or throws `404 bot_not_found`. */
  get(id: string): BotSummary;
  /** Creates a bot and issues its first token, which is shown only here. */
  create(input: { username: string; displayName: string | null; permissions: PermissionValue }): {
    bot: BotSummary;
    token: string;
  };
  update(
    id: string,
    patch: { username?: string; displayName?: string | null; permissions?: PermissionValue },
  ): BotSummary;
  /** Issues a new token, invalidating the old one. Returned only here. */
  regenerateToken(id: string): string;
  remove(id: string): void;
}

/**
 * The bots the owner set up. A bot is an ordinary user row with `account_type = 'bot'`
 * and its own permission bitfield, so the routes and gateway it uses are the same
 * ones a person uses; this only manages the account and its token.
 */
export function createBotService(sqlite: DatabaseSync): BotService {
  function requireBot(id: string): UserRow {
    const row = findUserById(sqlite, id);
    if (!row || row.account_type !== 'bot') {
      throw new HttpError(404, 'bot_not_found', 'That bot does not exist.');
    }
    return row;
  }

  function summary(row: UserRow, lastUsedAt: string | null): BotSummary {
    return {
      user: presentUser(sqlite, row),
      permissions: permissionsToString(parsePermissionBits(row.bot_permissions)),
      lastUsedAt,
    };
  }

  function lastUsed(id: string): string | null {
    return listBotTokens(sqlite).get(id)?.last_used_at ?? null;
  }

  return {
    list() {
      const tokens = listBotTokens(sqlite);
      return { bots: listBots(sqlite).map((row) => summary(row, tokens.get(row.id)?.last_used_at ?? null)) };
    },

    get(id) {
      const row = requireBot(id);
      return summary(row, lastUsed(row.id));
    },

    create({ username, displayName, permissions }) {
      if (findUserByUsername(sqlite, username)) {
        throw new HttpError(409, 'username_taken', 'That username is already taken.');
      }
      const id = randomUUID();
      insertBotUser(sqlite, { id, username, permissions: permissionsToString(maskPermissions(permissions)) });
      if (displayName) updateUserProfile(sqlite, id, { displayName });
      const token = generateSessionToken();
      setBotToken(sqlite, id, token);
      return { bot: summary(requireBot(id), null), token };
    },

    update(id, patch) {
      const row = requireBot(id);
      if (patch.username !== undefined && patch.username !== row.username) {
        const existing = findUserByUsername(sqlite, patch.username);
        if (existing && existing.id !== row.id) {
          throw new HttpError(409, 'username_taken', 'That username is already taken.');
        }
        setUsername(sqlite, row.id, patch.username);
      }
      if (patch.displayName !== undefined) updateUserProfile(sqlite, row.id, { displayName: patch.displayName });
      if (patch.permissions !== undefined) {
        setBotPermissions(sqlite, row.id, permissionsToString(maskPermissions(patch.permissions)));
      }
      return summary(requireBot(id), lastUsed(id));
    },

    regenerateToken(id) {
      const row = requireBot(id);
      const token = generateSessionToken();
      setBotToken(sqlite, row.id, token);
      return token;
    },

    remove(id) {
      const row = requireBot(id);
      // The bot_tokens row follows through the foreign key's cascade.
      deleteUser(sqlite, row.id);
    },
  };
}
