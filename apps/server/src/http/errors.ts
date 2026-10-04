import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Any error that should be surfaced to the client with a specific status. */
export class HttpError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface ErrorHandlerOptions {
  /**
   * Absolute path of the client's `index.html`. When set, a GET that looks like a
   * client-side route is answered with the app shell instead of a JSON 404.
   */
  spaIndex?: string | null;
}

/**
 * Whether a request should be answered with the client app rather than a 404.
 * API and gateway paths never are, and neither is anything that names a file:
 * a missing `/assets/x.js` is a real 404, not the app shell.
 */
function isClientRoute(request: FastifyRequest): boolean {
  if (request.method !== 'GET') return false;
  const path = request.url.split('?')[0] ?? '';
  if (path.startsWith('/api/') || path === '/gateway') return false;
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  return !lastSegment.includes('.');
}

/**
 * Codes for the client errors Fastify raises on its own, in the same vocabulary
 * the routes use for theirs. Anything not listed is reported as `bad_request`.
 */
const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  406: 'not_acceptable',
  408: 'request_timeout',
  413: 'payload_too_large',
  414: 'uri_too_long',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  431: 'headers_too_large',
};

/** Installs a JSON error handler and 404 handler with a consistent body shape. */
export function registerErrorHandler(app: FastifyInstance, options: ErrorHandlerOptions = {}): void {
  const spaIndex = options.spaIndex ?? null;

  app.setNotFoundHandler((request, reply) => {
    if (spaIndex !== null && isClientRoute(request)) {
      reply.header('Cache-Control', 'no-cache');
      return reply.type('text/html').send(createReadStream(spaIndex));
    }
    reply.status(404).send({
      error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
      return;
    }

    // Fastify and its plugins refuse bad requests themselves before a handler
    // runs: a body that is not valid JSON, an empty JSON body, an unsupported
    // content type, a body or upload over the limit. Those are the client's
    // mistake and say so in their status, so pass it on rather than reporting a
    // server fault and logging it as one.
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      reply.status(status).send({
        error: { code: CLIENT_ERROR_CODES[status] ?? 'bad_request', message: (error as Error).message },
      });
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    reply.status(500).send({
      error: { code: 'internal_error', message: 'Something went wrong.' },
    });
  });
}
