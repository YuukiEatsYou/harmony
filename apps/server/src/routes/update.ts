import type { FastifyInstance, FastifyRequest } from 'fastify';
import { updateAutoCheckSchema, type UpdateStatus } from '@harmony/shared';
import { requireAuth } from '../auth/plugin.ts';
import type { AuthContext } from '../auth/service.ts';
import { HttpError } from '../http/errors.ts';
import { createRateLimiter } from '../http/rate-limit.ts';
import { parseBody } from '../http/validation.ts';
import type { SettingsService } from '../settings/service.ts';
import type { UpdateService } from '../update/service.ts';

export interface UpdateRouteDeps {
  settings: Pick<SettingsService, 'setUpdateCheck'>;
  update: UpdateService;
}

/**
 * The update check is the owner's, not every administrator's: they are the one
 * who holds the machine and would apply a release. The routes are owner-only for
 * the same reason the server log is.
 */
export function registerUpdateRoutes(app: FastifyInstance, deps: UpdateRouteDeps): void {
  const ownerOnly = (request: FastifyRequest): AuthContext => {
    const auth = requireAuth(request);
    if (!auth.user.isOwner) {
      throw new HttpError(403, 'owner_only', 'Only the owner can manage updates.');
    }
    return auth;
  };
  // A person pressing the button cannot hammer the source; the check is one GET.
  const manual = createRateLimiter({ limit: 6, windowMs: 60_000 });

  app.get('/api/v1/update', async (request) => {
    ownerOnly(request);
    return deps.update.status();
  });

  app.post('/api/v1/update/check', async (request) => {
    const auth = ownerOnly(request);
    manual.check(auth.user.id);
    const body: UpdateStatus = await deps.update.check();
    return body;
  });

  app.patch('/api/v1/update', async (request) => {
    ownerOnly(request);
    const input = parseBody(updateAutoCheckSchema, request.body);
    deps.settings.setUpdateCheck(input.autoCheck);
    deps.update.refresh();
    return deps.update.status();
  });
}
