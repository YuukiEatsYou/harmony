import type { UserProfile } from '@harmony/shared';
import { api } from './api';

/**
 * Fetched member profiles, cached by id. A profile carries the text, colors and
 * links a member set about themselves, which is more than the lean User object
 * every message rides on, so it is only fetched when a profile is actually
 * shown and then kept until it changes.
 */
class ProfileState {
  byId = $state<Record<string, UserProfile>>({});
  #inFlight = new Map<string, Promise<UserProfile | null>>();

  get(id: string): UserProfile | null {
    return this.byId[id] ?? null;
  }

  /** Fetches and caches a profile. Concurrent asks for one id share a request. */
  async load(id: string): Promise<UserProfile | null> {
    const pending = this.#inFlight.get(id);
    if (pending) return pending;
    const job = api<UserProfile>(`/users/${id}/profile`)
      .then((profile) => {
        this.byId = { ...this.byId, [id]: profile };
        return profile;
      })
      .catch(() => null)
      .finally(() => this.#inFlight.delete(id));
    this.#inFlight.set(id, job);
    return job;
  }
}

export const profile = new ProfileState();

/** A packed 0xRRGGBB as a CSS `#rrggbb`, or null when there is no color. */
export function hexColor(value: number | null | undefined): string | null {
  return value == null ? null : `#${value.toString(16).padStart(6, '0')}`;
}

/** The color a profile leads with: a chosen accent, else the picture's, else a role color. */
export function profileAccent(entry: UserProfile | null, roleColor: number | null): number | null {
  return entry?.accentColor ?? entry?.avatarColor ?? roleColor;
}

/** A two-stop gradient built from an accent, or null when there is no color. */
export function accentGradient(value: number | null | undefined): string | null {
  const hex = hexColor(value);
  return hex ? `linear-gradient(135deg, ${hex}, ${shade(hex, -0.35)})` : null;
}

/** Multiplies a `#rrggbb` by a factor, clamped: negative darkens, positive lightens. */
function shade(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number): number => {
    const part = (value >> shift) & 0xff;
    const next = amount < 0 ? part * (1 + amount) : part + (255 - part) * amount;
    return Math.max(0, Math.min(255, Math.round(next)));
  };
  const r = channel(16);
  const g = channel(8);
  const b = channel(0);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
