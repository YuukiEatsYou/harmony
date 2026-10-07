import type { DatabaseSync } from 'node:sqlite';
import type { AccountType, PermissionValue, SocialLinks, User, UserBadge, UserProfile } from '@harmony/shared';
import { hasPassword, NO_PASSWORD } from '../auth/passwords.ts';
import { getHighestRoleColor, getUserBadge } from './roles.ts';

export interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  avatar_hash: string | null;
  is_bot: number;
  is_owner: number;
  created_at: string;
  discord_id: string | null;
  timed_out_until: string | null;
  show_typing: number;
  notify_major: number;
  notify_minor: number;
  bio: string | null;
  status: string | null;
  accent_color: number | null;
  avatar_color: number | null;
  banner_hash: string | null;
  social_links: string | null;
  account_type: string;
  bot_permissions: string;
  sync_discord_avatar: number;
  /** The Discord picture revision last imported, or null when nothing has been. */
  discord_avatar_rev: string | null;
  /** When the daily sweep last checked this member's Discord picture. */
  discord_avatar_checked_at: string | null;
}

/** A stored account type, defaulting to a person for anything unrecognized. */
function parseAccountType(raw: string): AccountType {
  return raw === 'bot' || raw === 'ghost' ? raw : 'user';
}

/** A stored permission bitfield as a bigint; anything unreadable is none. */
export function parsePermissionBits(raw: string | null): PermissionValue {
  if (!raw) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

export function toUser(row: UserRow, roleColor: number | null, badge: UserBadge | null): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarHash: row.avatar_hash,
    roleColor,
    accountType: parseAccountType(row.account_type),
    isOwner: row.is_owner === 1,
    badge,
    createdAt: row.created_at,
    timedOutUntil: row.timed_out_until,
    showTyping: row.show_typing === 1,
    notifyMajor: row.notify_major === 1,
    notifyMinor: row.notify_minor === 1,
    discordId: row.discord_id,
    syncDiscordAvatar: row.sync_discord_avatar === 1,
    hasPassword: hasPassword(row.password_hash),
  };
}

/** A user DTO with their display color and badge resolved from their roles. */
export function presentUser(sqlite: DatabaseSync, row: UserRow): User {
  // Only a person shows an owner/admin/moderator badge, and only the owner shows
  // the owner one. A bot has its own icon; a stand-in belongs to Discord.
  const badge = row.account_type === 'user' ? getUserBadge(sqlite, row.id, row.is_owner === 1) : null;
  return toUser(row, getHighestRoleColor(sqlite, row.id), badge);
}

/** The stored social links, or an empty map when there are none or they are unreadable. */
function parseSocialLinks(raw: string | null): SocialLinks {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as SocialLinks) : {};
  } catch {
    return {};
  }
}

/** The profile fields a member sets about themselves, as the profile routes return them. */
export function presentUserProfile(row: UserRow): UserProfile {
  return {
    bio: row.bio ?? '',
    status: row.status ?? '',
    accentColor: row.accent_color,
    avatarColor: row.avatar_color,
    bannerHash: row.banner_hash,
    socialLinks: parseSocialLinks(row.social_links),
  };
}

/** Counts real accounts; bots and Discord stand-ins do not make an instance "started". */
export function countUsers(sqlite: DatabaseSync): number {
  const row = sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE account_type = 'user'").get() as {
    count: number;
  };
  return row.count;
}

