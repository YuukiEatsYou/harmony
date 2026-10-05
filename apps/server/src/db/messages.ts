import type { DatabaseSync } from 'node:sqlite';
import { isGifLinkUrl, isLinkedGifType, type EmbedPlayer, type LinkEmbed, type LinkedGif, type SearchHas } from '@harmony/shared';

/** YouTube video ids are 11 URL-safe characters; anything else is not offered. */
function parsePlayer(value: unknown): EmbedPlayer | null {
  if (!value || typeof value !== 'object') return null;
  const player = value as { provider?: unknown; id?: unknown };
  if (player.provider !== 'youtube') return null;
  if (typeof player.id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(player.id)) return null;
  return { provider: 'youtube', id: player.id };
}

/**
 * A linked gif, kept only when the embed's address is itself on the gif host
 * allowlist and the type is a gif-like one, so nothing stored can make a client
 * load from anywhere else.
 */
function parseGif(value: unknown, url: string): LinkedGif | null {
  if (!value || typeof value !== 'object' || !isGifLinkUrl(url)) return null;
  const gif = value as { contentType?: unknown; width?: unknown; height?: unknown };
  if (typeof gif.contentType !== 'string' || !isLinkedGifType(gif.contentType)) return null;
  const size = (n: unknown): number | null =>
    typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 20000 ? n : null;
  return { contentType: gif.contentType.toLowerCase(), width: size(gif.width), height: size(gif.height) };
}

export interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string | null;
  content: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reply_to_id: string | null;
  /** The unfurled link preview as JSON, or NULL. */
  embed: string | null;
  /** When the message was pinned, or NULL. See `db/pins.ts`. */
  pinned_at: string | null;
  /** Who pinned it, or NULL when unpinned or once that account is gone. */
  pinned_by: string | null;
  /** 1 once the embeds were removed by hand; the link resolver then skips the message. */
  embeds_hidden: number;
}

/** Reads the stored embed JSON back into a preview, ignoring anything malformed. */
export function parseMessageEmbed(raw: string | null): LinkEmbed | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LinkEmbed>;
    if (typeof value.url !== 'string' || value.url.length === 0) return null;
    const gif = parseGif(value.gif, value.url);
    return {
      url: value.url,
      title: typeof value.title === 'string' ? value.title : null,
      description: typeof value.description === 'string' ? value.description : null,
      siteName: typeof value.siteName === 'string' ? value.siteName : null,
      imageUrl: typeof value.imageUrl === 'string' ? value.imageUrl : null,
      player: parsePlayer(value.player),
      // Left off entirely for an ordinary preview, so the wire shape is unchanged.
      ...(gif ? { gif } : {}),
    };
  } catch {
    return null;
  }
}

