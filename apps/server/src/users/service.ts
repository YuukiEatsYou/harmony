import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import {
  ALLOWED_IMAGE_TYPES,
  AVATAR_SIZE,
  BANNER_HEIGHT,
  BANNER_WIDTH,
  BIO_MAX,
  DEFAULT_MAX_AVATAR_BYTES,
  DEFAULT_MAX_BANNER_BYTES,
  SOCIAL_PLATFORM_KEYS,
  STATUS_MAX,
  validSocialValue,
  type ImageContentType,
  type SocialLinks,
} from '@harmony/shared';
import type { Config } from '../config.ts';
import { hasPassword, hashPassword, verifyPassword } from '../auth/passwords.ts';
import { averageColor } from '../media/color.ts';
import {
  findUserById,
  findUserByDiscordId,
  findUserByUsername,
  mergeUsers,
  setDiscordAvatarSync,
  setUserDiscordId,
  updateUserAccount,
  updateUserProfile,
  type UserRow,
} from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import { createBlobStore } from '../storage/blobs.ts';

export interface UserService {
  updateProfile(
    userId: string,
    patch: {
      displayName?: string | null;
      showTyping?: boolean;
      notifyMajor?: boolean;
      notifyMinor?: boolean;
      syncDiscordAvatar?: boolean;
      bio?: string;
      status?: string;
      accentColor?: number | null;
      socialLinks?: Record<string, string>;
    },
  ): UserRow;
  /**
   * Changes a member's own password after checking the one they already have.
   * An account without one (it signed up with Discord) just sets its first.
   */
  changePassword(userId: string, currentPassword: string | undefined, nextPassword: string): Promise<void>;
  /**
   * An administrator editing another account. `password` sets a new one without
   * ever reading the old; callers must end the target's sessions afterwards.
   */
  adminUpdate(
    userId: string,
    patch: { username?: string; displayName?: string | null; password?: string; discordId?: string | null },
  ): Promise<UserRow>;
  /**
   * Links a member to a Discord account, or clears the link. An id another
   * member already holds is refused. When a stand-in account exists for the id,
   * it is retired into this one, so the person has a single identity.
   */
  linkDiscord(userId: string, discordId: string | null): UserRow;
  updateAvatar(userId: string, file: { contentType: string; data: Buffer }): Promise<UserRow>;
  /**
   * Stores a normalized avatar from raw bytes. Used by the bridge, where the
   * bytes come from Discord with no declared content type. Returns null when
   * the data is unusable.
   */
  setAvatarFromData(userId: string, data: Buffer): Promise<UserRow | null>;
  /**
   * Applies a picture synced from Discord: stores the image, or clears the
   * picture when Discord has none, and records the Discord revision behind it so
   * the next check can tell whether it changed. Deliberately skips the
   * stand-in guard, since the bridge drives this for ghost accounts too. Returns
   * null when the bytes are unusable, leaving the account untouched.
   */
  applyDiscordAvatar(userId: string, data: Buffer | null, rev: string | null): Promise<UserRow | null>;
  clearAvatar(userId: string): UserRow;
  /** Stores a normalized banner from an uploaded image. */
  updateBanner(userId: string, file: { contentType: string; data: Buffer }): Promise<UserRow>;
  clearBanner(userId: string): UserRow;
  /** Absolute path of an avatar blob. */
  avatarPath(hash: string): string;
  /** Absolute path of a banner blob. */
  bannerPath(hash: string): string;
}

