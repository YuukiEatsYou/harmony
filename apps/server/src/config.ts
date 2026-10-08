import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { GATEWAY_HEARTBEAT_MS, HARMONY_NAME, SCHEDULED_MIN_LEAD_MS } from '@harmony/shared';
import { DEFAULT_CSP } from './http/security.ts';

export interface Config {
  host: string;
  port: number;
  /** Display name of this instance; the initial `serverName` setting. */
  serverName: string;
  /** Directory holding the SQLite database and uploaded files. */
  dataDir: string;
  dbFile: string;
  /** Directory holding content-addressed uploaded blobs. */
  uploadDir: string;
  /** Directory holding the built web client, served by this process when present. */
  webDir: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** When true, registration demands a valid invite code (the first user is always exempt). */
  requireInvite: boolean;
  /** Lifetime of a login session, in days. */
  sessionTtlDays: number;
  cookieName: string;
  /** Set true when serving over HTTPS so the session cookie is marked `Secure`. */
  cookieSecure: boolean;
  /** Enable when running behind a reverse proxy so client IPs are read from `X-Forwarded-For`. */
  trustProxy: boolean;
  /** How often automatic retention pruning runs, in minutes. */
  pruneIntervalMinutes: number;
  /**
   * How often gateway clients must heartbeat, in milliseconds. Rarely worth
   * changing outside tests, which shorten it to see a silent socket closed.
   */
  gatewayHeartbeatMs: number;
  /** How often the scheduler looks for scheduled messages that have come due, in milliseconds. */
  scheduledTickMs: number;
  /** The shortest wait accepted for a scheduled message, in milliseconds. Tests shorten it. */
  scheduledMinLeadMs: number;
  /** `Content-Security-Policy` sent to browsers, or null to leave the header off. */
  csp: string | null;
  /**
   * The shell command that applies an update, run from the checkout when the owner
   * presses the button, or null when the button is switched off. It is per
   * deployment, like the systemd unit, which is why it is an env var rather than a
   * setting a normal hoster could break from the panel.
   */
  updateCommand: string | null;
  /**
   * The UDP port range the voice relay binds for WebRTC media. It is fixed so it
   * can be opened in the firewall: anything outside it is unreachable, so the
   * range has to be at least as large as the busiest room.
   */
  voicePortRange: [number, number];
  /**
   * The public IP to advertise for voice, or null to use the machine's own
   * addresses. Only needed when the host sits behind another NAT; a host whose
   * interface already carries its public IP (as on OVH) needs nothing here.
   */
  voicePublicIp: string | null;
}

// Load `.env` if present, without pulling in a dotenv dependency.
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) loadEnvFile(envPath);

// Upload limits are admin settings now. Warn rather than fail, so an old .env
// does not stop the server from starting.
if (process.env.HARMONY_MAX_UPLOAD_MB) {
  console.warn(
    '[harmony] HARMONY_MAX_UPLOAD_MB is no longer used; upload limits are set in the admin panel (Settings).',
  );
}

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

// Default to a `data/` directory at the repository root, so the database is
// the same no matter which directory the server is started from.
const defaultDataDir = resolve(import.meta.dirname, '..', '..', '..', 'data');
// The client build sits beside the server in the workspace.
const defaultWebDir = resolve(import.meta.dirname, '..', '..', 'web', 'dist');

/** `off` (or an empty value) disables the header; anything else is used verbatim. */
function readCsp(value: string | undefined): string | null {
  if (value === undefined) return DEFAULT_CSP;
  const trimmed = value.trim();
  return trimmed.length === 0 || /^(off|none)$/i.test(trimmed) ? null : trimmed;
}

/** An absent or blank command leaves the Update tab's apply button switched off. */
function readCommand(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function loadConfig(): Config {
  const dataDir = process.env.HARMONY_DATA_DIR
    ? resolve(process.cwd(), process.env.HARMONY_DATA_DIR)
    : defaultDataDir;
  return {
    host: process.env.HARMONY_HOST ?? '127.0.0.1',
    port: readNumber(process.env.HARMONY_PORT, 8787),
    serverName: process.env.HARMONY_SERVER_NAME ?? HARMONY_NAME,
    dataDir,
    dbFile: resolve(dataDir, 'harmony.db'),
    uploadDir: resolve(dataDir, 'uploads'),
    webDir: process.env.HARMONY_WEB_DIR
      ? resolve(process.cwd(), process.env.HARMONY_WEB_DIR)
      : defaultWebDir,
    logLevel: (process.env.HARMONY_LOG_LEVEL as Config['logLevel']) ?? 'info',
    requireInvite: readBoolean(process.env.HARMONY_REQUIRE_INVITE, false),
    sessionTtlDays: readNumber(process.env.HARMONY_SESSION_TTL_DAYS, 30),
    cookieName: process.env.HARMONY_COOKIE_NAME ?? 'harmony_session',
    cookieSecure: readBoolean(process.env.HARMONY_COOKIE_SECURE, false),
    trustProxy: readBoolean(process.env.HARMONY_TRUST_PROXY, false),
    pruneIntervalMinutes: readNumber(process.env.HARMONY_PRUNE_INTERVAL_MINUTES, 60),
    // A floor keeps a typo from turning every connection into a heartbeat storm.
    gatewayHeartbeatMs: Math.max(250, readNumber(process.env.HARMONY_GATEWAY_HEARTBEAT_MS, GATEWAY_HEARTBEAT_MS)),
    scheduledTickMs: Math.max(100, readNumber(process.env.HARMONY_SCHEDULED_TICK_MS, 10_000)),
    scheduledMinLeadMs: Math.max(0, readNumber(process.env.HARMONY_SCHEDULED_MIN_LEAD_MS, SCHEDULED_MIN_LEAD_MS)),
    csp: readCsp(process.env.HARMONY_CSP),
    updateCommand: readCommand(process.env.HARMONY_UPDATE_COMMAND),
    // The media relay binds this UDP range; see the Voice section of DEPLOYMENT.md.
    voicePortRange: [
      readNumber(process.env.HARMONY_VOICE_PORT_MIN, 40_000),
      readNumber(process.env.HARMONY_VOICE_PORT_MAX, 40_100),
    ],
    voicePublicIp: process.env.HARMONY_VOICE_PUBLIC_IP?.trim() || null,
  };
}
