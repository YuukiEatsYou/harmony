/**
 * The hosts a gif may be linked to instead of stored, for the "link to the
 * hosted service" gif storage mode.
 *
 * This list is deliberately short and strict. It is what the server checks
 * before it will record a linked gif, what the client checks before it will
 * point an <img> or <video> at one, and what the Content-Security-Policy opens
 * `img-src` and `media-src` to while the mode is on. Nothing else is ever
 * hotlinked: not a gif from any other site, not a Discord attachment (those
 * addresses are signed and expire, so they are always fetched and kept).
 *
 * Matching is on the parsed host, never on a substring: https only, the default
 * port, no credentials, and either an exact host or a true subdomain of a listed
 * suffix, so `klipy.com.evil.test` and `evilklipy.com` do not match.
 */

/** The parts of a parsed URL this module reads; the package compiles without DOM or Node types. */
interface UrlParts {
  protocol: string;
  port: string;
  username: string;
  password: string;
  hostname: string;
}
declare const URL: new (value: string) => UrlParts;

/** How an instance keeps a gif that comes from a gif service or a gif link. */
export type GifStorageMode = 'store' | 'link';

export const GIF_STORAGE_MODES: readonly GifStorageMode[] = ['store', 'link'];

/** Hosts matched exactly. */
export const GIF_LINK_EXACT_HOSTS: readonly string[] = [
  // Tenor's API shuts down, but its media host keeps serving existing addresses.
  'media.tenor.com',
  'media1.tenor.com',
  // Giphy's media hosts.
  'media.giphy.com',
  'i.giphy.com',
  'media0.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
];

/** Domains whose subdomains match (the bare domain itself, a web page, does not). */
export const GIF_LINK_SUFFIX_HOSTS: readonly string[] = ['klipy.com'];

/**
 * What a linked gif may be served as. Gif services hand out the same animation
 * as a GIF, an animated WebP and a looping MP4 or WebM, and all four are fine.
 */
export const LINKED_GIF_TYPES: readonly string[] = ['image/gif', 'image/webp', 'video/mp4', 'video/webm'];

/** A gif the message points at rather than stores. */
export interface LinkedGif {
  /** How the remote file is served, as the server saw it when the link was made. */
  contentType: string;
  /** Pixel size when known; gif services do not tell the server, so usually null. */
  width: number | null;
  height: number | null;
}

/** Whether a URL is one the instance may hotlink a gif from. */
export function isGifLinkHost(url: UrlParts): boolean {
  if (url.protocol !== 'https:') return false;
  if (url.port !== '' || url.username !== '' || url.password !== '') return false;

  const host = url.hostname.toLowerCase();
  if (GIF_LINK_EXACT_HOSTS.includes(host)) return true;
  return GIF_LINK_SUFFIX_HOSTS.some((suffix) => host.endsWith(`.${suffix}`));
}

/** `isGifLinkHost` for a string, which is not a URL at all if it does not parse. */
export function isGifLinkUrl(value: string): boolean {
  try {
    return isGifLinkHost(new URL(value));
  } catch {
    return false;
  }
}

/** Whether a content type is one a linked gif may have. */
export function isLinkedGifType(contentType: string): boolean {
  return LINKED_GIF_TYPES.includes(contentType.toLowerCase());
}

/** The Content-Security-Policy sources that let a page load from these hosts. */
export function gifLinkCspSources(): string[] {
  return [
    ...GIF_LINK_EXACT_HOSTS.map((host) => `https://${host}`),
    ...GIF_LINK_SUFFIX_HOSTS.map((suffix) => `https://*.${suffix}`),
  ];
}
