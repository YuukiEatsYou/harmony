import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  GatewayEvent,
  Permission,
  updateDiscordAuthSchema,
  type DiscordAuthResponse,
} from '@harmony/shared';
import type { Config } from '../config.ts';
import type { DiscordOAuthService } from '../auth/discord-oauth.ts';
import type { AuthService } from '../auth/service.ts';
import { requireAuth, requirePermission } from '../auth/plugin.ts';
import type { Database } from '../db/index.ts';
import { findUserById } from '../db/users.ts';
import { STATE_TTL_MS } from '../auth/discord-oauth.ts';
import {
  clearDiscordFlowCookie,
  discordFlowCookieName,
  setDiscordFlowCookie,
  setSessionCookie,
} from '../http/cookies.ts';
import { HttpError } from '../http/errors.ts';
import { createRateLimiter } from '../http/rate-limit.ts';
import { parseBody } from '../http/validation.ts';
import type { GatewayHub } from '../realtime/hub.ts';
import type { BridgeService } from '../bridge/service.ts';
import type { SettingsService } from '../settings/service.ts';
import type { UserService } from '../users/service.ts';

export interface DiscordRouteDeps {
  db: Database;
  config: Config;
  settings: SettingsService;
  oauth: DiscordOAuthService;
  auth: AuthService;
  users: UserService;
  hub: GatewayHub;
  /** Used to pull a freshly linked member's picture over straight away. */
  bridge: BridgeService;
}

