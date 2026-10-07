import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  GatewayCloseCode,
  GatewayEvent,
  Permission,
  changePasswordSchema,
  permissionsToString,
  updateProfileSchema,
  type MeResponse,
} from '@harmony/shared';
import { resolvePermissions } from '../auth/permissions.ts';
import { requireAuth, requirePermission } from '../auth/plugin.ts';
import type { Database } from '../db/index.ts';
import { deleteOtherSessionsForUser } from '../db/sessions.ts';
import { findUserById, presentUser, presentUserProfile, type UserRow } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody } from '../http/validation.ts';
import type { GatewayHub } from '../realtime/hub.ts';
import type { BridgeService } from '../bridge/service.ts';
import type { UserService } from '../users/service.ts';

export interface UserRouteDeps {
  db: Database;
  users: UserService;
  hub: GatewayHub;
  /** Used to pull a member's picture from Discord on demand. */
  bridge: BridgeService;
}

export function registerUserRoutes(app: FastifyInstance, deps: UserRouteDeps): void {
  function present(row: UserRow): MeResponse {
    return {
      user: presentUser(deps.db.sqlite, row),
      permissions: permissionsToString(resolvePermissions(deps.db.sqlite, row)),
    };
  }

  /**
   * Everyone else sees a member's name and picture too, in the member list and on
   * their messages, so a change to their own profile is announced just like an
   * administrator's edit. Settings only they see ride along harmlessly, since the
   * event carries nothing but the id.
   */
  function announce(userId: string): void {
    deps.hub.dispatch(GatewayEvent.MemberUpdate, { userId });
  }

  /**
   * While a member's picture follows Discord it is not theirs to set here: a
   * change would be overwritten by the next message. Refused with a code the
   * client turns into "turn syncing off first" rather than silently ignored.
   */
  function requireOwnAvatarEditable(userId: string): UserRow {
    const row = findUserById(deps.db.sqlite, userId);
    if (!row) throw new HttpError(404, 'user_not_found', 'That user does not exist.');
    if (row.discord_id && row.sync_discord_avatar === 1) {
      throw new HttpError(
        409,
        'avatar_synced',
        'Your picture follows your Discord account. Turn syncing off to set one here.',
      );
    }
    return row;
  }

  app.patch('/api/v1/users/@me', async (request) => {
    const auth = requireAuth(request);
    const input = parseBody(updateProfileSchema, request.body);
    let row = deps.users.updateProfile(auth.user.id, input);
    // Switching the Discord picture sync on is a request to catch up now rather
    // than wait for the next message or the daily sweep. Best-effort: a bridge
    // that is down must not fail the setting change itself.
    if (input.syncDiscordAvatar === true && row.discord_id && deps.bridge.avatarSyncReady()) {
      row = (await deps.bridge.syncDiscordAvatarFor(auth.user.id).catch(() => null)) ?? row;
    }
    announce(auth.user.id);
    return present(row);
  });

  /**
   * Changes the caller's own password. Every other session is ended and its
   * live connection closed, so a password change really does lock out anyone
   * holding an older token, while the device making the change stays signed in.
   */
  app.patch('/api/v1/users/@me/password', async (request) => {
    const auth = requireAuth(request);
    const input = parseBody(changePasswordSchema, request.body);
    await deps.users.changePassword(auth.user.id, input.currentPassword, input.newPassword);

    deleteOtherSessionsForUser(deps.db.sqlite, auth.user.id, auth.sessionId);
    deps.hub.disconnectUser(
      auth.user.id,
      GatewayCloseCode.AuthenticationFailed,
      'Your password was changed on another device.',
      auth.sessionId,
    );
    return { ok: true };
  });

  app.put('/api/v1/users/@me/avatar', async (request) => {
    const auth = requireAuth(request);
    requireOwnAvatarEditable(auth.user.id);

    if (!request.isMultipart()) {
      throw new HttpError(415, 'unsupported_media_type', 'Expected a multipart/form-data upload.');
    }
    const file = await request.file();
    if (!file) throw new HttpError(400, 'file_required', 'No image was uploaded.');

    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch {
      throw new HttpError(413, 'payload_too_large', 'That image is too large.');
    }

    const response = present(await deps.users.updateAvatar(auth.user.id, { contentType: file.mimetype, data }));
    announce(auth.user.id);
    return response;
  });

  app.delete('/api/v1/users/@me/avatar', async (request) => {
    const auth = requireAuth(request);
    const row = requireOwnAvatarEditable(auth.user.id);
    const response = present(deps.users.clearAvatar(row.id));
    announce(row.id);
    return response;
  });

  /**
   * Pulls the member's Discord picture over right now. Only meaningful while
   * syncing is on and an account is linked, but harmless otherwise: the daily
   * sweep and every bridged message keep it current on their own.
   */
  app.post('/api/v1/users/@me/discord/sync', async (request) => {
    const auth = requireAuth(request);
    const row = findUserById(deps.db.sqlite, auth.user.id);
    if (!row?.discord_id) {
      throw new HttpError(400, 'not_linked', 'Connect your Discord account first.');
    }
    if (!deps.bridge.avatarSyncReady()) {
      throw new HttpError(503, 'bridge_unavailable', 'The Discord bridge is not connected right now.');
    }
    const updated = await deps.bridge.syncDiscordAvatarFor(auth.user.id);
    announce(auth.user.id);
    return present(updated ?? row);
  });

  app.put('/api/v1/users/@me/banner', async (request) => {
    const auth = requireAuth(request);

    if (!request.isMultipart()) {
      throw new HttpError(415, 'unsupported_media_type', 'Expected a multipart/form-data upload.');
    }
    const file = await request.file();
    if (!file) throw new HttpError(400, 'file_required', 'No image was uploaded.');

    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch {
      throw new HttpError(413, 'payload_too_large', 'That image is too large.');
    }

    const response = present(await deps.users.updateBanner(auth.user.id, { contentType: file.mimetype, data }));
    announce(auth.user.id);
    return response;
  });

  app.delete('/api/v1/users/@me/banner', async (request) => {
    const auth = requireAuth(request);
    const response = present(deps.users.clearBanner(auth.user.id));
    announce(auth.user.id);
    return response;
  });

  /**
   * The full profile a member sets about themselves: bio, status, colors and
   * social links. Fetched on its own rather than carried on every User, since it
   * is only needed when somebody actually opens a profile.
   */
  app.get('/api/v1/users/:id/profile', async (request) => {
    requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };
    const row = findUserById(deps.db.sqlite, id);
    if (!row) throw new HttpError(404, 'user_not_found', 'That user does not exist.');
    return presentUserProfile(row);
  });

  app.get('/api/v1/users/:id/avatar', async (request, reply) => {
    const { id } = request.params as { id: string };

    const row = findUserById(deps.db.sqlite, id);
    if (!row?.avatar_hash) {
      throw new HttpError(404, 'avatar_not_found', 'That user has no profile picture.');
    }

    // The content hash doubles as a capability: presenting it lets Discord fetch
    // an avatar without a session, while the route stays authenticated for
    // everyone else. Only avatars are exposed this way, never other uploads.
    const provided = (request.query as { v?: string }).v;
    if (provided !== row.avatar_hash) {
      requirePermission(request, Permission.ViewChannels);
    }

    const path = deps.users.avatarPath(row.avatar_hash);
    if (!existsSync(path)) {
      throw new HttpError(404, 'avatar_missing', 'That profile picture is missing from storage.');
    }

    // Always WebP: avatars are normalized on upload.
    reply
      .header('Content-Type', 'image/webp')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('ETag', `"${row.avatar_hash}"`);
    return reply.send(createReadStream(path));
  });

  app.get('/api/v1/users/:id/banner', async (request, reply) => {
    const { id } = request.params as { id: string };

    const row = findUserById(deps.db.sqlite, id);
    if (!row?.banner_hash) {
      throw new HttpError(404, 'banner_not_found', 'That user has no banner.');
    }

    // Same hash-as-capability rule as avatars: the hash in the URL is what lets a
    // cached image load, and everyone else still needs to be able to see channels.
    const provided = (request.query as { v?: string }).v;
    if (provided !== row.banner_hash) {
      requirePermission(request, Permission.ViewChannels);
    }

    const path = deps.users.bannerPath(row.banner_hash);
    if (!existsSync(path)) {
      throw new HttpError(404, 'banner_missing', 'That banner is missing from storage.');
    }

    reply
      .header('Content-Type', 'image/webp')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('ETag', `"${row.banner_hash}"`);
    return reply.send(createReadStream(path));
  });
}