export function findUserById(sqlite: DatabaseSync, id: string): UserRow | null {
  return (sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
}

export function findUserByUsername(sqlite: DatabaseSync, username: string): UserRow | null {
  return (sqlite.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined) ?? null;
}

/** Just enough of a user to resolve a typed name to an account. */
export interface PersonName {
  id: string;
  username: string;
  displayName: string | null;
}

/** Everyone who has an account, banned or not: their old messages are still searchable. */
export function listAllUserNames(sqlite: DatabaseSync): PersonName[] {
  const rows = sqlite.prepare('SELECT id, username, display_name FROM users').all() as unknown as Array<{
    id: string;
    username: string;
    display_name: string | null;
  }>;
  return rows.map((row) => ({ id: row.id, username: row.username, displayName: row.display_name }));
}

/** Whether a typed name (a leading @ is ignored) is this person's username or display name, ignoring case. */
export function matchesPerson(person: PersonName, name: string): boolean {
  const wanted = name.replace(/^@/, '').toLowerCase();
  return person.username.toLowerCase() === wanted || (person.displayName?.toLowerCase() ?? null) === wanted;
}

export function listUsers(sqlite: DatabaseSync): UserRow[] {
  // Banned users are no longer members, so they are left out of every roster.
  return sqlite
    .prepare('SELECT * FROM users WHERE id NOT IN (SELECT user_id FROM bans) ORDER BY created_at')
    .all() as unknown as UserRow[];
}

export function setUserTimeout(sqlite: DatabaseSync, userId: string, until: string | null): void {
  sqlite.prepare('UPDATE users SET timed_out_until = ? WHERE id = ?').run(until, userId);
}

export function findUserByDiscordId(sqlite: DatabaseSync, discordId: string): UserRow | null {
  return (sqlite.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId) as UserRow | undefined) ?? null;
}

/** Sets or clears the Discord account a member is linked to. */
export function setUserDiscordId(sqlite: DatabaseSync, id: string, discordId: string | null): void {
  sqlite.prepare('UPDATE users SET discord_id = ? WHERE id = ?').run(discordId, id);
}

/** Records the outcome of a Discord picture sync: the revision now in place, and when. */
export function setDiscordAvatarSync(
  sqlite: DatabaseSync,
  id: string,
  rev: string | null,
  checkedAt: string,
): void {
  sqlite
    .prepare('UPDATE users SET discord_avatar_rev = ?, discord_avatar_checked_at = ? WHERE id = ?')
    .run(rev, checkedAt, id);
}

/**
 * Linked members whose picture follows Discord and has not been looked at since
 * `before`, a stamped member before an unstamped one. Stand-ins and bots are left
 * out: a stand-in has no toggle and is kept in step per message, and a bot has no
 * Discord picture at all.
 */
export function listUsersDueForDiscordAvatarSync(sqlite: DatabaseSync, before: string): UserRow[] {
  return sqlite
    .prepare(
      `SELECT * FROM users
        WHERE account_type = 'user'
          AND discord_id IS NOT NULL
          AND sync_discord_avatar = 1
          AND (discord_avatar_checked_at IS NULL OR discord_avatar_checked_at < ?)
        ORDER BY discord_avatar_checked_at IS NULL DESC, discord_avatar_checked_at`,
    )
    .all(before) as unknown as UserRow[];
}

/** Renames an account. The unique index rejects a name already in use. */
export function setUsername(sqlite: DatabaseSync, id: string, username: string): void {
  sqlite.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
}

/**
 * Folds one account into another and removes it, so a member and the Discord
 * stand-in built for them become a single identity.
 *
 * Everything the outgoing account authored or carried moves to the survivor
 * before it is deleted, so nothing is orphaned by the `ON DELETE` rules. The
 * composite-keyed tables (reactions, roles, saved gifs, read markers, mentions,
 * saved messages, bans) can collide where the survivor already holds the same row, so the
 * duplicates are dropped first and the rest moved.
 *
 * The whole thing is one transaction: a half-merged pair of accounts would be
 * worse than either outcome on its own.
 */
