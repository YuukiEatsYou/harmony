import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  GatewayEvent,
  RESERVED_COMMAND_NAMES,
  hasPermission,
  permissionsFromString,
  type BotCommandListResponse,
  type BotCommandRegistration,
  type CommandInvokePayload,
  type RegisteredCommand,
  type RegisteredCommandListResponse,
} from '@harmony/shared';
import { canAccessChannel, channelAccessFor } from '../access/service.ts';
import { resolvePermissions } from '../auth/permissions.ts';
import type { AuthContext } from '../auth/service.ts';
import {
  findBotCommandById,
  listBotCommandRows,
  listCommandsForBot,
  replaceBotCommands,
  type BotCommandRow,
} from '../db/bot_commands.ts';
import { findUserById, type UserRow } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { GatewayHub } from '../realtime/hub.ts';

/** A resolved invocation: who to hand it to, and what to hand over. */
export interface CommandInvocation {
  botId: string;
  event: CommandInvokePayload;
}

export interface CommandService {
  /** Replaces the calling bot's command set and tells everyone it changed. */
  register(botId: string, commands: BotCommandRegistration[]): BotCommandListResponse;
  /** A bot's own commands, as it reads them back. */
  listForBot(botId: string): BotCommandListResponse;
  /** The commands this caller may invoke: it holds the permission, and so does the bot. */
  listForInvoker(auth: AuthContext): RegisteredCommandListResponse;
  /**
   * Validates an invocation and builds the event for the bot. Throws when the
   * command is unknown, either side lacks the permission, the bot is offline, or
   * the channel is not one the caller can see.
   */
  invoke(auth: AuthContext, channelId: string, commandId: string, args: string): CommandInvocation;
}

export function createCommandService(sqlite: DatabaseSync, hub: GatewayHub): CommandService {
  /** The bot a command belongs to, or null when the row is gone or is not a bot. */
  function botFor(botId: string): UserRow | null {
    const bot = findUserById(sqlite, botId);
    return bot && bot.account_type === 'bot' ? bot : null;
  }

  function toRegistration(row: BotCommandRow): BotCommandRegistration {
    return { name: row.name, description: row.description, requiredPermissions: row.required_permissions };
  }

  function listForBot(botId: string): BotCommandListResponse {
    return { commands: listCommandsForBot(sqlite, botId).map(toRegistration) };
  }

  return {
    register(botId, commands) {
      const seen = new Set<string>();
      for (const command of commands) {
        // A built-in helper's name is off limits, so a typed `/name` is never a
        // helper on one instance and a command on another.
        if (RESERVED_COMMAND_NAMES.includes(command.name)) {
          throw new HttpError(400, 'reserved_command_name', `/${command.name} is a built-in command.`);
        }
        if (seen.has(command.name)) {
          throw new HttpError(400, 'duplicate_command_name', `/${command.name} was registered twice.`);
        }
        seen.add(command.name);
      }
      replaceBotCommands(
        sqlite,
        botId,
        commands.map((command, index) => ({
          id: randomUUID(),
          name: command.name,
          description: command.description,
          requiredPermissions: command.requiredPermissions,
          position: index,
        })),
      );
      // Every client's completion list is now stale; this is rare, so a broadcast
      // is cheaper than trying to track who cares.
      hub.dispatch(GatewayEvent.CommandsUpdate, {});
      return listForBot(botId);
    },

    listForBot,

    listForInvoker(auth) {
      const commands: RegisteredCommand[] = [];
      for (const row of listBotCommandRows(sqlite)) {
        const bot = botFor(row.bot_id);
        if (!bot) continue;
        const required = permissionsFromString(row.required_permissions);
        // Both gates: the caller must be allowed to invoke it, and the bot must be
        // able to carry it out. The bot's own token still bounds what it can do.
        if (!hasPermission(auth.permissions, required)) continue;
        if (!hasPermission(resolvePermissions(sqlite, bot), required)) continue;
        commands.push({
          id: row.id,
          name: row.name,
          description: row.description,
          requiredPermissions: row.required_permissions,
          bot: {
            id: bot.id,
            username: bot.username,
            displayName: bot.display_name,
            avatarHash: bot.avatar_hash,
          },
        });
      }
      return { commands };
    },

    invoke(auth, channelId, commandId, args) {
      const row = findBotCommandById(sqlite, commandId);
      const bot = row ? botFor(row.bot_id) : null;
      if (!row || !bot) throw new HttpError(404, 'command_not_found', 'That command does not exist.');

      const required = permissionsFromString(row.required_permissions);
      if (!hasPermission(auth.permissions, required)) {
        throw new HttpError(403, 'forbidden', 'You do not have permission to use that command.');
      }
      if (!hasPermission(resolvePermissions(sqlite, bot), required)) {
        throw new HttpError(403, 'forbidden', 'That bot can no longer run this command.');
      }
      if (!hub.onlineUserIds().has(bot.id)) {
        throw new HttpError(409, 'bot_offline', 'That bot is offline right now. Try again in a moment.');
      }
      if (!canAccessChannel(sqlite, channelAccessFor(sqlite, auth.user.id), channelId)) {
        throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');
      }

      return {
        botId: bot.id,
        event: {
          interactionId: randomUUID(),
          commandId: row.id,
          name: row.name,
          args,
          channelId,
          userId: auth.user.id,
          username: auth.user.username,
        },
      };
    },
  };
}
