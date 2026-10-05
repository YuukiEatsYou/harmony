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
import type { UserService } from '../users/service.ts';

export interface UserRouteDeps {
  db: Database;
  users: UserService;
  hub: GatewayHub;
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

  app.patch('/api/v1/users/@me', async (request) => {
    const auth = requireAuth(request);
    const input = parseBody(updateProfileSchema, request.body);
    const response = present(deps.users.updateProfile(auth.user.id, input));
    announce(auth.user.id);
    return response;
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
    const response = present(deps.users.clearAvatar(auth.user.id));
    announce(auth.user.id);
    return response;
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
