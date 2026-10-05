import type { FastifyInstance } from 'fastify';
import { Permission, createEventSchema, updateEventSchema } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import type { EventService } from '../events/service.ts';
import { createRateLimiter } from '../http/rate-limit.ts';
import { parseBody } from '../http/validation.ts';

export interface EventRouteDeps {
  service: EventService;
}

export function registerEventRoutes(app: FastifyInstance, deps: EventRouteDeps): void {
  // Toggling interest is cheap, but each change goes out to a whole audience.
  const rsvpLimiter = createRateLimiter({ limit: 30, windowMs: 10_000 });
  const writeLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });

  /** Upcoming and active events, plus recently finished ones, that the caller may see. */
  app.get('/api/v1/events', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    return deps.service.list(auth);
  });

  app.get('/api/v1/events/:id', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };
    return deps.service.get(auth, id);
  });

  /** Needs Manage Events. */
  app.post('/api/v1/events', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const input = parseBody(createEventSchema, request.body);
    writeLimiter.check(auth.user.id);
    return deps.service.create(auth, input);
  });

  /** Manage Events, or the event's creator. */
  app.patch('/api/v1/events/:id', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };
    const input = parseBody(updateEventSchema, request.body);
    writeLimiter.check(auth.user.id);
    return deps.service.update(auth, id, input);
  });

  /** Cancels an event. Manage Events, or the event's creator. */
  app.post('/api/v1/events/:id/cancel', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    writeLimiter.check(auth.user.id);
    const { id } = request.params as { id: string };
    return deps.service.cancel(auth, id);
  });

  /** Marks the caller interested; already interested is fine. */
  app.put('/api/v1/events/:id/interested', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    rsvpLimiter.check(auth.user.id);
    const { id } = request.params as { id: string };
    return deps.service.setInterested(auth, id, true);
  });

  /** Withdraws interest; not interested is fine. */
  app.delete('/api/v1/events/:id/interested', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    rsvpLimiter.check(auth.user.id);
    const { id } = request.params as { id: string };
    return deps.service.setInterested(auth, id, false);
  });

  /** Who is interested, for members who can see the event. */
  app.get('/api/v1/events/:id/interested', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };
    return deps.service.interested(auth, id);
  });
}
