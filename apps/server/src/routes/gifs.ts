import { createReadStream, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { Permission, addGifFavoriteSchema, gifQuerySchema, gifSearchQuerySchema, linkGifSchema, pickGifSchema, type GifFavoriteListResponse, type GifListResponse, type GifSearchResponse } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import type { GifService } from '../gifs/service.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody, parseQuery } from '../http/validation.ts';

export interface GifRouteDeps {
  service: GifService;
}

/**
 * The gif picker. Favorites are private to the member who kept them, and picking a
 * gif only ever makes an attachment row out of bytes the instance already has — the
 * message itself is sent through the normal message endpoint afterwards, with that
 * attachment id, exactly as an upload would be. A hosted search is answered from the
 * server so the service's key, which sits in the request path, never reaches a
 * browser.
 */
export function registerGifRoutes(app: FastifyInstance, deps: GifRouteDeps): void {
  app.get('/api/v1/gifs/favorites', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const body: GifFavoriteListResponse = { favorites: deps.service.listFavorites(auth) };
    return body;
  });

  app.post('/api/v1/gifs/favorites', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const input = parseBody(addGifFavoriteSchema, request.body);
    return deps.service.addFavorite(auth, input);
  });

  app.get('/api/v1/gifs/klipy', async (request) => {
    requirePermission(request, Permission.ViewChannels);
    const query = parseQuery(gifSearchQuerySchema, request.query);
    const body: GifSearchResponse = { gifs: await deps.service.searchKlipy(query) };
    return body;
  });

  app.get('/api/v1/gifs/local', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const query = parseQuery(gifQuerySchema, request.query);
    const body: GifListResponse = { gifs: deps.service.listLocal(auth, query) };
    return body;
  });

  app.delete('/api/v1/gifs/favorites/:id', async (request, reply) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };
    deps.service.removeFavorite(auth, id);
    return reply.status(204).send();
  });

  app.get('/api/v1/gifs/favorites/:id/image', async (request, reply) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };

    const favorite = deps.service.listFavorites(auth).find((entry) => entry.id === id);
    if (!favorite) throw new HttpError(404, 'gif_not_found', 'That gif does not exist.');

    const path = deps.service.filePathFor(favorite);
    if (!path) throw new HttpError(404, 'gif_missing', 'That gif is missing from storage.');

    // Blobs are content-addressed, so a kept gif's bytes never change.
    reply
      .header('Content-Type', favorite.contentType)
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('Content-Length', String(statSync(path).size))
      .header('ETag', `"${favorite.hash}"`);
    return reply.send(createReadStream(path));
  });

  /** Checks a gif address for linking; only meaningful while the instance is set to link. */
  app.post('/api/v1/gifs/link', async (request) => {
    const auth = requirePermission(request, Permission.AttachFiles);
    const input = parseBody(linkGifSchema, request.body);
    return deps.service.link(auth, input.url);
  });

  app.post('/api/v1/gifs/pick', async (request) => {
    const auth = requirePermission(request, Permission.AttachFiles);
    const input = parseBody(pickGifSchema, request.body);
    return deps.service.pick(auth, input);
  });
}
