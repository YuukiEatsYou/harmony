import type { DatabaseSync } from 'node:sqlite';
import {
  ALLOWED_IMAGE_TYPES,
  GatewayEvent,
  Permission,
  hasPermission,
  isGifLinkHost,
  listEmbeddableUrls,
  type ImageContentType,
  type LinkEmbed,
  type Message,
} from '@harmony/shared';
import type { AttachmentService, StoredImage } from '../attachments/service.ts';
import { deleteAttachment, listLinkedAttachments, type AttachmentRow } from '../db/attachments.ts';
import { canAccessChannel, channelAccessFor } from '../access/service.ts';
import type { AuthContext } from '../auth/service.ts';
import { findMessage, parseMessageEmbed, setMessageEmbed, setMessageEmbedsHidden } from '../db/messages.ts';
import { HttpError } from '../http/errors.ts';
import type { GatewayHub } from '../realtime/hub.ts';
import type { SettingsService } from '../settings/service.ts';
import type { GifSourceService } from '../gifs/sources.ts';
import { resolvesToPublicHost } from './guard.ts';
import { verifyLinkedGif, type VerifyLinkedGif } from './linked-gif.ts';
import { readCappedBody } from './media.ts';
import { parseEmbedMetadata } from './metadata.ts';
import { fetchGiphyMedia, fetchTweetEmbed, fetchYouTubeEmbed, isDiscordAttachment, isGifPage, isGiphyPage, tweetStatusId, youtubeVideoId } from './providers.ts';

/** Outbound fetch limits, kept tight because the target is user-supplied. */
const FETCH_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
/** Metadata lives in the head, so we read to the end of it and stop there. */
const MAX_HTML_BYTES = 1024 * 1024;
const USER_AGENT = 'Harmony/1.0 link-preview';
/** Remember at most this many results before starting over. */
const CACHE_LIMIT = 500;

export interface EmbedService {
  /**
   * Looks up a preview for a message's first embeddable link and stores it.
   * Best effort and asynchronous: a failure just leaves no preview.
   */
  resolve(messageId: string, content: string): void;
  /**
   * Removes every embed of a message (the card and any picture fetched from its
   * link) and keeps them from coming back, edits included. The author or anyone
   * with Manage Messages may do it. Returns the message as clients now see it.
   */
  suppress(auth: AuthContext, messageId: string): Promise<Message>;
}

export interface EmbedServiceDeps {
  sqlite: DatabaseSync;
  settings: SettingsService;
  hub: GatewayHub;
  attachments: AttachmentService;
  /** Renders a message for a broadcast, or null when it is gone. */
  renderMessage: (messageId: string) => Message | null;
  /**
   * Renews a Discord CDN link through the bridge, since Discord signs those and the
   * signature expires. Absent while the bridge is not available.
   */
  refreshDiscordAttachment?: (url: string) => Promise<string | null>;
  log?: (message: string, detail?: unknown) => void;
  /** Replaces the check made before a gif is linked; for tests, which cannot reach a gif host. */
  verifyLinkedGif?: VerifyLinkedGif;
  /**
   * Pairs each gif address with the copy held of it. Optional so a resolver can
   * be built without one (it then behaves as it did before the pairing existed).
   */
  sources?: GifSourceService;
}

/**
 * What a message's link turned out to be. A page becomes a card; a picture is
 * brought home and kept, because a link to somebody else's file is not something
 * this instance can rely on still being there tomorrow.
 */
type Outcome =
  | { kind: 'embed'; embed: LinkEmbed | null }
  /** Fetched just now. */
  | { kind: 'image'; url: string; contentType: string; data: Buffer }
  /** Already here, from somebody else posting the same link. */
  | { kind: 'copy'; url: string; from: AttachmentRow }
  /** Already here as the copy of a recorded gif address, which no message has used yet. */
  | { kind: 'source'; url: string; stored: StoredImage };

/** How a resolution ended, for the log. */
const OUTCOME_LABEL = {
  embed: 'resolved a link preview',
  image: 'kept a linked image',
  copy: 'reused an image already stored',
  source: 'reused the stored copy of a recorded gif',
} as const;

/**
 * Resolves one link a message contains, and puts the result on the message.
 *
 * A page becomes a small text card. A picture is fetched and kept as an
 * attachment of the message instead, because a link to somebody else's file is
 * not something this instance can rely on still being there: those addresses are
 * often signed and expire, and a preview cached from one goes dead within a day.
 * A copy of our own, on the other hand, keeps working, appears in the media
 * gallery, answers to retention, and needs no card around it.
 *
 * The target URL comes from message text, so every hop is treated as hostile:
 * only http and https are allowed, the host must resolve to a public address,
 * redirects are followed manually and re-checked, and the response is bounded by
 * a timeout, a content-type check and a byte cap.
 */
