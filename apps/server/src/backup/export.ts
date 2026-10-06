import type { DatabaseSync } from 'node:sqlite';
import type { ChannelExport, ChannelExportAuthor, ChannelExportMessage } from '@harmony/shared';
import { listAttachmentsForMessages } from '../db/attachments.ts';
import type { ChannelRow } from '../db/channels.ts';
import { listMessagesForExport } from '../db/export.ts';
import { findMessage } from '../db/messages.ts';
import { listReactionsForMessages } from '../db/reactions.ts';
import { listStickersForMessages } from '../db/stickers.ts';
import { findUserById } from '../db/users.ts';

/**
 * Channel exports, as JSON for other tools and as a standalone HTML page for
 * people. Both are produced as a sequence of strings, a page of history at a
 * time, so a channel with years of messages never sits in memory whole.
 */

/** Messages read from the database per query. */
const PAGE_SIZE = 500;

export interface ChannelExportContext {
  serverName: string;
  /**
   * Origin attachment links fall back to, e.g. `https://chat.example.com`.
   * Callers often derive it from the request's protocol and host, which a client
   * can spoof behind a proxy (`X-Forwarded-Host`), so `publicBaseUrl` wins when
   * the instance has one.
   */
  origin: string;
  /**
   * Admin-configured, publicly reachable base URL for this instance, or null
   * when it has none. See `SettingsService.getBridge().publicBaseUrl`.
   */
  publicBaseUrl?: string | null;
  exportedAt: Date;
}

/**
 * The base attachment links are built on: the instance's configured public URL
 * when it has one, otherwise the request-derived origin. The public URL is what
 * keeps a spoofed request host from being baked into an exported file's links.
 */
function attachmentBase(context: ChannelExportContext): string {
  return (context.publicBaseUrl ?? context.origin).replace(/\/+$/, '');
}

/**
 * Every message in the channel, oldest first, with names and files resolved.
 * Authors are cached for the whole walk: a channel has far fewer authors than
 * messages, and most pages repeat the same handful.
 */
function* exportMessages(
  sqlite: DatabaseSync,
  channelId: string,
  baseUrl: string,
): Generator<ChannelExportMessage> {
  const authors = new Map<string, ChannelExportAuthor | null>();
  function author(id: string | null): ChannelExportAuthor | null {
    if (!id) return null;
    if (!authors.has(id)) {
      const row = findUserById(sqlite, id);
      authors.set(
        id,
        row
          ? {
              id: row.id,
              username: row.username,
              displayName: row.display_name,
              accountType: row.account_type as ChannelExportAuthor['accountType'],
            }
          : null,
      );
    }
    return authors.get(id) ?? null;
  }

  let after: { createdAt: string; row: number } | undefined;
  for (;;) {
    const rows = listMessagesForExport(sqlite, channelId, { limit: PAGE_SIZE, after });
    if (rows.length === 0) return;

    const ids = rows.map((row) => row.id);
    const attachments = listAttachmentsForMessages(sqlite, ids);
    // The viewer only decides the `me` flag, which an export has no use for.
    const reactions = listReactionsForMessages(sqlite, ids, '');
    const stickers = listStickersForMessages(sqlite, ids);

    for (const row of rows) {
      const parent = row.reply_to_id ? findMessage(sqlite, row.reply_to_id) : null;
      const parentAuthor = parent ? author(parent.author_id) : null;
      yield {
        id: row.id,
        author: author(row.author_id),
        content: row.content,
        createdAt: row.created_at,
        editedAt: row.edited_at,
        replyTo: parent
          ? {
              id: parent.id,
              authorName: parentAuthor ? (parentAuthor.displayName ?? parentAuthor.username) : null,
              deleted: parent.deleted_at != null,
            }
          : null,
        attachments: (attachments.get(row.id) ?? []).map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.size,
          url: `${baseUrl}/api/v1/attachments/${attachment.id}`,
          sourceUrl: attachment.sourceUrl,
        })),
        stickers: (stickers.get(row.id) ?? []).map((sticker) => ({ id: sticker.id, name: sticker.name })),
        reactions: (reactions.get(row.id) ?? []).map((reaction) => ({
          emoji: reaction.emoji,
          emojiId: reaction.emojiId,
          count: reaction.count,
        })),
      };
    }

    const last = rows[rows.length - 1]!;
    after = { createdAt: last.created_at, row: last.row };
    if (rows.length < PAGE_SIZE) return;
  }
}

/**
 * The JSON export. The envelope is written around the message list by hand so
 * the list can stream; one message per line keeps a large file greppable.
 */
export function* channelExportJson(
  sqlite: DatabaseSync,
  channel: ChannelRow,
  context: ChannelExportContext,
): Generator<string> {
  const envelope: Omit<ChannelExport, 'messages'> = {
    format: 1,
    exportedAt: context.exportedAt.toISOString(),
    serverName: context.serverName,
    channel: { id: channel.id, name: channel.name, topic: channel.topic },
  };
  const head = JSON.stringify(envelope);
  yield `${head.slice(0, -1)},"messages":[`;
  let first = true;
  for (const message of exportMessages(sqlite, channel.id, attachmentBase(context))) {
    yield `${first ? '' : ','}\n${JSON.stringify(message)}`;
    first = false;
  }
  yield '\n]}\n';
}

