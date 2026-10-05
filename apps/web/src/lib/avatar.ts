import type { User } from '@harmony/shared';

/**
 * URL of a user's profile picture, or null when they have none. The hash is
 * part of the URL so a changed picture is a different URL and can never be
 * served from the immutable cache.
 */
export function avatarUrl(user: User | null | undefined): string | null {
  if (!user?.avatarHash) return null;
  return `/api/v1/users/${user.id}/avatar?v=${user.avatarHash}`;
}

/** URL of a user's banner, or null when they have none. Same cache rule as avatars. */
export function bannerUrl(userId: string, hash: string | null): string | null {
  return hash ? `/api/v1/users/${userId}/banner?v=${hash}` : null;
}

/** The letter to show when a user has no profile picture. */
export function initial(user: User | null | undefined): string {
  return (user?.displayName ?? user?.username ?? '?').charAt(0).toUpperCase();
}