export function createEmbedService(deps: EmbedServiceDeps): EmbedService {
  /** Cards, by URL and user agent. Small, and the same link turns up again. */
  const cards = new Map<string, LinkEmbed | null>();
  const inFlight = new Map<string, Promise<Outcome>>();
  const log = deps.log ?? ((): void => {});

  /**
   * Cache and in-flight keys include the user agent, so changing it takes effect
   * at once instead of being shadowed by an earlier refusal.
   */
  function cacheKey(userAgent: string, url: string): string {
    return `${userAgent}\n${url}`;
  }

  function broadcast(messageId: string): void {
    const message = deps.renderMessage(messageId);
    if (!message) return;
    // Straight to the websocket clients: routing this through the message
    // service's edit listeners would let the bridge mistake it for a user edit.
    deps.hub.dispatch(GatewayEvent.MessageUpdate, message, { channelId: message.channelId });
  }

  /**
   * Resolves a link, remembering only what is worth remembering. A card is small
   * and the same link comes up again, so it is kept; an outcome carrying a
   * picture is not, since only the one message that asked for it ever wants it.
   */
  function resolveOutcome(url: string, userAgent: string): Promise<Outcome> {
    const key = cacheKey(userAgent, url);
    if (cards.has(key)) return Promise.resolve({ kind: 'embed', embed: cards.get(key) ?? null });

    const pending = inFlight.get(key);
    if (pending) return pending;

    const job = fetchOutcome(url, userAgent, deps.settings.get().maxImageBytes, deps.refreshDiscordAttachment, log)
      .catch((): Outcome => ({ kind: 'embed', embed: null }))
      .then((outcome) => {
        if (outcome.kind === 'embed') {
          if (cards.size >= CACHE_LIMIT) cards.clear();
          cards.set(key, outcome.embed);
        }
        return outcome;
      })
      .finally(() => inFlight.delete(key));

    inFlight.set(key, job);
    return job;
  }

  /**
   * Forgets any picture this message brought in from one of its own links.
   *
   * The blob itself is left alone: the pruner sweeps whatever nothing refers to,
   * exactly as it does for an upload somebody deleted.
   */
  function dropLinkedImages(messageId: string): void {
    for (const attachment of listLinkedAttachments(deps.sqlite, messageId)) {
      deleteAttachment(deps.sqlite, attachment.id);
    }
  }

  /** Puts a message's link into its settled state, and tells clients about it. */
  async function applyOutcome(messageId: string, outcome: Outcome): Promise<void> {
    dropLinkedImages(messageId);

    if (outcome.kind !== 'embed') {
      const uploaderId = deps.renderMessage(messageId)?.author?.id ?? null;
      if (outcome.kind === 'image') {
        const kept = await deps.attachments.storeLinkedImage({
          messageId,
          uploaderId,
          sourceUrl: outcome.url,
          filename: filenameFor(outcome.url, outcome.contentType),
          contentType: outcome.contentType,
          data: outcome.data,
        });
        if (kept) deps.sources?.recordCopy(outcome.url, kept);
      } else if (outcome.kind === 'copy') {
        deps.attachments.copyLinkedImage({
          messageId,
          uploaderId,
          sourceUrl: outcome.url,
          from: outcome.from,
        });
        deps.sources?.recordCopy(outcome.url, {
          hash: outcome.from.hash,
          contentType: outcome.from.content_type,
          size: outcome.from.size,
          width: outcome.from.width,
          height: outcome.from.height,
        });
      } else {
        deps.attachments.attachStoredCopy({
          messageId,
          uploaderId,
          sourceUrl: outcome.url,
          filename: filenameFor(outcome.url, outcome.stored.contentType),
          stored: outcome.stored,
        });
      }
      log(OUTCOME_LABEL[outcome.kind], { messageId, url: outcome.url });
    }

    // A card is only for pages. When the picture is on the message itself there
    // is nothing left for a card to say.
    const embed = outcome.kind === 'embed' ? outcome.embed : null;
    if (!setMessageEmbed(deps.sqlite, messageId, embed ? JSON.stringify(embed) : null)) return;
    broadcast(messageId);
  }

  /**
   * The resolution running for each message, so the next one waits its turn.
   *
   * A message can ask more than once in quick succession: Discord sends an
   * update for a bridged message each time it finishes unfurling the link, and
   * for a gif that is often while we are still downloading it. Run side by side,
   * each request found no picture yet, shared the one download and then stored
   * its own copy, so one gif arrived two or three times. One after another, a
   * later request sees what the earlier one kept and has nothing left to do.
   */
  const queues = new Map<string, Promise<void>>();

  async function resolveNow(messageId: string, content: string): Promise<void> {
    if (!deps.settings.get().embedsEnabled) return;
    // Somebody removed this message's embeds by hand; that choice outlives edits.
    if (findMessage(deps.sqlite, messageId)?.embeds_hidden) return;

    const url = listEmbeddableUrls(content)[0];
    const linked = listLinkedAttachments(deps.sqlite, messageId);

    // The message no longer points anywhere, so anything it brought in has to
    // go with it.
    if (!url) {
      if (linked.length > 0) await applyOutcome(messageId, { kind: 'embed', embed: null });
      return;
    }

    // The same link as last time: the picture is already here, and an edit
    // elsewhere in the text must not fetch it a second time.
    if (linked.some((attachment) => attachment.source_url === url)) return;

    // Nor must a second message. A community posts the same handful of gifs
    // over and over, and this instance is very likely already holding it.
    const reusable = deps.attachments.reusableForUrl(url);
    if (reusable) {
      await applyOutcome(messageId, { kind: 'copy', url, from: reusable });
      return;
    }

    // A gif on a known gif host is pointed at instead of copied, when the
    // instance is set to link. Anything that does not check out falls through
    // to the ordinary path, which stores it.
    if (deps.settings.get().gifStorage === 'link' && (await linkGif(messageId, url))) return;

    // A copy held under the address (made while the instance linked, or by an
    // archive run) is given to the message as it is: the same gif is never
    // fetched twice, and one whose source has since died still arrives.
    const held = deps.sources?.copyFor(url);
    if (held && held.content_type) {
      await applyOutcome(messageId, {
        kind: 'source',
        url,
        stored: {
          hash: held.hash,
          contentType: held.content_type,
          size: held.size ?? 0,
          width: held.width,
          height: held.height,
        },
      });
      return;
    }

    const userAgent = deps.settings.get().previewUserAgent ?? USER_AGENT;
    await applyOutcome(messageId, await resolveOutcome(url, userAgent));
  }

  /**
   * Records a gif link as the message's embed, without fetching the bytes into
   * storage. Only allowlisted gif hosts get this far (the check repeats the
   * allowlist), and only after `verifyLinkedGif` has looked at the response.
   * Returns whether the message now carries the linked gif.
   */
  async function linkGif(messageId: string, url: string): Promise<boolean> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return false;
    }
    if (!isGifLinkHost(target)) return false;

    // Already linked to this address, e.g. by the update Discord sends once it
    // has unfurled the same link.
    const current = parseMessageEmbed(findMessage(deps.sqlite, messageId)?.embed ?? null);
    if (current?.gif && current.url === url) return true;

    const settings = deps.settings.get();
    const gif = await (deps.verifyLinkedGif ?? verifyLinkedGif)(url, {
      maxImageBytes: settings.maxImageBytes,
      maxVideoBytes: settings.maxVideoBytes,
      userAgent: settings.previewUserAgent ?? USER_AGENT,
    });
    if (!gif) return false;

    // Only the pairing is recorded, with a copy if one is already held; the bytes
    // are copied later, on demand, if the instance ever stores instead.
    deps.sources?.record(url, gif.contentType);
    log('linked a gif instead of storing it', { messageId, url });
    await applyOutcome(messageId, {
      kind: 'embed',
      embed: { url, title: null, description: null, siteName: target.hostname, imageUrl: null, player: null, gif },
    });
    return true;
  }

  return {
    async suppress(auth, messageId) {
      const row = findMessage(deps.sqlite, messageId);
      if (!row || row.deleted_at) {
        throw new HttpError(404, 'message_not_found', 'That message does not exist.');
      }
      if (!canAccessChannel(deps.sqlite, channelAccessFor(deps.sqlite, auth.user.id), row.channel_id)) {
        throw new HttpError(403, 'channel_forbidden', 'You do not have access to that channel.');
      }
      if (row.author_id !== auth.user.id && !hasPermission(auth.permissions, Permission.ManageMessages)) {
        throw new HttpError(403, 'forbidden', 'Only the author or a moderator can remove embeds.');
      }

      // Flag first so no later resolution acts, then let one already running
      // finish so it cannot put the embed back after it is cleared.
      setMessageEmbedsHidden(deps.sqlite, messageId);
      await (queues.get(messageId) ?? Promise.resolve());
      dropLinkedImages(messageId);
      setMessageEmbed(deps.sqlite, messageId, null);

      const message = deps.renderMessage(messageId);
      if (!message) throw new HttpError(404, 'message_not_found', 'That message does not exist.');
      broadcast(messageId);
      return message;
    },

    resolve(messageId, content) {
      const run = (queues.get(messageId) ?? Promise.resolve())
        .then(() => resolveNow(messageId, content))
        .catch((error: unknown) => log('link preview failed', { error: String(error) }));
      queues.set(messageId, run);
      void run.finally(() => {
        // Only the last in line clears the slot; an earlier one finishing must
        // not let a newcomer skip past a resolution that is still queued.
        if (queues.get(messageId) === run) queues.delete(messageId);
      });
    },
  };
}

