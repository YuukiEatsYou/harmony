/**
 * Member profile customization: the extra fields a member sets about themselves
 * and the social platforms they can link.
 *
 * These live apart from the `User` type on purpose. `User` rides along on every
 * message, reaction and roster entry, so it stays lean; the full profile is
 * fetched on demand when somebody opens a member's profile.
 */

/** Longest "about me" text kept, in characters. */
export const BIO_MAX = 256;
/** Longest custom status line kept, in characters. */
export const STATUS_MAX = 128;
/** Longest stored value for one social link, in characters. */
export const SOCIAL_VALUE_MAX = 100;

export type SocialPlatform = 'twitter' | 'github' | 'twitch' | 'youtube' | 'steam' | 'website';

export interface SocialPlatformInfo {
  label: string;
  /**
   * `handle` is a bare username appended to a fixed base URL, so a stored value
   * can never point somewhere else. `url` is a full address the member types,
   * used as given, and only ever for the website field.
   */
  kind: 'handle' | 'url';
  /** The fixed base a `handle` is appended to. */
  base?: string;
  placeholder: string;
}

export const SOCIAL_PLATFORMS: Record<SocialPlatform, SocialPlatformInfo> = {
  twitter: { label: 'X', kind: 'handle', base: 'https://x.com/', placeholder: 'username' },
  github: { label: 'GitHub', kind: 'handle', base: 'https://github.com/', placeholder: 'username' },
  twitch: { label: 'Twitch', kind: 'handle', base: 'https://twitch.tv/', placeholder: 'username' },
  youtube: { label: 'YouTube', kind: 'handle', base: 'https://youtube.com/@', placeholder: 'handle' },
  steam: { label: 'Steam', kind: 'handle', base: 'https://steamcommunity.com/id/', placeholder: 'vanity name' },
  website: { label: 'Website', kind: 'url', placeholder: 'https://example.com' },
};

export const SOCIAL_PLATFORM_KEYS = Object.keys(SOCIAL_PLATFORMS) as SocialPlatform[];

/** Platform -> the value the member stored. Absent means not linked. */
export type SocialLinks = Partial<Record<SocialPlatform, string>>;

/** A handle is deliberately narrow: letters, digits, dot, underscore, hyphen. */
const HANDLE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Whether a value is usable for its platform, before it is stored. */
export function validSocialValue(platform: SocialPlatform, value: string): boolean {
  const info = SOCIAL_PLATFORMS[platform];
  return info.kind === 'url' ? httpUrl(value) !== null : HANDLE_PATTERN.test(value);
}

/**
 * The absolute link for a stored value, or null when there is none or it is not
 * usable. A handle is always joined to its fixed base, so the member can never
 * direct a link off-site; a website is accepted only as http(s).
 */
export function socialLink(platform: SocialPlatform, value: string | undefined): string | null {
  if (!value) return null;
  const info = SOCIAL_PLATFORMS[platform];
  if (info.kind === 'url') return httpUrl(value);
  return validSocialValue(platform, value) ? `${info.base}${value}` : null;
}

/** Only http(s), so a stored value can never smuggle another scheme into a link. */
function httpUrl(value: string): string | null {
  const trimmed = value.trim();
  return HTTP_URL_PATTERN.test(trimmed) ? trimmed : null;
}

/** Scheme and a non-empty remainder; no spaces. Deliberately strict. */
const HTTP_URL_PATTERN = /^https?:\/\/[^\s]+$/i;

/**
 * The profile fields a member sets about themselves. Fetched on demand, so it can
 * carry the larger text and links the lean `User` never does.
 */
export interface UserProfile {
  /** A short "about me", plain text. */
  bio: string;
  /** A one-line custom status, plain text. */
  status: string;
  /** Packed RGB accent the member chose, or null to use the picture's own color. */
  accentColor: number | null;
  /** Packed RGB averaged from the profile picture, or null when there is none. */
  avatarColor: number | null;
  /** The banner image's content hash, or null when the member has no banner. */
  bannerHash: string | null;
  socialLinks: SocialLinks;
}
