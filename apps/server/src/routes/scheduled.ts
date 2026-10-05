import type { FastifyInstance } from 'fastify';
import {
  Permission,
  createScheduledMessageSchema,
  updateScheduledMessageSchema,
  type ScheduledMessageListResponse,
} from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import { parseBody } from '../http/validation.ts';
import type { ScheduledMessageService } from '../scheduled/service.ts';

export interface ScheduledRouteDeps {
  service: ScheduledMessageService;
}

export function registerScheduledRoutes(app: FastifyInstance, deps: ScheduledRouteDeps): void {
  /** The caller's own scheduled messages, soonest first, failed ones included. */
  app.get('/api/v1/users/@me/scheduled', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const body: ScheduledMessageListResponse = deps.service.list(auth);
    return body;
  });

  /** Schedules a message in a channel the caller can post in. */
  app.post('/api/v1/channels/:id/scheduled', async (request, reply) => {
    const auth = requirePermission(request, Permission.SendMessages);
    const { id } = request.params as { id: string };
    const input = parseBody(createScheduledMessageSchema, request.body);
    return reply.status(201).send(deps.service.create(auth, id, input));
  });

  /** Changes the text and/or time of one of the caller's own. */
  app.patch('/api/v1/users/@me/scheduled/:id', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };
    const input = parseBody(updateScheduledMessageSchema, request.body);
    return deps.service.update(auth, id, input);
  });

  /** Cancels one; already gone is fine. */
  app.delete('/api/v1/users/@me/scheduled/:id', async (request, reply) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };
    deps.service.cancel(auth, id);
    return reply.status(204).send();
  });

  /** Sends one right now and returns the message it became. */
  app.post('/api/v1/users/@me/scheduled/:id/send', async (request) => {
    const auth = requirePermission(request, Permission.SendMessages);
    const { id } = request.params as { id: string };
    return deps.service.sendNow(auth, id);
  });
}
