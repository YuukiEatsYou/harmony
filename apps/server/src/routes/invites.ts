import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Permission, createInviteSchema, inviteCheckSchema, type InviteCheckResponse } from '@harmony/shared';
import { requirePermission } from '../auth/plugin.ts';
import type { AuthService } from '../auth/service.ts';
import type { Database } from '../db/index.ts';
import { findInvite, insertInvite, listInvites, toInvite, deleteInvite } from '../db/invites.ts';
import { HttpError } from '../http/errors.ts';
import { createRateLimiter } from '../http/rate-limit.ts';
import { parseBody } from '../http/validation.ts';

export interface InviteRouteDeps {
  db: Database;
  auth: AuthService;
}

export function registerInviteRoutes(app: FastifyInstance, deps: InviteRouteDeps): void {
  const db = deps.db;

  // A code is short, and a client checks one as somebody types, so this is
  // generous for a person and still blunts a scripted sweep. Per-IP.
  const checkLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });

  /**
   * The pre-flight invite check. Unauthenticated on purpose: it is used from the
   * sign-in screen, before there is a session. POST rather than GET so the code
   * never lands in access logs or browser history.
   *
   * It mirrors `register` exactly through `verifyInvite`, and consumes nothing —
   * a code that passes here can still be spent or expire before the registration
   * that follows, which re-checks it authoritatively.
   */
  app.post('/api/v1/invites/check', async (request) => {
    checkLimiter.check(request.ip);
    const input = parseBody(inviteCheckSchema, request.body);
    deps.auth.verifyInvite(input.code);
    const body: InviteCheckResponse = { valid: true };
    return body;
  });

  app.get('/api/v1/invites', async (request) => {
    // Anyone with `CreateInvites` may mint codes, but seeing every invite is a management view.
    requirePermission(request, Permission.ManageServer);
    return { invites: listInvites(db.sqlite).map(toInvite) };
  });

  app.post('/api/v1/invites', async (request) => {
    const auth = requirePermission(request, Permission.CreateInvites);
    const input = parseBody(createInviteSchema, request.body ?? {});

    const code = randomBytes(6).toString('base64url');
    const expiresAt = input.expiresInHours
      ? new Date(Date.now() + input.expiresInHours * 3_600_000).toISOString()
      : null;

    insertInvite(db.sqlite, {
      code,
      createdBy: auth.user.id,
      createdAt: new Date().toISOString(),
      expiresAt,
      maxUses: input.maxUses ?? null,
    });

    const invite = findInvite(db.sqlite, code);
    if (!invite) throw new HttpError(500, 'internal_error', 'Failed to create the invite.');
    return toInvite(invite);
  });

  app.delete('/api/v1/invites/:code', async (request, reply) => {
    requirePermission(request, Permission.ManageServer);
    const { code } = request.params as { code: string };
    deleteInvite(db.sqlite, code);
    return reply.status(204).send();
  });
}
