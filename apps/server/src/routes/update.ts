import type { FastifyInstance, FastifyRequest } from 'fastify';
import { updateApplySchema, updatePatchSchema, type UpdatePanel } from '@harmony/shared';
import { requireAuth } from '../auth/plugin.ts';
import type { AuthContext } from '../auth/service.ts';
import { HttpError } from '../http/errors.ts';
import { createRateLimiter } from '../http/rate-limit.ts';
import { parseBody } from '../http/validation.ts';
import type { SettingsService } from '../settings/service.ts';
import type { UpdateApplier } from '../update/apply.ts';
import type { UpdateService } from '../update/service.ts';

export interface UpdateRouteDeps {
  settings: Pick<SettingsService, 'setUpdateCheck' | 'setUpdateBackupRetention' | 'getUpdateBackupRetention'>;
  update: UpdateService;
  applier: UpdateApplier;
  /** The configured update command, shown to the owner so what runs is never a surprise. */
  updateCommand: string | null;
  /** A random id for this process, so a restart is detectable from the panel. */
  instanceId: string;
}

/**
 * The update check and the apply button are the owner's, not every administrator's:
 * they are the one who holds the machine and would apply a release. The routes are
 * owner-only for the same reason the server log is.
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
  // The apply itself is guarded one-at-a-time; this only stops a person retrying in
  // a tight loop. The body is required and read as JSON, which a cross-site form
  // cannot send, so the same guard the other writes use applies here too.
  const applyLimiter = createRateLimiter({ limit: 3, windowMs: 60_000 });

  const panel = (): UpdatePanel => ({
    ...deps.update.status(),
    instanceId: deps.instanceId,
    command: deps.updateCommand,
    backupRetention: deps.settings.getUpdateBackupRetention(),
    ...deps.applier.state(),
    snapshots: deps.applier.snapshots(),
  });

  app.get('/api/v1/update', async (request) => {
    ownerOnly(request);
    return panel();
  });

  app.post('/api/v1/update/check', async (request) => {
    const auth = ownerOnly(request);
    manual.check(auth.user.id);
    await deps.update.check();
    return panel();
  });

  app.patch('/api/v1/update', async (request) => {
    ownerOnly(request);
    const input = parseBody(updatePatchSchema, request.body);
    if (input.autoCheck !== undefined) deps.settings.setUpdateCheck(input.autoCheck);
    if (input.backupRetention !== undefined) deps.settings.setUpdateBackupRetention(input.backupRetention);
    deps.update.refresh();
    return panel();
  });

  app.post('/api/v1/update/apply', async (request) => {
    const auth = ownerOnly(request);
    applyLimiter.check(auth.user.id);
    const input = parseBody(updateApplySchema, request.body);
    // Throws 409 when there is no command, one is already running, or the snapshot
    // cannot be written; the command and the restart happen in the applier.
    await deps.applier.apply({ backup: input.backup });
    return panel();
  });
}
