import type { DatabaseSync } from 'node:sqlite';
import { hashSessionToken } from '../auth/tokens.ts';

/**
 * One token per bot, stored only as a hash, so a database leak cannot be replayed
 * as a bot. `last_used_at` is what lets the owner see whether a token is still in
 * use before revoking it. A bot is deleted with its token (the foreign key
 * cascades).
 */
export interface BotTokenRow {
  bot_id: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
}

/** Issues a new token for a bot, replacing any previous one. */
export function setBotToken(sqlite: DatabaseSync, botId: string, token: string): void {
  sqlite
    .prepare(
      `INSERT INTO bot_tokens (bot_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, NULL)
       ON CONFLICT(bot_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, last_used_at = NULL`,
    )
    .run(botId, hashSessionToken(token), new Date().toISOString());
}

/** The bot a presented token belongs to, or null when it matches none. */
export function findBotByToken(sqlite: DatabaseSync, token: string): BotTokenRow | null {
  return (
    (sqlite.prepare('SELECT * FROM bot_tokens WHERE token_hash = ?').get(hashSessionToken(token)) as
      | BotTokenRow
      | undefined) ?? null
  );
}

/** Every bot's token row, keyed by bot id, for the list the owner reads. */
export function listBotTokens(sqlite: DatabaseSync): Map<string, BotTokenRow> {
  const rows = sqlite.prepare('SELECT * FROM bot_tokens').all() as unknown as BotTokenRow[];
  return new Map(rows.map((row) => [row.bot_id, row]));
}

/** Records that a bot's token was just used. */
export function touchBotToken(sqlite: DatabaseSync, botId: string): void {
  sqlite.prepare('UPDATE bot_tokens SET last_used_at = ? WHERE bot_id = ?').run(new Date().toISOString(), botId);
}
