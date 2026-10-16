import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply } from 'fastify';
import type { Config } from '../config.ts';

function sessionCookieOptions(config: Config): CookieSerializeOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.sessionTtlDays * 86_400,
  };
}

export function setSessionCookie(reply: FastifyReply, config: Config, token: string): void {
  reply.setCookie(config.cookieName, token, sessionCookieOptions(config));
}

/**
 * Ties a Discord sign-in flow to the browser that started it. Only the Discord
 * routes ever see it, and it lives no longer than the flow does.
 */
const DISCORD_FLOW_PATH = '/api/v1/auth/discord';

export function discordFlowCookieName(config: Config): string {
  return `${config.cookieName}_discord`;
}

export function setDiscordFlowCookie(reply: FastifyReply, config: Config, value: string, maxAgeSeconds: number): void {
  reply.setCookie(discordFlowCookieName(config), value, {
    path: DISCORD_FLOW_PATH,
    httpOnly: true,
    // Lax still rides along on Discord's top-level redirect back to us.
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: maxAgeSeconds,
  });
}

export function clearDiscordFlowCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(discordFlowCookieName(config), { path: DISCORD_FLOW_PATH });
}

/**
 * A verified Discord identity parked until the browser supplies the invite code.
 * Mirrors the flow cookie: HttpOnly, scoped to the Discord routes, and never
 * exposed to script or a URL. The record itself lives in the OAuth service; this
 * carries only the opaque token that names it.
 */
export function discordResumeCookieName(config: Config): string {
  return `${config.cookieName}_discord_resume`;
}

export function setDiscordResumeCookie(reply: FastifyReply, config: Config, value: string, maxAgeSeconds: number): void {
  reply.setCookie(discordResumeCookieName(config), value, {
    path: DISCORD_FLOW_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: maxAgeSeconds,
  });
}

export function clearDiscordResumeCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(discordResumeCookieName(config), { path: DISCORD_FLOW_PATH });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(config.cookieName, { path: '/' });
}
