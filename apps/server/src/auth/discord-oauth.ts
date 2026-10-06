import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fetchPublicImage } from '../embeds/media.ts';
import { HttpError } from '../http/errors.ts';
import type { SettingsService } from '../settings/service.ts';

/**
 * Discord sign-in, as an optional extra on top of username and password. It
 * also creates the account for somebody signing in for the first time.
 *
 * It is used two ways wherever it is enabled: to sign somebody in, and to prove
 * that a signed-in member really owns the Discord account they want linked. Both
 * are the same authorization-code flow, so the only difference is an intent note
 * carried through the round trip.
 *
 * The whole thing is off unless an administrator turns it on, and it stays
 * unusable until the instance has a public URL — Discord has to be able to call
 * us back, so a `localhost` address cannot work.
 */

/** Where the member is headed when they come back from Discord. */
export type DiscordAuthIntent = 'login' | 'link';

/** The Discord account a completed flow proved the caller controls. */
export interface DiscordIdentity {
  id: string;
  /** The Discord username, for messages and logs. */
  username: string;
  /** The name they chose to show on Discord, if any. */
  displayName: string | null;
  /** Their Discord picture on Discord's CDN, or null when they have not set one. */
  avatarUrl: string | null;
}

export interface DiscordOAuthService {
  /** True when a flow can be run right now: configured, on, and reachable. */
  enabled(): boolean;
  /** The callback URL to register with Discord, or null without a public URL. */
  redirectUri(): string | null;
  /**
   * Builds the Discord authorize URL and remembers the flow it belongs to. The
   * returned `binding` must be handed to the starting browser (as a cookie) and
   * presented again at the callback, so a callback URL is useless anywhere else.
   * A link flow also records who started it.
   */
  authorizeUrl(
    intent: DiscordAuthIntent,
    options?: { inviteCode?: string | null; userId?: string | null },
  ): { url: string; binding: string };
  /**
   * Exchanges a callback's code for the Discord identity behind it. Refused
   * unless `binding` is the one issued to the browser that started the flow.
   */
  complete(
    code: string,
    state: string,
    binding: string | null,
  ): Promise<{
    intent: DiscordAuthIntent;
    identity: DiscordIdentity;
    inviteCode: string | null;
    /** For a link flow, the member who started it. */
    userId: string | null;
  }>;
  /** Fetches a Discord picture's bytes, for importing it as a Harmony avatar. */
  downloadAvatar(url: string): Promise<Buffer | null>;
}

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const USER_URL = 'https://discord.com/api/users/@me';
/** Identifies the instance when fetching a member's Discord picture. */
const AVATAR_USER_AGENT = 'Harmony/1.0 discord-avatar';
/** How long a started flow stays valid before its state is forgotten. */
export const STATE_TTL_MS = 10 * 60 * 1000;
/** A Discord call should not be able to hang a request indefinitely. */
const TIMEOUT_MS = 10_000;

interface ResolvedConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

async function exchangeCode(config: ResolvedConfig, code: string, verifier: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);

  if (!response || !response.ok) {
    throw new HttpError(502, 'discord_token_failed', 'Discord did not accept the sign-in. Please try again.');
  }
  const payload = (await response.json()) as { access_token?: unknown };
  if (typeof payload.access_token !== 'string') {
    throw new HttpError(502, 'discord_token_failed', 'Discord returned no access token.');
  }
  return payload.access_token;
}

async function fetchIdentity(accessToken: string): Promise<DiscordIdentity> {
  const response = await fetch(USER_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);

  if (!response || !response.ok) {
    throw new HttpError(502, 'discord_user_failed', 'Could not read your Discord account.');
  }
  const user = (await response.json()) as {
    id?: unknown;
    username?: unknown;
    global_name?: unknown;
    avatar?: unknown;
  };
  // A Discord snowflake is digits, the same shape the member link stores.
  if (typeof user.id !== 'string' || !/^\d{17,20}$/.test(user.id)) {
    throw new HttpError(502, 'discord_user_failed', 'Discord returned an unexpected account.');
  }
  // The avatar hash names the picture; a leading `a_` marks an animated one, which
  // Discord only serves as a gif. Discord's own CDN is public, so this is a plain
  // URL. A member with no picture returns no hash, and we keep their avatar empty
  // rather than importing Discord's generic default.
  const avatar = typeof user.avatar === 'string' && user.avatar.length > 0 ? user.avatar : null;
  return {
    id: user.id,
    username: typeof user.username === 'string' ? user.username : 'a Discord user',
    displayName: typeof user.global_name === 'string' && user.global_name.trim() ? user.global_name.trim() : null,
    avatarUrl:
      avatar === null
        ? null
        : `https://cdn.discordapp.com/avatars/${user.id}/${avatar}.${avatar.startsWith('a_') ? 'gif' : 'png'}?size=256`,
  };
}

