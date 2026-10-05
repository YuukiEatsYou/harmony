import type { FastifyInstance } from 'fastify';
import {
  Permission,
  createMessageSchema,
  editMessageSchema,
  messageHistoryQuerySchema,
  reactionQuerySchema,
  reactionSchema,
  type MessageEditListResponse,
  type MessageListResponse,
} from '@harmony/shared';
import { requireAuth, requirePermission } from '../auth/plugin.ts';
import { parseBody, parseQuery } from '../http/validation.ts';
import type { MessageService } from '../messages/service.ts';

export interface MessageRouteDeps {
  service: MessageService;
}

export function registerMessageRoutes(app: FastifyInstance, deps: MessageRouteDeps): void {
  app.get('/api/v1/channels/:id/messages', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };
    const query = parseQuery(messageHistoryQuerySchema, request.query);
    const body: MessageListResponse = deps.service.history(id, query, auth.user.id);
    return body;
  });

  app.post('/api/v1/channels/:id/messages', async (request) => {
    const auth = requirePermission(request, Permission.SendMessages);
    const { id } = request.params as { id: string };
    const input = parseBody(createMessageSchema, request.body);
    return deps.service.create(auth, id, input.content, input.attachmentIds ?? [], input.replyToId ?? null);
  });

  app.patch('/api/v1/messages/:id', async (request) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    const input = parseBody(editMessageSchema, request.body);
    return deps.service.edit(auth, id, input.content);
  });

  /** Earlier versions of an edited message; author and Manage Messages only. */
  app.get('/api/v1/messages/:id/edits', async (request) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    const body: MessageEditListResponse = { edits: deps.service.editHistory(auth, id) };
    return body;
  });

  app.delete('/api/v1/messages/:id', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    deps.service.remove(auth, id);
    return reply.status(204).send();
  });

  /** Adds the caller's reaction, or removes it when they already reacted. */
  app.post('/api/v1/messages/:id/reactions', async (request) => {
    const auth = requirePermission(request, Permission.AddReactions);
    const { id } = request.params as { id: string };
    const input = parseBody(reactionSchema, request.body);
    return deps.service.toggleReaction(auth, id, input.emoji, input.emojiId ?? null);
  });

  /** Clears every user's reaction of one emoji. Requires ManageMessages. */
  app.delete('/api/v1/messages/:id/reactions', async (request) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    const query = parseQuery(reactionQuerySchema, request.query);
    return deps.service.clearReactions(auth, id, query.emoji, query.emojiId ?? null);
  });
}
