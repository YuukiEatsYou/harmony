/**
 * Slash helpers for the message box: small, Discord-like text transforms that
 * run when a message is sent. They are purely client-side. The server only ever
 * sees the finished text, and nothing here talks to it.
 *
 * A command is the first word of the message, written as `/name`, and only when
 * the word is exactly a known name followed by whitespace or the end of the text.
 * Anything else is ordinary text, so a message that merely begins with a path
 * (`/usr/bin`) or an unknown word (`/foo`) goes out untouched. A leading `\/`
 * sends a literal slash.
 */

export interface SlashCommand {
  name: string;
  /** What to type, shown in the popup. */
  usage: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'shrug', usage: '/shrug [text]', description: 'Appends ¯\\_(ツ)_/¯' },
  { name: 'tableflip', usage: '/tableflip [text]', description: 'Appends (╯°□°)╯︵ ┻━┻' },
  { name: 'unflip', usage: '/unflip [text]', description: 'Appends ┬─┬ノ( º _ ºノ)' },
  { name: 'lenny', usage: '/lenny [text]', description: 'Appends ( ͡° ͜ʖ ͡°)' },
  { name: 'me', usage: '/me <text>', description: 'Sends the text in italics' },
  { name: 'spoiler', usage: '/spoiler <text>', description: 'Hides the text behind a spoiler' },
];

/**
 * The face each emoticon command appends, as message text. The shrug has to be
 * escaped the way Discord's own client escapes it: its backslash and underscores
 * are Markdown, and unescaped the arm vanishes and the face is read as italics.
 * The text below displays as ¯\_(ツ)_/¯.
 */
const FACES: Readonly<Record<string, string>> = {
  shrug: '¯\\\\\\_(ツ)\\_/¯',
  tableflip: '(╯°□°)╯︵ ┻━┻',
  unflip: '┬─┬ノ( º _ ºノ)',
  lenny: '( ͡° ͜ʖ ͡°)',
};

/** A command word at the very start, then whitespace or the end, then the rest. */
const COMMAND = /^\/([a-z]+)(?=\s|$)([\s\S]*)$/;

/** The commands whose name starts with what has been typed after the slash. */
export function matchSlashCommands(query: string): SlashCommand[] {
  const needle = query.toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(needle));
}

/**
 * Whether the text before the caret is a command still being typed: a slash at
 * the very start of the message and command-name characters after it. Returns the
 * query (what follows the slash), or null when this is not a command in progress.
 */
export function slashQuery(beforeCaret: string): string | null {
  const match = /^\/([a-zA-Z0-9_-]{0,32})$/.exec(beforeCaret);
  return match ? (match[1] ?? '') : null;
}

/** Wraps each non-empty line, because italics do not run across a line break. */
function italicize(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.trim().length === 0) return line;
      // A `_` inside would end the emphasis early, so such a line uses stars.
      return line.includes('_') && !line.includes('*') ? `*${line}*` : `_${line}_`;
    })
    .join('\n');
}

/**
 * Applies a leading slash command, or the `\/` escape, to a message about to be
 * sent. Text without one comes back unchanged.
 */
export function applySlashCommand(text: string): string {
  if (text.startsWith('\\/')) return text.slice(1);

  const match = COMMAND.exec(text);
  if (!match) return text;

  const name = match[1] ?? '';
  const args = (match[2] ?? '').trim();

  const face = FACES[name];
  if (face !== undefined) return args.length > 0 ? `${args} ${face}` : face;

  // With nothing to act on, these have no meaning, so the word is just text.
  if (args.length === 0) return text;
  if (name === 'me') return italicize(args);
  if (name === 'spoiler') return `||${args}||`;
  return text;
}