export function createDiscordOAuthService(settings: SettingsService): DiscordOAuthService {
  /**
   * In-flight flows, keyed by their random state. Kept in memory rather than the
   * database: a flow lives for minutes, and losing them on a restart at worst
   * makes somebody press the button again.
   */
  const pending = new Map<
    string,
    {
      intent: DiscordAuthIntent;
      verifier: string;
      /** Hash of the browser binding, so the map never holds the cookie value itself. */
      bindingHash: Buffer;
      inviteCode: string | null;
      userId: string | null;
      expiresAt: number;
    }
  >();

  function hashBinding(binding: string): Buffer {
    return createHash('sha256').update(binding).digest();
  }

  function resolve(): ResolvedConfig | null {
    const auth = settings.getDiscordAuth();
    const redirectUri = settings.discordRedirectUri();
    if (!auth.enabled || !auth.clientId || !auth.clientSecret || !redirectUri) return null;
    return { clientId: auth.clientId, clientSecret: auth.clientSecret, redirectUri };
  }

  function sweep(): void {
    const now = Date.now();
    for (const [state, entry] of pending) {
      if (entry.expiresAt <= now) pending.delete(state);
    }
  }

  return {
    enabled() {
      return resolve() !== null;
    },

    redirectUri() {
      return settings.discordRedirectUri();
    },

    authorizeUrl(intent, options = {}) {
      const config = resolve();
      if (!config) throw new HttpError(404, 'discord_auth_disabled', 'Discord sign-in is not available.');

      sweep();
      // PKCE plus a random state: the state stops a forged callback, and the
      // verifier proves the token exchange is ours even if the code leaks. The
      // binding ties the flow to this browser: without it, someone could start a
      // flow, stop at the callback URL and get another person to open it.
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const binding = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      pending.set(state, {
        intent,
        verifier,
        bindingHash: hashBinding(binding),
        inviteCode: options.inviteCode ?? null,
        userId: options.userId ?? null,
        expiresAt: Date.now() + STATE_TTL_MS,
      });

      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: 'identify',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return { url: `${AUTHORIZE_URL}?${params.toString()}`, binding };
    },

    async complete(code, state, binding) {
      const config = resolve();
      if (!config) throw new HttpError(404, 'discord_auth_disabled', 'Discord sign-in is not available.');

      sweep();
      const entry = pending.get(state);
      // One-time use, whatever happens next.
      pending.delete(state);
      if (!entry || entry.expiresAt <= Date.now()) {
        throw new HttpError(400, 'discord_state', 'That sign-in attempt has expired. Please try again.');
      }
      // Checked before anything is sent to Discord: a callback opened in a
      // browser that did not start the flow goes nowhere.
      if (!binding || !timingSafeEqual(hashBinding(binding), entry.bindingHash)) {
        throw new HttpError(400, 'discord_state', 'That sign-in attempt was started somewhere else.');
      }

      const accessToken = await exchangeCode(config, code, entry.verifier);
      const identity = await fetchIdentity(accessToken);
      return { intent: entry.intent, identity, inviteCode: entry.inviteCode, userId: entry.userId };
    },

    async downloadAvatar(url) {
      const userAgent = settings.get().previewUserAgent ?? AVATAR_USER_AGENT;
      // The same guarded fetch the link previews use: public hosts only, image
      // types only, and a byte cap, since this reaches out to Discord for us.
      const image = await fetchPublicImage(url, userAgent);
      return image?.data ?? null;
    },
  };
}
