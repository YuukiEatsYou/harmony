import type { FastifyInstance } from 'fastify';
import {
  Permission,
  channelMediaQuerySchema,
  mediaQuerySchema,
  type ChannelMediaResponse,
  type MediaListResponse,
} from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import type { AuditService } from '../audit/service.ts';
import { parseQuery } from '../http/validation.ts';
import type { MediaService } from '../media/service.ts';

export interface MediaRouteDeps {
  service: MediaService;
  audit: AuditService;
}

/**
 * The admin media gallery. The attachment delete lives here rather than with the
 * upload/read routes because it is a gallery action: it also reclaims the stored
 * bytes once nothing else references them.
 */
export function registerMediaRoutes(app: FastifyInstance, deps: MediaRouteDeps): void {
  app.get('/api/v1/media', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const query = parseQuery(mediaQuerySchema, request.query);
    const body: MediaListResponse = deps.service.list(query);
    return body;
  });

  /**
   * One channel's media gallery, for anyone who can see the channel. Deliberately
   * not the admin gallery's permission: this is a view of a channel's own history,
   * scoped to the channel the viewer is looking at, so it matches reading it.
   */
  app.get('/api/v1/channels/:id/media', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };
    const query = parseQuery(channelMediaQuerySchema, request.query);
    const body: ChannelMediaResponse = deps.service.channelMedia(id, query, auth.user.id);
    return body;
  });

  app.delete('/api/v1/attachments/:id', async (request, reply) => {
    const auth = requirePermission(request, Permission.ManageServer);
    const { id } = request.params as { id: string };
    const removed = deps.service.remove(id);
    deps.audit.mediaDeleted(auth.user.id, removed.filename, removed.channelName);
    return reply.status(204).send();
  });

  /**
   * Removes every stored copy of one piece of content. The gallery groups by hash,
   * so this is what its delete acts on: deleting one copy of shared bytes would
   * leave the others, and the blob, in place.
   */
  app.delete('/api/v1/media/:hash', async (request, reply) => {
    const auth = requirePermission(request, Permission.ManageServer);
    const { hash } = request.params as { hash: string };
    const removed = deps.service.removeByHash(hash);
    deps.audit.mediaDeleted(auth.user.id, removed.filename, removed.channelName);
    return reply.status(204).send();
  });
}