/** A name for a file fetched from a link, which usually has none of its own. */
function filenameFor(url: string, contentType: string): string {
  const extension = contentType.split('/')[1]?.split('+')[0] ?? 'img';
  const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  if (last.length > 0 && last.length <= 100) {
    try {
      const decoded = decodeURIComponent(last);
      // A provider page rewritten to a file address ends in a slug, not a name,
      // so the type it turned out to be is what gives a download its extension.
      return /\.[a-z0-9]{2,5}$/i.test(decoded) ? decoded : `${decoded}.${extension}`;
    } catch {
      // A broken escape sequence is still a better name than none at all.
      return last;
    }
  }
  return `linked-image.${extension}`;
}

async function fetchOutcome(
  url: string,
  userAgent: string,
  /** Largest picture worth keeping, from the instance's own upload limit. */
  maxImageBytes: number,
  /** Renews a Discord CDN link through the bridge, when there is one. */
  refreshDiscord: ((url: string) => Promise<string | null>) | undefined,
  log: (message: string, detail?: unknown) => void,
): Promise<Outcome> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { kind: 'embed', embed: null };
  }

  // Discord signs the address of every attachment and the signature expires, so a
  // link copied out of the client is usually dead on arrival. The bridge can renew
  // it through Discord's own refresh endpoint, which signs any attachment address
  // and needs neither the message nor access to the channel it came from. A link
  // that still carries an unexpired signature is used as it is.
  if (refreshDiscord && isDiscordAttachment(target) && needsFreshSignature(target)) {
    const signed = await refreshDiscord(target.toString());
    if (signed) target = new URL(signed);
  }

  // Providers with a small JSON endpoint of their own are asked directly: it is
  // quicker than their page and does not depend on their markup. All of them
  // fetch a fixed address, so the caller's URL cannot steer the request anywhere.
  const videoId = youtubeVideoId(target);
  if (videoId) {
    const embed = await fetchYouTubeEmbed(videoId, userAgent);
    if (embed) return { kind: 'embed', embed };
  }
  const statusId = tweetStatusId(target);
  if (statusId) {
    const embed = await fetchTweetEmbed(statusId, userAgent);
    if (embed) return { kind: 'embed', embed };
  }

  // Giphy's endpoint names the file behind one of its pages, which turns a gif
  // page into the same thing as a link straight at a gif: fetched and kept, with
  // no card. Only the target moves; the guarded loop below does the fetching, so
  // the address Giphy hands back is checked exactly like any other.
  if (isGiphyPage(target)) {
    const media = await fetchGiphyMedia(target.toString(), userAgent);
    if (media) target = new URL(media);
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return { kind: 'embed', embed: null };
    if (!(await resolvesToPublicHost(target.hostname))) return { kind: 'embed', embed: null };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(target, {
        redirect: 'manual',
        signal: controller.signal,
        // The picture is asked for first, and the page only as a fallback. Some
        // hosts serve both for one address and pick by what the client says it
        // wants, and a media address that answers with a web page is exactly how
        // a gif link ends up as a card pointing at a perfectly good gif. A
        // response that really is HTML is still read as a page below.
        headers: {
          'user-agent': userAgent,
          accept: 'image/*,text/html;q=0.9,application/xhtml+xml;q=0.8',
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return { kind: 'embed', embed: null };
        target = new URL(location, target);
        continue;
      }
      if (!response.ok) {
        // A 403 carrying cf-mitigated is a bot challenge: the page exists, but
        // the site refuses to serve it to this user agent.
        log('link preview refused', {
          url: target.toString(),
          status: response.status,
          challenged: response.headers.get('cf-mitigated') === 'challenge',
        });
        return { kind: 'embed', embed: null };
      }

      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      // A link that points straight at a picture is the picture, so it comes
      // home with us. One too large to keep is left as the card it used to be,
      // which is better than nothing at all.
      if (isStorableImage(contentType)) {
        const data = await readCappedBody(response, maxImageBytes);
        // `url` rather than `target`: what the message was given, not wherever
        // it was finally served from. That is what the message is checked
        // against when it is edited, and what the next copy of the same link is
        // matched to, so a page that is rewritten to a file address still knows
        // it has seen this link before.
        if (data) return { kind: 'image', url, contentType, data };
        log('linked image too large to keep', { url, limit: maxImageBytes });
        return { kind: 'embed', embed: bareImageCard(url, target.toString()) };
      }
      if (!/text\/html|application\/xhtml/i.test(contentType)) return { kind: 'embed', embed: null };

      const embed = parseEmbedMetadata(await readHead(response), target.toString());
      // A gif service's page is a wrapper around a single picture, which the page
      // names in its own preview metadata. That picture is what the link is about,
      // so it is fetched and kept just as a link straight at it would be, and the
      // card that would only repeat the page's own words is left off. The page is
      // kept as the message's link, so hiding it behind the picture still works.
      if (isGifPage(target) && embed.imageUrl) {
        const kept = await fetchImageBytes(embed.imageUrl, userAgent, maxImageBytes, log);
        if (kept) return { kind: 'image', url, contentType: kept.contentType, data: kept.data };
      }
      return { kind: 'embed', embed };
    } catch {
      return { kind: 'embed', embed: null };
    } finally {
      clearTimeout(timer);
    }
  }
  return { kind: 'embed', embed: null };
}

