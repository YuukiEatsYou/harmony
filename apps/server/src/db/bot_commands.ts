import type { DatabaseSync } from 'node:sqlite';

export interface BotCommandRow {
  id: string;
  bot_id: string;
  name: string;
  description: string;
  required_permissions: string;
  position: number;
}

export interface BotCommandInput {
  id: string;
  name: string;
  description: string;
  requiredPermissions: string;
  position: number;
}

/**
 * Replaces a bot's whole command set in one go, which is how a bot registers: it
 * sends what it now offers and the server makes that the truth. Callers validate
 * the set first, so the delete-and-insert cannot fail partway on a duplicate name.
 */
export function replaceBotCommands(sqlite: DatabaseSync, botId: string, commands: BotCommandInput[]): void {
  sqlite.prepare('DELETE FROM bot_commands WHERE bot_id = ?').run(botId);
  const insert = sqlite.prepare(
    `INSERT INTO bot_commands (id, bot_id, name, description, required_permissions, position)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const command of commands) {
    insert.run(command.id, botId, command.name, command.description, command.requiredPermissions, command.position);
  }
}

/** Every registered command, in a stable order. */
export function listBotCommandRows(sqlite: DatabaseSync): BotCommandRow[] {
  return sqlite
    .prepare('SELECT * FROM bot_commands ORDER BY name, bot_id')
    .all() as unknown as BotCommandRow[];
}

/** One bot's own commands, in the order it gave them. */
export function listCommandsForBot(sqlite: DatabaseSync, botId: string): BotCommandRow[] {
  return sqlite
    .prepare('SELECT * FROM bot_commands WHERE bot_id = ? ORDER BY position')
    .all(botId) as unknown as BotCommandRow[];
}

export function findBotCommandById(sqlite: DatabaseSync, id: string): BotCommandRow | null {
  return (sqlite.prepare('SELECT * FROM bot_commands WHERE id = ?').get(id) as BotCommandRow | undefined) ?? null;
}
