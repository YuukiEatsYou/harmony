import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  LIMITS,
  type AuthResponse,
  type LoginInput,
  type PermissionValue,
  type RegisterInput,
  type User,
} from '@harmony/shared';
import type { Config } from '../config.ts';
import { HttpError } from '../http/errors.ts';
import {
  countUsers,
  deleteUser,
  findUserByDiscordId,
  findUserById,
  findUserByUsername,
  insertUser,
  parsePermissionBits,
  mergeUsers,
  presentUser,
  setUserDiscordId,
  updateUserProfile,
  type UserRow,
} from '../db/users.ts';
import {
  deleteSessionById,
  deleteSessionByTokenHash,
  findSessionByTokenHash,
  insertSession,
  touchSession,
} from '../db/sessions.ts';
import { findInvite, incrementInviteUses } from '../db/invites.ts';
import { findBotByToken, touchBotToken } from '../db/bot_tokens.ts';
import { findBan } from '../db/bans.ts';
import type { DiscordIdentity } from './discord-oauth.ts';
import { DUMMY_PASSWORD_HASH, hasPassword, hashPassword, NO_PASSWORD, verifyPassword } from './passwords.ts';
import { generateSessionToken, hashSessionToken } from './tokens.ts';
import { resolvePermissions } from './permissions.ts';
import type { SettingsService } from '../settings/service.ts';

export interface AuthContext {
  user: User;
  permissions: PermissionValue;
  sessionId: string;
  token: string;
}

export interface AuthService {
  register(input: RegisterInput, userAgent: string | null): Promise<AuthResponse>;
  login(input: LoginInput, userAgent: string | null): Promise<AuthResponse>;
  /**
   * Issues a session for an account without a password check, for Discord
   * sign-in where ownership was already proven. Returns null for a banned or
   * missing account.
   */
  sessionForUser(userId: string, userAgent: string | null): AuthResponse | null;
  /**
   * Signs in with a proven Discord identity, creating the account on first
   * visit. A new account has no password. A bridge stand-in for the same Discord
   * user is folded into it, so their history becomes theirs. Throws for a banned
   * account and, where invites are required, for a missing or unusable code.
   */
  signInWithDiscord(
    identity: DiscordIdentity,
    inviteCode: string | null,
    userAgent: string | null,
  ): { auth: AuthResponse; created: boolean };
  logout(token: string): void;
  resolveToken(token: string): AuthContext | null;
}