export function insertMessage(
  sqlite: DatabaseSync,
  input: {
    id: string;
    channelId: string;
    authorId: string;
    content: string;
    createdAt: string;
    replyToId?: string | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO messages (id, channel_id, author_id, content, created_at, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.channelId, input.authorId, input.content, input.createdAt, input.replyToId ?? null);
}

export function findMessage(sqlite: DatabaseSync, id: string): MessageRow | null {
  return (sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined) ?? null;
}

export interface SearchOptions {
  /** The term to look for, as a literal substring. Omitted when filtering only. */
  query?: string | undefined;
  /** Channel ids the searcher may see; an empty list finds nothing. */
  channelIds: string[];
  authorId?: string | undefined;
  /** Authors, any of which matches. An empty list matches nothing; omitted means anyone. */
  authorIds?: string[] | undefined;
  /** Usernames the text must name (as @name), any of which matches. An empty list matches nothing. */
  mentionedUsernames?: string[] | undefined;
  /** Traits the message must all have. */
  has?: SearchHas[] | undefined;
  /** Sent at or after / before these ISO timestamps. */
  sentAfter?: string | undefined;
  sentBefore?: string | undefined;
  limit: number;
  before?: string | undefined;
  beforeId?: string | undefined;
}

/** Escapes the LIKE wildcards so searching for `100%` means a literal `100%`. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/**
 * The SQL for each has: trait. These are fixed strings with no caller input in
 * them. file is any attachment at all and image includes gifs, as on Discord.
 */
const HAS_CONDITIONS: Record<SearchHas, string> = {
  image: "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = messages.id AND a.content_type LIKE 'image/%')",
  video: "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = messages.id AND a.content_type LIKE 'video/%')",
  gif: "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = messages.id AND a.content_type = 'image/gif')",
  file: 'EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = messages.id)',
  link: "(content LIKE '%http://%' OR content LIKE '%https://%')",
  embed: 'embed IS NOT NULL',
  sticker: 'EXISTS (SELECT 1 FROM message_stickers ms WHERE ms.message_id = messages.id)',
  pin: 'pinned_at IS NOT NULL',
};

/** A character that cannot be part of a username, as a GLOB class (see USERNAME_PATTERN). */
const NOT_NAME = '[^a-z0-9._-]';

/**
 * GLOB patterns for `@name` as a whole mention, at the start or after a
 * non-name character and at the end or before one, over lowercased content.
 * Usernames hold none of GLOB's special characters, so they need no escaping.
 */
function mentionGlobs(username: string): string[] {
  const mention = `@${username.toLowerCase()}`;
  return [mention, `${mention}${NOT_NAME}*`, `*${NOT_NAME}${mention}`, `*${NOT_NAME}${mention}${NOT_NAME}*`];
}

/**
 * Case-insensitive substring search over message text, newest first. With no term
 * the filters alone decide what comes back, e.g. everything one member said.
 * Deleted messages are left out, and a caller must pass the channels the searcher
 * may see, so locked channels can never leak through the results. Paging uses the
 * same `created_at` + id cursor as the history reader, for the same reason: a
 * burst of messages can share a millisecond.
 */
export function searchMessages(sqlite: DatabaseSync, options: SearchOptions): MessageRow[] {
  const { query, channelIds, authorId, authorIds, mentionedUsernames, has, sentAfter, sentBefore, limit, before, beforeId } =
    options;
  if (channelIds.length === 0) return [];

  const conditions = ['deleted_at IS NULL'];
  const values: Array<string | number> = [];

  if (query !== undefined && query.length > 0) {
    conditions.push("content LIKE ? ESCAPE '\\'");
    values.push(likePattern(query));
  }

  conditions.push(`channel_id IN (${channelIds.map(() => '?').join(', ')})`);
  values.push(...channelIds);

  if (authorId !== undefined) {
    conditions.push('author_id = ?');
    values.push(authorId);
  }
  if (authorIds !== undefined) {
    if (authorIds.length === 0) return [];
    conditions.push(`author_id IN (${authorIds.map(() => '?').join(', ')})`);
    values.push(...authorIds);
  }
  if (mentionedUsernames !== undefined) {
    if (mentionedUsernames.length === 0) return [];
    // A mention is the literal text @name, standing alone the way the mention
    // parser reads it: @bob must not find @bobby, nor the bob in x@bob.
    const patterns = mentionedUsernames.flatMap(mentionGlobs);
    conditions.push(`(${patterns.map(() => 'lower(content) GLOB ?').join(' OR ')})`);
    values.push(...patterns);
  }
  for (const trait of new Set(has ?? [])) conditions.push(HAS_CONDITIONS[trait]);
  if (sentAfter !== undefined) {
    conditions.push('created_at >= ?');
    values.push(sentAfter);
  }
  if (sentBefore !== undefined) {
    conditions.push('created_at < ?');
    values.push(sentBefore);
  }
  if (before !== undefined && beforeId !== undefined) {
    conditions.push('(created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?)))');
    values.push(before, before, beforeId);
  } else if (before !== undefined) {
    conditions.push('created_at < ?');
    values.push(before);
  }

  values.push(limit);
  return sqlite
    .prepare(`SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...values) as unknown as MessageRow[];
}

/** When a member last posted in a channel, for slowmode. Deleted rows still count. */
export function lastMessageAt(sqlite: DatabaseSync, channelId: string, authorId: string): string | null {
  const row = sqlite
    .prepare(
      'SELECT created_at AS at FROM messages WHERE channel_id = ? AND author_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    )
    .get(channelId, authorId) as { at: string } | undefined;
  return row?.at ?? null;
}

/**
 * Returns the newest `limit` messages for a channel in ascending order.
 *
 * Paging backwards takes a cursor of the oldest message you have: its
 * `createdAt` plus its id. The id matters because `created_at` only has
 * millisecond precision — a burst of messages (a bridge history import, say) can
 * share a timestamp, and a timestamp-only cursor would skip the rest of that
 * millisecond. `rowid` ties them back to insertion order.
 */
export function listMessages(
  sqlite: DatabaseSync,
  channelId: string,
  options: { limit: number; before?: string; beforeId?: string },
): MessageRow[] {
  const { limit, before, beforeId } = options;

  const rows =
    before && beforeId
      ? sqlite
          .prepare(
            `SELECT * FROM messages
             WHERE channel_id = ? AND deleted_at IS NULL
               AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?)))
             ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
          .all(channelId, before, before, beforeId, limit)
      : before
        ? sqlite
            .prepare(
              `SELECT * FROM messages
               WHERE channel_id = ? AND deleted_at IS NULL AND created_at < ?
               ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            )
            .all(channelId, before, limit)
        : sqlite
            .prepare(
              `SELECT * FROM messages
               WHERE channel_id = ? AND deleted_at IS NULL
               ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            )
            .all(channelId, limit);

  return (rows as unknown as MessageRow[]).reverse();
}