/** Escapes text for HTML element content and quoted attribute values alike. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Only web links become clickable; anything else in a stored URL stays text. */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : null;
}

function formatTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Kept plain and self-contained: the file is opened from disk, long after the
 * server's own stylesheet is out of reach, and may be read on any device.
 */
const HTML_STYLE = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1d1f23; --muted: #6a6f78; --line: #e3e5e8; --accent: #4f5bd5; }
@media (prefers-color-scheme: dark) { :root { --bg: #1e1f22; --fg: #e3e5e8; --muted: #9a9ea6; --line: #33353a; --accent: #8c95f2; } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 860px; padding: 24px 16px 48px; background: var(--bg); color: var(--fg);
  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header.channel { border-bottom: 1px solid var(--line); margin-bottom: 16px; padding-bottom: 12px; }
header.channel h1 { font-size: 22px; margin: 0 0 4px; }
header.channel p { margin: 2px 0; color: var(--muted); }
h2.day { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em;
  margin: 20px 0 8px; padding-top: 8px; border-top: 1px solid var(--line); }
article { padding: 6px 0; }
article .meta { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
.author { font-weight: 600; }
.username, time, .edited, .reply, .empty, .size { color: var(--muted); font-size: 13px; }
.bot { font-size: 11px; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; color: var(--muted); }
.reply { margin: 0 0 2px; }
.content { white-space: pre-wrap; overflow-wrap: anywhere; }
ul.files { margin: 4px 0 0; padding-left: 18px; }
.reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.reactions span { border: 1px solid var(--line); border-radius: 8px; padding: 0 6px; font-size: 13px; }
a { color: var(--accent); }
`;

/**
 * The HTML export: one page, styles inline, and no script anywhere. Every piece
 * of member-written text goes through `escapeHtml`, so a message that contains
 * markup shows that markup as text. The page also carries a policy forbidding
 * scripts and remote loads, as a second line of defence when it is opened from
 * disk where no server header applies.
 */
export function* channelExportHtml(
  sqlite: DatabaseSync,
  channel: ChannelRow,
  context: ChannelExportContext,
): Generator<string> {
  const title = `#${channel.name} — ${context.serverName}`;
  yield `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${HTML_STYLE}</style>
</head>
<body>
<header class="channel">
<h1>#${escapeHtml(channel.name)}</h1>
<p>${escapeHtml(context.serverName)} · exported ${escapeHtml(formatTime(context.exportedAt.toISOString()))}</p>
${channel.topic ? `<p>${escapeHtml(channel.topic)}</p>\n` : ''}</header>
<main>
`;

  let day: string | null = null;
  let count = 0;
  for (const message of exportMessages(sqlite, channel.id, attachmentBase(context))) {
    count++;
    const parts: string[] = [];

    const messageDay = message.createdAt.slice(0, 10);
    if (messageDay !== day) {
      day = messageDay;
      parts.push(`<h2 class="day">${escapeHtml(messageDay)}</h2>`);
    }

    const name = message.author ? (message.author.displayName ?? message.author.username) : 'Deleted account';
    parts.push(`<article id="m-${escapeHtml(message.id)}">`);
    if (message.replyTo) {
      const target = message.replyTo.deleted
        ? 'a deleted message'
        : `<a href="#m-${escapeHtml(message.replyTo.id)}">${escapeHtml(message.replyTo.authorName ?? 'a deleted account')}</a>`;
      parts.push(`<p class="reply">↪ replying to ${target}</p>`);
    }
    parts.push(
      `<div class="meta"><span class="author">${escapeHtml(name)}</span>` +
        (message.author ? `<span class="username">@${escapeHtml(message.author.username)}</span>` : '') +
        (message.author?.accountType === 'bot'
          ? '<span class="bot">Bot</span>'
          : message.author?.accountType === 'ghost'
            ? '<span class="bot">Discord</span>'
            : '') +
        `<time datetime="${escapeHtml(message.createdAt)}">${escapeHtml(formatTime(message.createdAt))}</time>` +
        (message.editedAt
          ? `<span class="edited" title="${escapeHtml(message.editedAt)}">(edited ${escapeHtml(formatTime(message.editedAt))})</span>`
          : '') +
        '</div>',
    );
    if (message.content) parts.push(`<div class="content">${escapeHtml(message.content)}</div>`);

    const files = [
      ...message.attachments.map((attachment) => {
        const href = safeHref(attachment.url);
        const filename = escapeHtml(attachment.filename);
        const size = `<span class="size">${escapeHtml(formatSize(attachment.size))}</span>`;
        return `<li>${href ? `<a href="${href}">${filename}</a>` : filename} ${size}</li>`;
      }),
      ...message.stickers.map((sticker) => `<li>Sticker: ${escapeHtml(sticker.name)}</li>`),
    ];
    if (files.length > 0) parts.push(`<ul class="files">${files.join('')}</ul>`);

    if (message.reactions.length > 0) {
      const chips = message.reactions.map(
        (reaction) => `<span>${escapeHtml(reaction.emoji)} ${reaction.count}</span>`,
      );
      parts.push(`<div class="reactions">${chips.join('')}</div>`);
    }
    parts.push('</article>\n');
    yield parts.join('');
  }

  if (count === 0) yield '<p class="empty">This channel has no messages.</p>\n';
  yield '</main>\n</body>\n</html>\n';
}
