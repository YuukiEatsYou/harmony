/**
 * Slash commands a bot can offer. A bot registers its commands with the server;
 * a member who has the permission a command needs, and whose bot holds it too, can
 * then invoke it. The client resolves a typed `/name` to one of these and calls the
 * command endpoint instead of sending a message, so the invocation itself never
 * becomes chat.
 */

/**
 * Names the built-in, purely client-side text helpers already use (`/me`,
 * `/shrug`, ...). A bot cannot take one, so a typed name is never ambiguous
 * between a helper and a command.
 */
export const RESERVED_COMMAND_NAMES: readonly string[] = ['me', 'shrug', 'tableflip', 'unflip', 'lenny', 'spoiler'];

/** Bounds a registration is held to. */
export const BOT_COMMAND_LIMITS = {
  name: 32,
  description: 100,
  /** How many commands one bot may register. */
  perBot: 50,
  /** The longest argument string handed to a bot. */
  argumentLength: 2000,
} as const;

/** One command a bot tells the server it offers. */
export interface BotCommandRegistration {
  name: string;
  description: string;
  /** The caller must hold this, and so must the bot. A decimal bitfield string. */
  requiredPermissions: string;
}

/** A registered command, with the bot it belongs to, as the registry returns it. */
export interface RegisteredCommand {
  id: string;
  name: string;
  description: string;
  requiredPermissions: string;
  bot: {
    id: string;
    username: string;
    displayName: string | null;
    avatarHash: string | null;
  };
}

/** Commands the caller may invoke, for the composer's completion list. */
export interface RegisteredCommandListResponse {
  commands: RegisteredCommand[];
}

/** A bot's own commands, as the bot reads them back. */
export interface BotCommandListResponse {
  commands: BotCommandRegistration[];
}
