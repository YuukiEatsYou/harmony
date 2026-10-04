import type { DatabaseSync } from 'node:sqlite';
import type { Emoji } from '@harmony/shared';

export interface EmojiRow {
  id: string;
  name: string;
  hash: string;
  content_type: string;
  animated: number;
  created_by: string | null;
  created_at: string;
  /** The Discord emoji this was learned from, or null for a native one. */
  discord_id: string | null;
  /** When a learned emoji was last seen in a bridged message; null otherwise. */
  used_at: string | null;
}

export function toEmoji(row: EmojiRow): Emoji {
  return {
    id: row.id,
    name: row.name,
    hash: row.hash,
    animated: row.animated === 1,
    external: row.discord_id !== null,
  };
}

export function listEmojis(sqlite: DatabaseSync): EmojiRow[] {
  return sqlite.prepare('SELECT * FROM emojis ORDER BY name').all() as unknown as EmojiRow[];
}

export function findEmoji(sqlite: DatabaseSync, id: string): EmojiRow | null {
  return (sqlite.prepare('SELECT * FROM emojis WHERE id = ?').get(id) as EmojiRow | undefined) ?? null;
}

export function findEmojiByName(sqlite: DatabaseSync, name: string): EmojiRow | null {
  return (sqlite.prepare('SELECT * FROM emojis WHERE name = ?').get(name) as EmojiRow | undefined) ?? null;
}

/** The emoji learned from a Discord emoji id, or null when it is not here yet. */
export function findEmojiByDiscordId(sqlite: DatabaseSync, discordId: string): EmojiRow | null {
  return (
    (sqlite.prepare('SELECT * FROM emojis WHERE discord_id = ?').get(discordId) as EmojiRow | undefined) ?? null
  );
}

export function insertEmoji(
  sqlite: DatabaseSync,
  input: {
    id: string;
    name: string;
    hash: string;
    contentType: string;
    animated: boolean;
    createdBy: string | null;
    createdAt: string;
    /** Set only for an emoji learned from Discord. */
    discordId?: string | null;
    /** When a learned emoji was last seen; only meaningful alongside `discordId`. */
    usedAt?: string | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO emojis (id, name, hash, content_type, animated, created_by, created_at, discord_id, used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.name,
      input.hash,
      input.contentType,
      input.animated ? 1 : 0,
      input.createdBy,
      input.createdAt,
      input.discordId ?? null,
      input.usedAt ?? (input.discordId ? input.createdAt : null),
    );
}

/** Moves a learned emoji forward, so seeing it again counts as using it. */
export function touchEmojiUsed(sqlite: DatabaseSync, id: string): void {
  sqlite.prepare('UPDATE emojis SET used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

/**
 * Learned emoji not seen since `before`. Only rows with a Discord id are ever
 * removed, so the instance's own emoji stay whatever the rule says. Returns the
 * ids it removed, so the caller can tell connected clients each one is gone.
 */
export function deleteExternalEmojisUnusedBefore(sqlite: DatabaseSync, before: string): string[] {
  const rows = sqlite
    .prepare('DELETE FROM emojis WHERE discord_id IS NOT NULL AND COALESCE(used_at, created_at) < ? RETURNING id')
    .all(before) as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function deleteEmoji(sqlite: DatabaseSync, id: string): void {
  sqlite.prepare('DELETE FROM emojis WHERE id = ?').run(id);
}
