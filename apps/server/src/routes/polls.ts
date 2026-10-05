import type { FastifyInstance } from 'fastify';
import { Permission, createPollSchema, pollVotersQuerySchema, votePollSchema } from '@harmony/shared';
import { requireAuth, requirePermission } from '../auth/plugin.ts';
import { createRateLimiter } from '../http/rate-limit.ts';
import { parseBody, parseQuery } from '../http/validation.ts';
import type { PollService } from '../polls/service.ts';

export interface PollRouteDeps {
  service: PollService;
}

export function registerPollRoutes(app: FastifyInstance, deps: PollRouteDeps): void {
  // Changing a vote is cheap and people do flip back and forth, but a script
  // hammering it would flood every client in the channel with updates.
  const voteLimiter = createRateLimiter({ limit: 30, windowMs: 10_000 });

  /** Posts a poll as a message. Needs the same rights as sending one. */
  app.post('/api/v1/channels/:id/polls', async (request) => {
    const auth = requirePermission(request, Permission.SendMessages);
    const { id } = request.params as { id: string };
    const input = parseBody(createPollSchema, request.body);
    return deps.service.create(auth, id, input);
  });

  /** Replaces the caller's whole choice; an empty list withdraws it. */
  app.put('/api/v1/messages/:id/poll/votes', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    voteLimiter.check(auth.user.id);
    const { id } = request.params as { id: string };
    const input = parseBody(votePollSchema, request.body);
    return deps.service.vote(auth, id, input);
  });

  /** Closes a poll early. The author or a moderator. */
  app.post('/api/v1/messages/:id/poll/end', async (request) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };
    return deps.service.end(auth, id);
  });

  /** Who chose one option. */
  app.get('/api/v1/messages/:id/poll/voters', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };
    const query = parseQuery(pollVotersQuerySchema, request.query);
    return deps.service.voters(auth, id, query.optionId);
  });
}