export function updateMessageContent(sqlite: DatabaseSync, id: string, content: string, editedAt: string): void {
  // The old preview no longer matches the new text, so drop it here. The embed
  // service re-resolves the new content and broadcasts again when it finds a link.
  sqlite
    .prepare('UPDATE messages SET content = ?, edited_at = ?, embed = NULL WHERE id = ?')
    .run(content, editedAt, id);
}

/** Stores a message's unfurled preview JSON, or clears it when given null. */
export function setMessageEmbed(sqlite: DatabaseSync, id: string, embed: string | null): boolean {
  const result = sqlite.prepare('UPDATE messages SET embed = ? WHERE id = ?').run(embed, id);
  return Number(result.changes) > 0;
}

/** Marks a message's embeds as removed by hand, for good. */
export function setMessageEmbedsHidden(sqlite: DatabaseSync, id: string): boolean {
  const result = sqlite.prepare('UPDATE messages SET embeds_hidden = 1 WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}

export function softDeleteMessage(sqlite: DatabaseSync, id: string, deletedAt: string): void {
  sqlite.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run(deletedAt, id);
}

export function countMessages(sqlite: DatabaseSync): number {
  const row = sqlite.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number };
  return row.count;
}

/** When the newest message in a channel was sent, or null when it has none. */
export function newestMessageAt(sqlite: DatabaseSync, channelId: string): string | null {
  const row = sqlite
    .prepare('SELECT MAX(created_at) AS newest FROM messages WHERE channel_id = ?')
    .get(channelId) as { newest: string | null } | undefined;
  return row?.newest ?? null;
}

/**
 * The message ids retention must keep. A pin is an administrator saying "this
 * stays" and a save is a member saying the same, so both outlive the age rules
 * for exactly the reason a saved gif does. Shared by the message deletes here and
 * by the attachment rules in db/attachments.ts so the message, image, video and
 * emergency sweeps cannot drift apart. Every id in the set is non-null, which is
 * what makes the NOT IN checks against it safe.
 */
export const EXEMPT_MESSAGE_IDS_SQL = `SELECT id FROM messages
  WHERE pinned_at IS NOT NULL OR id IN (SELECT message_id FROM saved_messages)`;

/** Retention removes rows outright; attachments cascade via their foreign key. */
export function deleteMessagesOlderThan(sqlite: DatabaseSync, before: string): number {
  const result = sqlite
    .prepare(`DELETE FROM messages WHERE created_at < ? AND id NOT IN (${EXEMPT_MESSAGE_IDS_SQL})`)
    .run(before);
  return Number(result.changes);
}

export function deleteOldestMessages(sqlite: DatabaseSync, limit: number): number {
  const result = sqlite
    .prepare(
      `DELETE FROM messages WHERE id IN (
         SELECT id FROM messages
         WHERE id NOT IN (${EXEMPT_MESSAGE_IDS_SQL})
         ORDER BY created_at, rowid LIMIT ?
       )`,
    )
    .run(limit);
  return Number(result.changes);
}
