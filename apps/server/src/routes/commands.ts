import type { FastifyInstance } from 'fastify';
import { GatewayEvent, invokeCommandSchema } from '@harmony/shared';
import { requireAuth } from '../auth/plugin.ts';
import type { CommandService } from '../commands/service.ts';
import { createRateLimiter } from '../http/rate-limit.ts';
import { parseBody } from '../http/validation.ts';
import type { GatewayHub } from '../realtime/hub.ts';

export interface CommandRouteDeps {
  commands: CommandService;
  hub: GatewayHub;
}

/**
 * The command surface a normal client uses. The registry lists what the caller may
 * invoke (both permission gates already applied); invoking one hands it to the
 * bot over the gateway. The bot replies through the ordinary API, so nothing here
 * posts a message — a command is not chat.
 */
export function registerCommandRoutes(app: FastifyInstance, deps: CommandRouteDeps): void {
  const invokeLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

  app.get('/api/v1/commands', async (request) => {
    const auth = requireAuth(request);
    return deps.commands.listForInvoker(auth);
  });

  app.post('/api/v1/channels/:channelId/commands', async (request) => {
    const auth = requireAuth(request);
    invokeLimiter.check(auth.user.id);
    const { channelId } = request.params as { channelId: string };
    const input = parseBody(invokeCommandSchema, request.body);
    const invocation = deps.commands.invoke(auth, channelId, input.commandId, input.args ?? '');
    deps.hub.dispatchToUsers(GatewayEvent.CommandInvoke, invocation.event, new Set([invocation.botId]));
    return { interactionId: invocation.event.interactionId };
  });
}
