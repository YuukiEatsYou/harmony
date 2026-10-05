import { isGifLinkHost, isLinkedGifType, type LinkedGif } from '@harmony/shared';
import { resolvesToPublicHost } from './guard.ts';
import { readCappedBody } from './media.ts';

const CHECK_TIMEOUT_MS = 6000;

export interface LinkedGifLimits {
  /** Largest picture worth linking (GIF or WebP), from the instance's upload limit. */
  maxImageBytes: number;
  /** Largest clip (MP4 or WebM), likewise. */
  maxVideoBytes: number;
  userAgent: string;
}

/** The parts of the outside world the check touches, replaceable in tests. */
export interface LinkedGifIO {
  fetch: typeof fetch;
  isPublicHost: (hostname: string) => Promise<boolean>;
}

const REAL_IO: LinkedGifIO = { fetch: (input, init) => fetch(input, init), isPublicHost: resolvesToPublicHost };

/** Signature shared by the real check and the stand-ins tests inject. */
export type VerifyLinkedGif = (url: string, limits: LinkedGifLimits) => Promise<LinkedGif | null>;

/**
 * Decides whether an address may be recorded as a linked gif, and what it is.
 *
 * Linking means every viewer's browser will load the address, so this is the one
 * gate between a member typing a URL and the instance pointing everyone at it.
 * It is strict on purpose:
 *
 * - the address must be https on an allowlisted gif host (`isGifLinkHost`), and
 *   nothing else is ever hotlinked, whatever the response says;
 * - the host must resolve only to public addresses, like every other outbound
 *   fetch here;
 * - redirects are not followed at all, so the file cannot turn out to live
 *   somewhere the allowlist never saw (a host that redirects is simply stored
 *   instead, by the ordinary path);
 * - the response must be a gif-like type (`LINKED_GIF_TYPES`) and no larger than
 *   the instance's own upload limit for that kind of file, by its declared length
 *   or, when it declares none, by reading up to the limit.
 *
 * Returns null for anything that fails, which the caller treats as "not linkable".
 */
export async function verifyLinkedGif(
  url: string,
  limits: LinkedGifLimits,
  io: LinkedGifIO = REAL_IO,
): Promise<LinkedGif | null> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (!isGifLinkHost(target)) return null;
  if (!(await io.isPublicHost(target.hostname))) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const response = await io.fetch(target, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': limits.userAgent, accept: 'image/gif,image/webp,video/mp4,video/webm' },
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!isLinkedGifType(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }

    const limit = contentType.startsWith('video/') ? limits.maxVideoBytes : limits.maxImageBytes;
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (Number.isFinite(declared) && declared > 0) {
      // The headers are all that is needed, and the length is the server's own
      // word for it; the body is not read.
      await response.body?.cancel().catch(() => undefined);
    } else if ((await readCappedBody(response, limit)) === null) {
      return null;
    }

    return { contentType, width: null, height: null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