export function createAuthService(sqlite: DatabaseSync, config: Config, settings: SettingsService): AuthService {
  function issueSession(user: UserRow, userAgent: string | null): string {
    const token = generateSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.sessionTtlDays * 86_400_000).toISOString();

    insertSession(sqlite, {
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashSessionToken(token),
      userAgent,
      createdAt: now.toISOString(),
      expiresAt,
    });

    return token;
  }

  /** Throws unless the code may be used to join; returns the code to consume. */
  function checkInvite(code: string | null | undefined): string {
    if (!code) throw new HttpError(403, 'invite_required', 'An invite code is required to register.');

    const invite = findInvite(sqlite, code);
    if (!invite) throw new HttpError(403, 'invalid_invite', 'That invite code is not valid.');
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      throw new HttpError(403, 'invite_expired', 'That invite code has expired.');
    }
    if (invite.max_uses != null && invite.uses >= invite.max_uses) {
      throw new HttpError(403, 'invite_exhausted', 'That invite code has already been used up.');
    }
    return invite.code;
  }

  /** A free login name built from the Discord one, which may not fit our rules. */
  function freeUsername(discordName: string): string {
    const base = discordName.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, LIMITS.username.max - 4);
    const stem = base.length >= LIMITS.username.min ? base : `${base}user`;
    let candidate = stem;
    for (let n = 2; findUserByUsername(sqlite, candidate); n += 1) candidate = `${stem}${n}`;
    return candidate;
  }

  /**
   * A token that is not a session may be a bot token. From here on a bot is just a
   * user whose permissions are its own bitfield, so every route and the gateway
   * treat it the same way.
   */
  function resolveBotToken(token: string): AuthContext | null {
    const row = findBotByToken(sqlite, token);
    if (!row) return null;
    const bot = findUserById(sqlite, row.bot_id);
    if (!bot || bot.account_type !== 'bot') return null;
    touchBotToken(sqlite, bot.id);
    return {
      user: presentUser(sqlite, bot),
      permissions: parsePermissionBits(bot.bot_permissions),
      sessionId: `bot:${bot.id}`,
      token,
    };
  }

  return {
    async register(input, userAgent) {
      if (findUserByUsername(sqlite, input.username)) {
        throw new HttpError(409, 'username_taken', 'That username is already taken.');
      }

      // The very first account bootstraps the instance and becomes the owner.
      const isFirstUser = countUsers(sqlite) === 0;
      let inviteCodeToConsume: string | null = null;

      if (!isFirstUser && settings.get().requireInvite) {
        inviteCodeToConsume = checkInvite(input.inviteCode);
      }

      const id = randomUUID();
      const passwordHash = await hashPassword(input.password);
      insertUser(sqlite, { id, username: input.username, passwordHash, isOwner: isFirstUser });
      if (inviteCodeToConsume) incrementInviteUses(sqlite, inviteCodeToConsume);

      const row = findUserById(sqlite, id);
      if (!row) throw new HttpError(500, 'internal_error', 'Failed to load the new account.');

      return { user: presentUser(sqlite, row), token: issueSession(row, userAgent) };
    },

    async login(input, userAgent) {
      const row = findUserByUsername(sqlite, input.username);
      // Always hash-compare, even for unknown users, to avoid leaking which
      // usernames exist via response timing.
      // A passwordless account is compared against the dummy too, so it is
      // indistinguishable from a missing one.
      const usable = row !== null && hasPassword(row.password_hash);
      const ok = await verifyPassword(input.password, usable ? row.password_hash : DUMMY_PASSWORD_HASH);
      if (!row || !usable || !ok) {
        throw new HttpError(401, 'invalid_credentials', 'Incorrect username or password.');
      }
      // Checked after the password so a ban is only revealed to the account holder.
      if (findBan(sqlite, row.id)) {
        throw new HttpError(403, 'account_banned', 'You have been banned from this server.');
      }

      return { user: presentUser(sqlite, row), token: issueSession(row, userAgent) };
    },

    sessionForUser(userId, userAgent) {
      const row = findUserById(sqlite, userId);
      if (!row) return null;
      // A ban ends every session, so it also blocks signing in this way.
      if (findBan(sqlite, row.id)) return null;
      return { user: presentUser(sqlite, row), token: issueSession(row, userAgent) };
    },

    signInWithDiscord(identity, inviteCode, userAgent) {
      const existing = findUserByDiscordId(sqlite, identity.id);
      const banned = new HttpError(403, 'account_banned', 'You have been banned from this server.');

      // A member who already carries this Discord id just signs in.
      if (existing && existing.account_type === 'user') {
        const auth = this.sessionForUser(existing.id, userAgent);
        if (!auth) throw banned;
        return { auth, created: false };
      }

      // A stand-in's ban follows it into the account that replaces it.
      if (existing && findBan(sqlite, existing.id)) throw banned;

      const inviteToConsume = settings.get().requireInvite ? checkInvite(inviteCode) : null;

      // Everything below is synchronous, so nothing can slip in between the checks
      // and the inserts.
      const id = randomUUID();
      insertUser(sqlite, { id, username: freeUsername(identity.username), passwordHash: NO_PASSWORD, isOwner: false });
      try {
        // Keep what the bridge already knew about them; the merge drops that row.
        updateUserProfile(sqlite, id, {
          displayName: existing?.display_name ?? identity.displayName,
          avatarHash: existing?.avatar_hash ?? null,
        });
        // Retire the stand-in first: it holds the Discord id the new account takes.
        if (existing) mergeUsers(sqlite, existing.id, id);
        setUserDiscordId(sqlite, id, identity.id);
      } catch (error) {
        deleteUser(sqlite, id);
        throw error;
      }
      if (inviteToConsume) incrementInviteUses(sqlite, inviteToConsume);

      const row = findUserById(sqlite, id);
      if (!row) throw new HttpError(500, 'internal_error', 'Failed to load the new account.');
      return { auth: { user: presentUser(sqlite, row), token: issueSession(row, userAgent) }, created: true };
    },

    logout(token) {
      deleteSessionByTokenHash(sqlite, hashSessionToken(token));
    },

    resolveToken(token) {
      const session = findSessionByTokenHash(sqlite, hashSessionToken(token));
      if (!session) return resolveBotToken(token);

      if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) {
        deleteSessionById(sqlite, session.id);
        return null;
      }

      const row = findUserById(sqlite, session.user_id);
      if (!row) return null;

      // A ban ends every session, but guard here too so a stale token can never
      // outlive the ban that was meant to revoke it.
      if (findBan(sqlite, row.id)) return null;

      touchSession(sqlite, session.id);
      return {
        user: presentUser(sqlite, row),
        permissions: resolvePermissions(sqlite, row),
        sessionId: session.id,
        token,
      };
    },
  };
}