export function registerDiscordRoutes(app: FastifyInstance, deps: DiscordRouteDeps): void {
  // The flow hands control to Discord and back, so a client cannot retry it in a
  // tight loop; these just blunt an obvious flood.
  const startLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });
  const callbackLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });
  // Creating accounts is held to the same pace as registering one.
  const signupLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

  /** Sends the browser back to the app with a short code the client explains. */
  function backTo(reply: FastifyReply, params: Record<string, string>): FastifyReply {
    return reply.redirect(`/?${new URLSearchParams(params).toString()}`);
  }

  function publicConfig(): DiscordAuthResponse {
    const auth = deps.settings.getDiscordAuth();
    return {
      clientId: auth.clientId,
      configured: auth.clientId !== null && auth.clientSecret !== null,
      enabled: auth.enabled,
      redirectUri: deps.settings.discordRedirectUri(),
    };
  }

  /** Admin view of the Discord sign-in settings, and how to finish setting it up. */
  app.get('/api/v1/discord/auth', async (request) => {
    requirePermission(request, Permission.ManageServer);
    return publicConfig();
  });

  app.patch('/api/v1/discord/auth', async (request) => {
    requirePermission(request, Permission.ManageServer);
    const input = parseBody(updateDiscordAuthSchema, request.body);
    deps.settings.updateDiscordAuth(input);
    return publicConfig();
  });

  /**
   * Starts the Discord flow. `intent=link` connects a Discord account to the
   * signed-in member; the default is to sign in with it. A browser lands here by
   * navigation, so failures come back as a redirect rather than a JSON error.
   */
  app.get('/api/v1/auth/discord', async (request, reply) => {
    if (!deps.oauth.enabled()) return backTo(reply, { discord_error: 'disabled' });
    startLimiter.check(request.ip);

    const intent = (request.query as { intent?: string }).intent === 'link' ? 'link' : 'login';
    // Linking is a change to an account, so it must be started by its owner.
    if (intent === 'link' && !request.auth) return backTo(reply, { discord_error: 'not_signed_in' });

    const invite = (request.query as { invite?: string }).invite?.trim().slice(0, 200) || null;
    const flow = deps.oauth.authorizeUrl(intent, {
      inviteCode: intent === 'login' ? invite : null,
      userId: intent === 'link' ? (request.auth?.user.id ?? null) : null,
    });
    setDiscordFlowCookie(reply, deps.config, flow.binding, STATE_TTL_MS / 1000);
    return reply.redirect(flow.url);
  });

  /**
   * Discord sends the member back here. What happens depends on the intent the
   * flow started with: connect the account, or sign it in. Either way the browser
   * is then redirected into the app with a code it can explain.
   */
  app.get('/api/v1/auth/discord/callback', async (request, reply) => {
    callbackLimiter.check(request.ip);
    const query = request.query as { code?: string; state?: string; error?: string };
    const binding = request.cookies[discordFlowCookieName(deps.config)] ?? null;
    // One flow, one use: whatever happens below, the binding is spent.
    clearDiscordFlowCookie(reply, deps.config);

    // The member pressed "Cancel" on Discord's consent screen, or Discord refused.
    if (query.error) return backTo(reply, { discord_error: 'denied' });
    if (!query.code || !query.state) return backTo(reply, { discord_error: 'failed' });

    let result: Awaited<ReturnType<DiscordOAuthService['complete']>>;
    try {
      result = await deps.oauth.complete(query.code, query.state, binding);
    } catch {
      // Expired state, a refused token exchange, or an unreadable account: all
      // the same to the member, who can simply try again.
      return backTo(reply, { discord_error: 'failed' });
    }

    if (result.intent === 'link') {
      const auth = request.auth;
      if (!auth) return backTo(reply, { discord_error: 'not_signed_in' });
      // Only the member who started a link may finish it, even in the same browser.
      if (result.userId !== auth.user.id) return backTo(reply, { discord_error: 'failed' });
      try {
        // Ownership is proven by the round trip, so this is the safe path the
        // manual admin entry could never be.
        deps.users.linkDiscord(auth.user.id, result.identity.id);
      } catch (error) {
        const code = error instanceof HttpError && error.statusCode === 409 ? 'taken' : 'failed';
        return backTo(reply, { discord_error: code });
      }
      deps.hub.dispatch(GatewayEvent.MemberUpdate, { userId: auth.user.id });
      // A linked picture follows Discord by default, so catch it up now rather than
      // leave a blank face until the next message or the daily sweep. Best-effort:
      // a bridge that is down must not hold up the redirect.
      const linked = findUserById(deps.db.sqlite, auth.user.id);
      if (linked?.sync_discord_avatar === 1 && deps.bridge.avatarSyncReady()) {
        await deps.bridge.syncDiscordAvatarFor(auth.user.id).catch(() => null);
      }
      return backTo(reply, { discord: 'linked' });
    }

    // Signing in creates the account the first time, so it is held to the same
    // pace as registering one.
    signupLimiter.check(request.ip);
    try {
      const { auth: session, created } = deps.auth.signInWithDiscord(
        result.identity,
        result.inviteCode,
        request.headers['user-agent'] ?? null,
      );
      setSessionCookie(reply, deps.config, session.token);
      // Give the account the picture from Discord, unless it already has one (a
      // stand-in's picture, or one the member chose). Best-effort: a picture must
      // never hold up a sign-in.
      let changed = created;
      if (!session.user.avatarHash && result.identity.avatarUrl) {
        const data = await deps.oauth.downloadAvatar(result.identity.avatarUrl).catch(() => null);
        if (data && (await deps.users.setAvatarFromData(session.user.id, data).catch(() => null))) {
          changed = true;
        }
      }
      if (changed) deps.hub.dispatch(GatewayEvent.MemberUpdate, { userId: session.user.id });
      return backTo(reply, { discord: created ? 'signed_up' : 'signed_in' });
    } catch (error) {
      // These are all things the person can act on, so they get their own code.
      if (error instanceof HttpError && error.statusCode === 403) {
        return backTo(reply, { discord_error: error.code });
      }
      return backTo(reply, { discord_error: 'failed' });
    }
  });

  /** Clears the caller's own Discord link. What was merged in stays merged. */
  app.delete('/api/v1/users/@me/discord', async (request, reply) => {
    const auth = requireAuth(request);
    deps.users.linkDiscord(auth.user.id, null);
    deps.hub.dispatch(GatewayEvent.MemberUpdate, { userId: auth.user.id });
    return reply.status(204).send();
  });
}
