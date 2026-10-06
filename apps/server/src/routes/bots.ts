import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  GatewayEvent,
  createBotSchema,
  permissionsFromString,
  updateBotSchema,
  type BotCreateResponse,
  type BotTokenResponse,
} from '@harmony/shared';
import { requireAuth } from '../auth/plugin.ts';
import type { AuthContext } from '../auth/service.ts';
import { maskPermissions, type BotService } from '../bots/service.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody } from '../http/validation.ts';
import type { GatewayHub } from '../realtime/hub.ts';
import type { UserService } from '../users/service.ts';

export interface BotRouteDeps {
  bots: BotService;
  users: UserService;
  hub: GatewayHub;
}

/**
 * Bot management, owner-only. A bot token is a long-lived credential that acts as
 * the bot, so creating, editing, re-issuing and deleting one is the owner's alone,
 * like the server log and the update button. A bot's own API calls go through the
 * ordinary routes and gateway, authenticated by its token, not through here.
 */
export function registerBotRoutes(app: FastifyInstance, deps: BotRouteDeps): void {
  const ownerOnly = (request: FastifyRequest): AuthContext => {
    const auth = requireAuth(request);
    if (!auth.user.isOwner) {
      throw new HttpError(403, 'owner_only', 'Only the owner can manage bots.');
    }
    return auth;
  };

  app.get('/api/v1/bots', async (request) => {
    ownerOnly(request);
    return deps.bots.list();
  });

  app.post('/api/v1/bots', async (request) => {
    ownerOnly(request);
    const input = parseBody(createBotSchema, request.body);
    const result: BotCreateResponse = deps.bots.create({
      username: input.username,
      displayName: input.displayName ?? null,
      permissions: maskPermissions(permissionsFromString(input.permissions)),
    });
    deps.hub.dispatch(GatewayEvent.MemberUpdate, { userId: result.bot.user.id });
    return result;
  });

  app.patch('/api/v1/bots/:id', async (request) => {
    ownerOnly(request);
    const { id } = request.params as { id: string };
    const input = parseBody(updateBotSchema, request.body);
    const bot = deps.bots.update(id, {
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...('displayName' in input ? { displayName: input.displayName ?? null } : {}),
      ...(input.permissions !== undefined
        ? { permissions: maskPermissions(permissionsFromString(input.permissions)) }
        : {}),
    });
    deps.hub.dispatch(GatewayEvent.MemberUpdate, { userId: bot.user.id });
    return bot;
  });

  app.put('/api/v1/bots/:id/avatar', async (request) => {
    ownerOnly(request);
    const { id } = request.params as { id: string };
    // Confirms the target is a bot before touching an avatar, so this can never
    // rewrite a person's picture.
    deps.bots.get(id);

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

    const row = await deps.users.setAvatarFromData(id, data);
    if (!row) throw new HttpError(415, 'invalid_image', 'That file is not a readable image.');
    deps.hub.dispatch(GatewayEvent.MemberUpdate, { userId: id });
    return deps.bots.get(id);
  });

  app.post('/api/v1/bots/:id/token', async (request) => {
    ownerOnly(request);
    const { id } = request.params as { id: string };
    const body: BotTokenResponse = { token: deps.bots.regenerateToken(id) };
    return body;
  });

  app.delete('/api/v1/bots/:id', async (request, reply) => {
    ownerOnly(request);
    const { id } = request.params as { id: string };
    deps.bots.remove(id);
    deps.hub.dispatch(GatewayEvent.MemberUpdate, { userId: id });
    return reply.status(204).send();
  });
}
