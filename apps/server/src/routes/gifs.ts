import { createReadStream, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { Permission, isGifLinkUrl, type GifArchiveResponse, type GifFreeResponse, type GifSourceStats, addGifFavoriteSchema, gifQuerySchema, gifSearchQuerySchema, linkGifSchema, pickGifSchema, type GifFavoriteListResponse, type GifListResponse, type GifSearchResponse } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import type { GifService } from '../gifs/service.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody, parseQuery } from '../http/validation.ts';
import { createRateLimiter } from '../http/rate-limit.ts';
import type { AuditService } from '../audit/service.ts';
import type { SettingsService } from '../settings/service.ts';
import type { GifSourceService } from '../gifs/sources.ts';
import { normalizeGifSourceUrl } from '../gifs/source-url.ts';

export interface GifRouteDeps {
  service: GifService;
  sources: GifSourceService;
  settings: SettingsService;
  audit: AuditService;
}

/** Addresses copied per archive request; the client repeats the call while more are waiting. */
const ARCHIVE_BATCH = 20;

/**
 * The gif picker. Favorites are private to the member who kept them, and picking a
 * gif only ever makes an attachment row out of bytes the instance already has — the
 * message itself is sent through the normal message endpoint afterwards, with that
 * attachment id, exactly as an upload would be. A hosted search is answered from the
 * server so the service's key, which sits in the request path, never reaches a
 * browser.
 */
export function registerGifRoutes(app: FastifyInstance, deps: GifRouteDeps): void {
  const archiveLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });
  const freeLimiter = createRateLimiter({ limit: 6, windowMs: 60_000 });

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

  /**
   * The copy this server holds of a remote gif, by the address the message links
   * to. While the instance stores gifs a missing copy is fetched once, here,
   * through the guarded downloader; while it links, only a copy that already
   * exists is served (the client falls back to it when the remote is gone). It
   * answers only for addresses that were recorded and are on a gif host, so it
   * is never a way to make the server fetch an arbitrary address.
   */
  app.get('/api/v1/gifs/copy', async (request, reply) => {
    requirePermission(request, Permission.ViewChannels);
    const { url } = parseQuery(linkGifSchema, request.query);
    const key = normalizeGifSourceUrl(url);
    const store = deps.settings.get().gifStorage === 'store';
    const copy = key === null || !isGifLinkUrl(key) ? null : store ? await deps.sources.ensureCopy(key) : deps.sources.copyFor(key);
    if (!copy) throw new HttpError(404, 'gif_not_found', 'There is no copy of that gif.');

    const path = deps.sources.filePathFor(copy.hash);
    reply
      .header('Content-Type', copy.content_type ?? 'image/gif')
      // Keyed by address, whose bytes could in principle be replaced after a release.
      .header('Cache-Control', 'private, max-age=86400')
      .header('Content-Length', String(statSync(path).size))
      .header('ETag', `"${copy.hash}"`);
    return reply.send(createReadStream(path));
  });

  /** Admin: how many gif addresses are recorded, copied and given up on. */
  app.get('/api/v1/gifs/sources', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const body: GifSourceStats = deps.sources.stats();
    return body;
  });

  /** Admin: copies one bounded batch of linked gifs onto this server. */
  app.post('/api/v1/gifs/sources/archive', async (request) => {
    const auth = requirePermission(request, Permission.ManageServer);
    archiveLimiter.check(auth.user.id);
    const body: GifArchiveResponse = await deps.sources.archive(ARCHIVE_BATCH);
    if (body.attempted > 0) deps.audit.gifsArchived(auth.user.id, body.copied);
    return body;
  });

  /** Admin: releases copies of gifs that are still linked and that nothing else keeps. */
  app.post('/api/v1/gifs/sources/free', async (request) => {
    const auth = requirePermission(request, Permission.ManageServer);
    freeLimiter.check(auth.user.id);
    if (deps.settings.get().gifStorage !== 'link') {
      throw new HttpError(409, 'gif_free_needs_link', 'Copies are in use while this server stores gifs; switch to linking first.');
    }
    const body: GifFreeResponse = deps.sources.free();
    deps.audit.gifsFreed(auth.user.id, body.released, body.freedBytes);
    return body;
  });

  app.post('/api/v1/gifs/pick', async (request) => {
    const auth = requirePermission(request, Permission.AttachFiles);
    const input = parseBody(pickGifSchema, request.body);
    return deps.service.pick(auth, input);
  });
}