export function createUserService(sqlite: DatabaseSync, config: Config): UserService {
  const blobs = createBlobStore(config);

  function require(id: string): UserRow {
    const row = findUserById(sqlite, id);
    if (!row) throw new HttpError(404, 'user_not_found', 'That user does not exist.');
    return row;
  }

  /**
   * Discord stand-in accounts exist only because the bridge created them, and the
   * bridge keeps their name and picture in step. Their roles are managed like
   * anyone else's, but the profile itself is not ours to edit.
   */
  function assertEditable(row: UserRow): void {
    if (row.account_type !== 'user') {
      throw new HttpError(
        400,
        'externally_managed',
        row.account_type === 'bot'
          ? 'Bot accounts are managed from the Bots tab, not as a member.'
          : 'Discord stand-in accounts are managed by the bridge.',
      );
    }
  }

  /**
   * Avatars are small and always shown at a fixed size, so they are normalized
   * to a square WebP. That keeps storage tiny and means we never have to store
   * a content type alongside them.
   */
  async function normalizeAvatar(data: Buffer): Promise<Buffer | null> {
    if (data.length > DEFAULT_MAX_AVATAR_BYTES) return null;
    try {
      return await sharp(data)
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'center' })
        .webp({ quality: 85 })
        .toBuffer();
    } catch {
      return null;
    }
  }

  /** Banners are cropped to a wide, fixed size, the same way avatars are squared. */
  async function normalizeBanner(data: Buffer): Promise<Buffer | null> {
    if (data.length > DEFAULT_MAX_BANNER_BYTES) return null;
    try {
      return await sharp(data)
        .resize(BANNER_WIDTH, BANNER_HEIGHT, { fit: 'cover', position: 'center' })
        .webp({ quality: 85 })
        .toBuffer();
    } catch {
      return null;
    }
  }

  /** A trimmed value, or null when it reads as empty so nothing blank is stored. */
  function trimToNull(value: string | null | undefined): string | null {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
  }

  /**
   * Keeps only the known platforms with a value that is valid for them, dropping
   * anything else. A handle is never rewritten here; it is only ever joined to a
   * fixed base when it becomes a link.
   */
  function cleanSocialLinks(input: Record<string, string> | undefined): SocialLinks {
    const clean: SocialLinks = {};
    if (!input) return clean;
    for (const platform of SOCIAL_PLATFORM_KEYS) {
      const raw = input[platform];
      if (raw === undefined) continue;
      const value = raw.trim();
      if (value.length > 0 && validSocialValue(platform, value)) clean[platform] = value;
    }
    return clean;
  }

  /**
   * Links a member to a Discord account, or clears the link.
   *
   * An id another member already holds is refused. When a stand-in account was
   * built for that Discord user, it is retired into this account instead: its
   * messages, pictures, reactions and the rest move over, so the Discord history
   * and the member become one identity and the bridge starts attributing that
   * person's new Discord messages here. Only an administrator does this for now;
   * verifying ownership through Discord is left for account linking later.
   */
  function linkDiscord(userId: string, discordId: string | null): UserRow {
    const row = require(userId);
    assertEditable(row);

    const next = discordId?.trim() ? discordId.trim() : null;
    if (next === null) {
      // Discord is the only way into a passwordless account, so it cannot be cut.
      if (row.discord_id && !hasPassword(row.password_hash)) {
        throw new HttpError(
          409,
          'password_required',
          'Set a password before disconnecting Discord, or you would be locked out.',
        );
      }
      setUserDiscordId(sqlite, row.id, null);
      return require(userId);
    }

    const existing = findUserByDiscordId(sqlite, next);
    if (existing?.id === row.id) return row;
    if (existing && existing.account_type === 'user') {
      throw new HttpError(409, 'discord_id_taken', 'That Discord account is already linked to another member.');
    }
    // A stand-in account for this Discord user: fold it in, then take its id.
    if (existing) mergeUsers(sqlite, existing.id, row.id);

    setUserDiscordId(sqlite, row.id, next);
    return require(userId);
  }

  return {
    avatarPath: blobs.pathFor,
    bannerPath: blobs.pathFor,

    updateProfile(userId, patch) {
      const row = require(userId);
      const clean: {
        displayName?: string | null;
        showTyping?: boolean;
        notifyMajor?: boolean;
        notifyMinor?: boolean;
        syncDiscordAvatar?: boolean;
        bio?: string | null;
        status?: string | null;
        accentColor?: number | null;
        socialLinks?: SocialLinks;
      } = {};
      if (patch.displayName !== undefined) {
        // Empty means "go back to the username".
        clean.displayName =
          patch.displayName && patch.displayName.trim().length > 0 ? patch.displayName.trim() : null;
      }
      if (patch.showTyping !== undefined) clean.showTyping = patch.showTyping;
      if (patch.notifyMajor !== undefined) clean.notifyMajor = patch.notifyMajor;
      if (patch.notifyMinor !== undefined) clean.notifyMinor = patch.notifyMinor;
      if (patch.syncDiscordAvatar !== undefined) clean.syncDiscordAvatar = patch.syncDiscordAvatar;
      if (patch.bio !== undefined) clean.bio = trimToNull(patch.bio.slice(0, BIO_MAX));
      if (patch.status !== undefined) clean.status = trimToNull(patch.status.slice(0, STATUS_MAX));
      if (patch.accentColor !== undefined) clean.accentColor = patch.accentColor;
      if (patch.socialLinks !== undefined) clean.socialLinks = cleanSocialLinks(patch.socialLinks);
      updateUserProfile(sqlite, row.id, clean);
      return require(userId);
    },

    async changePassword(userId, currentPassword, nextPassword) {
      const row = require(userId);
      if (hasPassword(row.password_hash)) {
        const ok = currentPassword !== undefined && (await verifyPassword(currentPassword, row.password_hash));
        if (!ok) throw new HttpError(403, 'wrong_password', 'Your current password is not correct.');
      }
      updateUserAccount(sqlite, row.id, { passwordHash: await hashPassword(nextPassword) });
    },

    async adminUpdate(userId, patch) {
      const row = require(userId);
      assertEditable(row);

      if (patch.username !== undefined && patch.username !== row.username) {
        const taken = findUserByUsername(sqlite, patch.username);
        if (taken && taken.id !== row.id) {
          throw new HttpError(409, 'username_taken', 'That username is already taken.');
        }
      }

      const account: { username?: string; passwordHash?: string } = {};
      if (patch.username !== undefined) account.username = patch.username;
      if (patch.password !== undefined) account.passwordHash = await hashPassword(patch.password);
      updateUserAccount(sqlite, row.id, account);

      if (patch.displayName !== undefined) {
        const trimmed = patch.displayName?.trim() ?? '';
        updateUserProfile(sqlite, row.id, { displayName: trimmed.length > 0 ? trimmed : null });
      }

      if (patch.discordId !== undefined) linkDiscord(row.id, patch.discordId);

      return require(userId);
    },

    linkDiscord,

    async updateAvatar(userId, file) {
      const row = require(userId);
      assertEditable(row);

      if (!ALLOWED_IMAGE_TYPES.includes(file.contentType as ImageContentType)) {
        throw new HttpError(
          415,
          'unsupported_media_type',
          `Unsupported image type "${file.contentType}". Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}.`,
        );
      }
      if (file.data.length > DEFAULT_MAX_AVATAR_BYTES) {
        throw new HttpError(
          413,
          'payload_too_large',
          `Profile pictures must be at most ${DEFAULT_MAX_AVATAR_BYTES / (1024 * 1024)} MB.`,
        );
      }

      const normalized = await normalizeAvatar(file.data);
      if (!normalized) {
        throw new HttpError(415, 'invalid_image', 'That file is not a readable image.');
      }

      updateUserProfile(sqlite, row.id, {
        avatarHash: blobs.save(normalized),
        avatarColor: await averageColor(normalized),
      });
      return require(userId);
    },

    async setAvatarFromData(userId, data) {
      const row = findUserById(sqlite, userId);
      if (!row) return null;

      const normalized = await normalizeAvatar(data);
      if (!normalized) return null;

      updateUserProfile(sqlite, row.id, {
        avatarHash: blobs.save(normalized),
        avatarColor: await averageColor(normalized),
      });
      return require(userId);
    },

    async applyDiscordAvatar(userId, data, rev) {
      const row = findUserById(sqlite, userId);
      if (!row) return null;

      if (data) {
        const normalized = await normalizeAvatar(data);
        if (!normalized) return null;
        updateUserProfile(sqlite, row.id, {
          avatarHash: blobs.save(normalized),
          avatarColor: await averageColor(normalized),
        });
      } else {
        // Discord has no picture for them, so ours would be a stale copy.
        updateUserProfile(sqlite, row.id, { avatarHash: null, avatarColor: null });
      }

      setDiscordAvatarSync(sqlite, row.id, rev, new Date().toISOString());
      return require(userId);
    },

    clearAvatar(userId) {
      const row = require(userId);
      assertEditable(row);
      updateUserProfile(sqlite, row.id, { avatarHash: null, avatarColor: null });
      return require(userId);
    },

    async updateBanner(userId, file) {
      const row = require(userId);
      assertEditable(row);

      if (!ALLOWED_IMAGE_TYPES.includes(file.contentType as ImageContentType)) {
        throw new HttpError(
          415,
          'unsupported_media_type',
          `Unsupported image type "${file.contentType}". Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}.`,
        );
      }
      if (file.data.length > DEFAULT_MAX_BANNER_BYTES) {
        throw new HttpError(
          413,
          'payload_too_large',
          `Banners must be at most ${DEFAULT_MAX_BANNER_BYTES / (1024 * 1024)} MB.`,
        );
      }

      const normalized = await normalizeBanner(file.data);
      if (!normalized) {
        throw new HttpError(415, 'invalid_image', 'That file is not a readable image.');
      }

      updateUserProfile(sqlite, row.id, { bannerHash: blobs.save(normalized) });
      return require(userId);
    },

    clearBanner(userId) {
      const row = require(userId);
      assertEditable(row);
      updateUserProfile(sqlite, row.id, { bannerHash: null });
      return require(userId);
    },
  };
}