export function mergeUsers(sqlite: DatabaseSync, fromId: string, intoId: string): void {
  sqlite.exec('BEGIN');
  try {
    // Plain references first, so the delete below has nothing left to null out.
    sqlite.prepare('UPDATE messages SET author_id = ? WHERE author_id = ?').run(intoId, fromId);
    sqlite.prepare('UPDATE messages SET pinned_by = ? WHERE pinned_by = ?').run(intoId, fromId);
    sqlite.prepare('UPDATE attachments SET uploader_id = ? WHERE uploader_id = ?').run(intoId, fromId);
    sqlite.prepare('UPDATE audit_log SET actor_id = ? WHERE actor_id = ?').run(intoId, fromId);
    sqlite.prepare('UPDATE audit_log SET target_id = ? WHERE target_id = ?').run(intoId, fromId);
    sqlite.prepare('UPDATE emojis SET created_by = ? WHERE created_by = ?').run(intoId, fromId);
    sqlite.prepare('UPDATE server_gifs SET added_by = ? WHERE added_by = ?').run(intoId, fromId);
    sqlite.prepare('UPDATE invites SET created_by = ? WHERE created_by = ?').run(intoId, fromId);
    sqlite.prepare('UPDATE bans SET banned_by = ? WHERE banned_by = ?').run(intoId, fromId);
    sqlite.prepare('UPDATE sessions SET user_id = ? WHERE user_id = ?').run(intoId, fromId);
    sqlite.prepare('UPDATE message_edits SET editor_id = ? WHERE editor_id = ?').run(intoId, fromId);

    // Composite keys: drop the outgoing rows the survivor already shadows.
    sqlite
      .prepare(
        `DELETE FROM reactions
          WHERE user_id = ?
            AND EXISTS (SELECT 1 FROM reactions r
                         WHERE r.message_id = reactions.message_id AND r.user_id = ? AND r.emoji = reactions.emoji)`,
      )
      .run(fromId, intoId);
    sqlite.prepare('UPDATE reactions SET user_id = ? WHERE user_id = ?').run(intoId, fromId);

    sqlite
      .prepare(
        `DELETE FROM member_roles
          WHERE user_id = ?
            AND EXISTS (SELECT 1 FROM member_roles r
                         WHERE r.user_id = ? AND r.role_id = member_roles.role_id)`,
      )
      .run(fromId, intoId);
    sqlite.prepare('UPDATE member_roles SET user_id = ? WHERE user_id = ?').run(intoId, fromId);

    sqlite
      .prepare(
        `DELETE FROM gif_favorites
          WHERE user_id = ?
            AND EXISTS (SELECT 1 FROM gif_favorites f WHERE f.user_id = ? AND f.hash = gif_favorites.hash)`,
      )
      .run(fromId, intoId);
    sqlite.prepare('UPDATE gif_favorites SET user_id = ? WHERE user_id = ?').run(intoId, fromId);

    sqlite
      .prepare(
        `DELETE FROM channel_reads
          WHERE user_id = ?
            AND EXISTS (SELECT 1 FROM channel_reads r
                         WHERE r.user_id = ? AND r.channel_id = channel_reads.channel_id)`,
      )
      .run(fromId, intoId);
    sqlite.prepare('UPDATE channel_reads SET user_id = ? WHERE user_id = ?').run(intoId, fromId);

    // Mutes and notification levels: where both accounts chose something for
    // the same channel or category, the survivor's own choice stands.
    sqlite
      .prepare(
        `DELETE FROM channel_settings
          WHERE user_id = ?
            AND EXISTS (SELECT 1 FROM channel_settings s
                         WHERE s.user_id = ?
                           AND (s.channel_id = channel_settings.channel_id
                                OR s.category_id = channel_settings.category_id))`,
      )
      .run(fromId, intoId);
    sqlite.prepare('UPDATE channel_settings SET user_id = ? WHERE user_id = ?').run(intoId, fromId);

    sqlite
      .prepare(
        `DELETE FROM mentions
          WHERE user_id = ?
            AND EXISTS (SELECT 1 FROM mentions m WHERE m.user_id = ? AND m.message_id = mentions.message_id)`,
      )
      .run(fromId, intoId);
    sqlite.prepare('UPDATE mentions SET user_id = ? WHERE user_id = ?').run(intoId, fromId);

    // A message both accounts saved stays saved once, as the survivor saved it.
    sqlite
      .prepare(
        `DELETE FROM saved_messages
          WHERE user_id = ?
            AND EXISTS (SELECT 1 FROM saved_messages s
                         WHERE s.user_id = ? AND s.message_id = saved_messages.message_id)`,
      )
      .run(fromId, intoId);
    sqlite.prepare('UPDATE saved_messages SET user_id = ? WHERE user_id = ?').run(intoId, fromId);

    // Scheduled messages have their own ids, so they simply change hands.
    sqlite.prepare('UPDATE scheduled_messages SET user_id = ? WHERE user_id = ?').run(intoId, fromId);

    // A ban is keyed by user id, so keep the survivor's own and drop the other.
    sqlite
      .prepare('DELETE FROM bans WHERE user_id = ? AND EXISTS (SELECT 1 FROM bans WHERE user_id = ?)')
      .run(fromId, intoId);
    sqlite.prepare('UPDATE bans SET user_id = ? WHERE user_id = ?').run(intoId, fromId);

    // Poll votes: one person who voted under both accounts keeps a single vote.
    // Where the survivor already chose the same option the outgoing row goes, and
    // in a poll that takes one answer the survivor's own choice stands over any
    // other the outgoing account made, so the merge never leaves two.
    sqlite
      .prepare(
        `DELETE FROM poll_votes
          WHERE user_id = ?
            AND (EXISTS (SELECT 1 FROM poll_votes v
                          WHERE v.option_id = poll_votes.option_id AND v.user_id = ?)
                 OR EXISTS (SELECT 1 FROM poll_votes v JOIN polls p ON p.id = v.poll_id
                             WHERE v.poll_id = poll_votes.poll_id AND v.user_id = ? AND p.allow_multiple = 0))`,
      )
      .run(fromId, intoId, intoId);
    sqlite.prepare('UPDATE poll_votes SET user_id = ? WHERE user_id = ?').run(intoId, fromId);

    // Event interest is one per person: a person interested under both accounts
    // keeps the survivor's. Events the outgoing account created change hands.
    sqlite
      .prepare(
        `DELETE FROM event_rsvps
          WHERE user_id = ?
            AND EXISTS (SELECT 1 FROM event_rsvps r WHERE r.user_id = ? AND r.event_id = event_rsvps.event_id)`,
      )
      .run(fromId, intoId);
    sqlite.prepare('UPDATE event_rsvps SET user_id = ? WHERE user_id = ?').run(intoId, fromId);
    sqlite.prepare('UPDATE events SET creator_id = ? WHERE creator_id = ?').run(intoId, fromId);

    sqlite.prepare('DELETE FROM users WHERE id = ?').run(fromId);
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Updates the account credentials: the login name and the password hash. Kept
 * apart from `updateUserProfile` because these are the fields an administrator
 * resets, and a password is only ever written, never read back.
 */
export function updateUserAccount(
  sqlite: DatabaseSync,
  id: string,
  patch: { username?: string; passwordHash?: string },
): void {
  const sets: string[] = [];
  const values: string[] = [];
  if (patch.username !== undefined) {
    sets.push('username = ?');
    values.push(patch.username);
  }
  if (patch.passwordHash !== undefined) {
    sets.push('password_hash = ?');
    values.push(patch.passwordHash);
  }
  if (sets.length === 0) return;

  values.push(id);
  sqlite.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function updateUserProfile(
  sqlite: DatabaseSync,
  id: string,
  patch: {
    displayName?: string | null;
    avatarHash?: string | null;
    avatarColor?: number | null;
    showTyping?: boolean;
    notifyMajor?: boolean;
    notifyMinor?: boolean;
    syncDiscordAvatar?: boolean;
    bio?: string | null;
    status?: string | null;
    accentColor?: number | null;
    bannerHash?: string | null;
    socialLinks?: SocialLinks;
  },
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.displayName !== undefined) {
    sets.push('display_name = ?');
    values.push(patch.displayName);
  }
  if (patch.avatarHash !== undefined) {
    sets.push('avatar_hash = ?');
    values.push(patch.avatarHash);
  }
  if (patch.avatarColor !== undefined) {
    sets.push('avatar_color = ?');
    values.push(patch.avatarColor);
  }
  if (patch.showTyping !== undefined) {
    sets.push('show_typing = ?');
    values.push(patch.showTyping ? 1 : 0);
  }
  if (patch.notifyMajor !== undefined) {
    sets.push('notify_major = ?');
    values.push(patch.notifyMajor ? 1 : 0);
  }
  if (patch.notifyMinor !== undefined) {
    sets.push('notify_minor = ?');
    values.push(patch.notifyMinor ? 1 : 0);
  }
  if (patch.syncDiscordAvatar !== undefined) {
    sets.push('sync_discord_avatar = ?');
    values.push(patch.syncDiscordAvatar ? 1 : 0);
  }
  if (patch.bio !== undefined) {
    sets.push('bio = ?');
    values.push(patch.bio);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.accentColor !== undefined) {
    sets.push('accent_color = ?');
    values.push(patch.accentColor);
  }
  if (patch.bannerHash !== undefined) {
    sets.push('banner_hash = ?');
    values.push(patch.bannerHash);
  }
  if (patch.socialLinks !== undefined) {
    const links = Object.keys(patch.socialLinks).length > 0 ? JSON.stringify(patch.socialLinks) : null;
    sets.push('social_links = ?');
    values.push(links);
  }
  if (sets.length === 0) return;

  values.push(id);
  sqlite.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Creates a stand-in account for someone who only exists on the Discord side of
 * a bridge. It has no usable password, so it can never be logged into.
 */
export function insertGhostUser(
  sqlite: DatabaseSync,
  input: { id: string; username: string; displayName: string; discordId: string; createdAt: string },
): void {
  sqlite
    .prepare(
      `INSERT INTO users (id, username, display_name, password_hash, is_bot, is_owner, created_at, discord_id, account_type)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?, 'ghost')`,
    )
    .run(input.id, input.username, input.displayName, NO_PASSWORD, input.createdAt, input.discordId);
}

/** Removes an account row outright. The schema cascades its own rows and sets
 * its references elsewhere to null, so a deleted member's messages stay behind
 * with no author. */
export function deleteUser(sqlite: DatabaseSync, id: string): void {
  sqlite.prepare('DELETE FROM users WHERE id = ?').run(id);
}

export function insertUser(
  sqlite: DatabaseSync,
  input: { id: string; username: string; passwordHash: string; isOwner: boolean },
): void {
  sqlite
    .prepare(
      `INSERT INTO users (id, username, password_hash, is_owner, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.username, input.passwordHash, input.isOwner ? 1 : 0, new Date().toISOString());
}

/** Every bot the owner has set up, oldest first. */
export function listBots(sqlite: DatabaseSync): UserRow[] {
  return sqlite
    .prepare("SELECT * FROM users WHERE account_type = 'bot' ORDER BY created_at")
    .all() as unknown as UserRow[];
}

/**
 * Creates a bot account. It never has a usable password, is never the owner, and
 * carries its own permission bitfield rather than roles, which is what the token
 * it is issued is allowed to do. The username unique index applies as for anyone.
 */
export function insertBotUser(
  sqlite: DatabaseSync,
  input: { id: string; username: string; permissions: string },
): void {
  sqlite
    .prepare(
      `INSERT INTO users (id, username, password_hash, is_bot, is_owner, created_at, account_type, bot_permissions)
       VALUES (?, ?, ?, 1, 0, ?, 'bot', ?)`,
    )
    .run(input.id, input.username, NO_PASSWORD, new Date().toISOString(), input.permissions);
}

/** Replaces a bot's permission bitfield. */
export function setBotPermissions(sqlite: DatabaseSync, id: string, permissions: string): void {
  sqlite.prepare('UPDATE users SET bot_permissions = ? WHERE id = ?').run(permissions, id);
}
