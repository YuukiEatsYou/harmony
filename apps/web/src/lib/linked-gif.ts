/**
 * Where a message's linked gif is drawn from.
 *
 * A message sent while the instance linked gifs carries only the remote address.
 * What the viewer should load depends on the instance's current mode:
 *
 * - link: the remote file, as before. If it fails to load (the service dropped
 *   it) the server's own copy is tried, which exists whenever this server ever
 *   copied it;
 * - store: the server's copy, which the server fetches once on first request. A
 *   clip (mp4 or webm) cannot be copied, so it is not drawn at all and the
 *   message shows its link.
 *
 * Whichever source fails last, the viewer ends up with the plain link.
 */

export interface LinkedGifSources {
  /** Tried first, or null when nothing can be drawn. */
  primary: string | null;
  /** Tried when the first fails to load. */
  fallback: string | null;
}

/** The address a copy held by this server is served from. */
export function gifCopyUrl(url: string): string {
  return `/api/v1/gifs/copy?url=${encodeURIComponent(url)}`;
}

export function linkedGifSources(
  mode: 'store' | 'link' | undefined,
  url: string,
  contentType: string,
): LinkedGifSources {
  const clip = contentType.toLowerCase().startsWith('video/');
  if (mode === 'link') return { primary: url, fallback: clip ? null : gifCopyUrl(url) };
  if (mode === 'store') return { primary: clip ? null : gifCopyUrl(url), fallback: null };
  return { primary: null, fallback: null };
}
