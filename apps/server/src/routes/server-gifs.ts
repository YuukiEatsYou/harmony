import { createReadStream, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  Permission,
  addServerGifSchema,
  gifQuerySchema,
  hideServerGifSchema,
  orderServerGifsSchema,
  updateServerGifSchema,
  type ServerGifListResponse,
  type ServerGifManageResponse,
} from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import type { ServerGifService } from '../gifs/server-gifs.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody, parseQuery } from '../http/validation.ts';

export interface ServerGifRouteDeps {
  service: ServerGifService;
}

/**
 * The picker's Server tab and its curation. Reading is open to anyone who can use
 * the picker; changing the list needs the same permission as managing custom
 * emoji (ManageEmojis), since both are the community's shared sticker shelf.
 */
export function registerServerGifRoutes(app: FastifyInstance, deps: ServerGifRouteDeps): void {
  app.get('/api/v1/gifs/server', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const query = parseQuery(gifQuerySchema, request.query);
    const body: ServerGifListResponse = { gifs: deps.service.list(auth, query) };
    return body;
  });

  app.get('/api/v1/gifs/server/manage', async (request) => {
    const auth = requirePermission(request, Permission.ManageEmojis);
    const body: ServerGifManageResponse = deps.service.manage(auth);
    return body;
  });

  app.post('/api/v1/gifs/server', async (request) => {
    const auth = requirePermission(request, Permission.ManageEmojis);
    const input = parseBody(addServerGifSchema, request.body);
    return deps.service.add(auth, input);
  });

  app.post('/api/v1/gifs/server/order', async (request, reply) => {
    const auth = requirePermission(request, Permission.ManageEmojis);
    const input = parseBody(orderServerGifsSchema, request.body);
    deps.service.reorder(auth, input.ids);
    return reply.status(204).send();
  });

  app.post('/api/v1/gifs/server/hide', async (request) => {
    const auth = requirePermission(request, Permission.ManageEmojis);
    const input = parseBody(hideServerGifSchema, request.body);
    return deps.service.hide(auth, input.attachmentId);
  });

  app.patch('/api/v1/gifs/server/:id', async (request) => {
    const auth = requirePermission(request, Permission.ManageEmojis);
    const { id } = request.params as { id: string };
    const input = parseBody(updateServerGifSchema, request.body);
    return deps.service.update(auth, id, input);
  });

  app.delete('/api/v1/gifs/server/:id', async (request, reply) => {
    const auth = requirePermission(request, Permission.ManageEmojis);
    const { id } = request.params as { id: string };
    deps.service.remove(auth, id);
    return reply.status(204).send();
  });

  /** Sending a curated gif: the same pending attachment a normal pick produces. */
  app.post('/api/v1/gifs/server/:id/pick', async (request) => {
    const auth = requirePermission(request, Permission.AttachFiles);
    const { id } = request.params as { id: string };
    return deps.service.pick(auth, id);
  });

  /** The bytes of a curated or hidden row, for the picker and the admin grids. */
  app.get('/api/v1/gifs/server/:id/image', async (request, reply) => {
    requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };

    const row = deps.service.find(id);
    if (!row) throw new HttpError(404, 'gif_not_found', 'That gif does not exist.');
    const path = deps.service.filePathFor(row);
    if (!path) throw new HttpError(404, 'gif_missing', 'That gif is missing from storage.');

    reply
      .header('Content-Type', row.content_type)
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('Content-Length', String(statSync(path).size))
      .header('ETag', `"${row.hash}"`);
    return reply.send(createReadStream(path));
  });
}