/** Image types this instance is willing to keep a copy of. */
function isStorableImage(contentType: string): boolean {
  return ALLOWED_IMAGE_TYPES.includes(contentType as ImageContentType);
}

/**
 * Whether a Discord attachment address has to be renewed before it is fetched.
 * Discord's links carry an expiry and a signature of their own; one with neither,
 * or whose expiry has passed, is dead on arrival and only the API can replace it.
 */
function needsFreshSignature(url: URL): boolean {
  const expires = url.searchParams.get('ex');
  const signature = url.searchParams.get('hm');
  if (!expires || !signature) return true;
  const expiresMs = Number.parseInt(expires, 16) * 1000;
  return !Number.isFinite(expiresMs) || expiresMs <= Date.now();
}

/**
 * Fetches a picture that somebody else's page named, through the same guard as
 * every other fetch here: http or https only, a public host at each hop, and a
 * timeout and byte cap on the response. Returns null when it is not a picture
 * this instance keeps, or is larger than it will hold, so the caller can fall
 * back to the card it already has rather than showing the message with nothing.
 */
async function fetchImageBytes(
  url: string,
  userAgent: string,
  maxImageBytes: number,
  log: (message: string, detail?: unknown) => void,
): Promise<{ contentType: string; data: Buffer } | null> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    if (!(await resolvesToPublicHost(target.hostname))) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(target, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': userAgent, accept: 'image/*' },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return null;
        target = new URL(location, target);
        continue;
      }
      if (!response.ok) return null;

      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (!isStorableImage(contentType)) return null;

      const data = await readCappedBody(response, maxImageBytes);
      if (!data) {
        log('linked image too large to keep', { url: target.toString(), limit: maxImageBytes });
        return null;
      }
      return { contentType, data };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * The old behavior for a picture we will not keep: a card whose image the
 * client fetches through the proxy. Only reached for files too large to store,
 * and the two addresses differ when a provider rewrote one into the other.
 */
function bareImageCard(url: string, imageUrl: string): LinkEmbed {
  return {
    url,
    title: null,
    description: null,
    siteName: new URL(url).hostname.replace(/^www\./, ''),
    imageUrl,
    player: null,
  };
}

/**
 * Reads a page only as far as the end of its head. Social metadata always sits
 * there, but on a heavy page it can be hundreds of kilobytes in — YouTube puts
 * its own past 700 KB — so a flat byte cap would miss it entirely.
 */
async function readHead(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return '';

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (text.includes('</head>') || total >= MAX_HTML_BYTES) {
        await reader.cancel();
        break;
      }
    }
    text += decoder.decode();
  } catch {
    // A truncated or aborted body is still worth parsing.
  }

  return text;
}
