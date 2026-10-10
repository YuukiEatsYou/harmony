/**
 * The pure half of the composer's autocomplete: reading the `:name`, `@name`,
 * `@time`, `#channel` or `/command` fragment at the caret, and turning a trigger
 * plus the candidate data into the rows the popup shows. It holds no state and
 * touches no stores, so the text smoke test imports it straight into Node; the
 * composer passes the lists (emoji, commands, channels, members) in.
 */
import type { Channel, Emoji, RegisteredCommand, User } from '@harmony/shared';
import { avatarUrl, initial } from './avatar.ts';
import type { UsedEmoji } from './emoji-usage.ts';
import type { IconName } from './icons.ts';
import { matchSlashCommands, slashQuery } from './slash-commands.ts';
import { parseTimeExpression, timestampChoices, type ParsedMoment } from './time-input.ts';
import type { UnicodeEmoji } from './unicode-emoji.ts';

/** How many matches any autocomplete offers at once. */
export const MAX_SUGGESTIONS = 8;
/** What may follow an `@` and still be the start of a member's name. */
const mentionQuery = /^[a-zA-Z0-9._-]{0,32}$/;

/**
 * An `@` starts both a mention and a timestamp, so a mention trigger also
 * carries the moment its text reads as, when it reads as one.
 */
export type Trigger =
  | { kind: 'emoji'; start: number; query: string }
  | { kind: 'mention'; start: number; query: string; moment: ParsedMoment | null }
  | { kind: 'channel'; start: number; query: string }
  | { kind: 'slash'; start: number; query: string };

/** One row in the autocomplete popup, whichever kind it is. */
export interface Suggestion {
  key: string;
  label: string;
  detail: string | null;
  imageUrl: string | null;
  initial: string | null;
  /** A unicode emoji shown as its own glyph, rather than an image or an initial. */
  emoji?: string | null;
  icon: IconName | null;
  /** The text inserted when the row is accepted. */
  insert: string;
  /** Set on a bot-command row: the registration this row stands for. */
  commandId?: string;
}

/**
 * Finds the `:name`, `@name`, `@time` or `#channel` fragment ending at the
 * caret, delimited by the start of the line or whitespace, the way Discord
 * triggers autocomplete. `commands` is every registered bot command, so a typed
 * slash opens the popup for one even before it is known online.
 */
export function detectTrigger(
  text: string,
  caret: number,
  commands: readonly RegisteredCommand[],
  now: number = Date.now(),
): Trigger | null {
  const before = text.slice(0, caret);

  // A slash helper only exists as the first word of the message. A typed slash
  // starts the popup when it could be a helper or a bot command.
  const slash = slashQuery(before);
  if (slash !== null && anySlashMatch(slash, commands)) return { kind: 'slash', start: 0, query: slash };

  const emoji = /(?:^|\s):([a-zA-Z0-9_]{0,32})$/.exec(before);
  if (emoji) {
    const query = emoji[1] ?? '';
    return { kind: 'emoji', start: caret - query.length - 1, query };
  }

  // A time may hold spaces ("tomorrow 18:00") where a name cannot, so the
  // fragment runs to the caret and is then asked whether it is either. When it
  // is neither, it is ordinary text that happens to follow an `@`.
  const mention = /(?:^|\s)@([^@\n]{0,40})$/.exec(before);
  if (mention) {
    const query = mention[1] ?? '';
    const moment = parseTimeExpression(query, { now });
    if (moment || mentionQuery.test(query)) {
      return { kind: 'mention', start: caret - query.length - 1, query, moment };
    }
  }

  // A channel name may contain a space, but the query stops at one: typing
  // `#off` offers `Off Topic` rather than trying to pass the space through.
  const channel = /(?:^|\s)#([^\s#]{0,63})$/.exec(before);
  if (channel) {
    const query = channel[1] ?? '';
    return { kind: 'channel', start: caret - query.length - 1, query };
  }

  return null;
}

/** Whether a typed slash could become a built-in helper or a registered bot command. */
function anySlashMatch(query: string, commands: readonly RegisteredCommand[]): boolean {
  const needle = query.toLowerCase();
  return matchSlashCommands(needle).length > 0 || commands.some((command) => command.name.startsWith(needle));
}

/** Ranks a member: 0 for a prefix match, 1 for a substring, 2 for no match. */
export function rankMember(user: Pick<User, 'username' | 'displayName'>, needle: string): number {
  const username = user.username.toLowerCase();
  const display = (user.displayName ?? '').toLowerCase();
  if (username.startsWith(needle) || display.startsWith(needle)) return 0;
  if (username.includes(needle) || display.includes(needle)) return 1;
  return 2;
}

/** Everything the builders read from the stores, handed in so they stay pure. */
export interface SuggestionData {
  picker: readonly Emoji[];
  unicode: readonly UnicodeEmoji[];
  /** Frequently used emoji, best first. */
  ranked: readonly UsedEmoji[];
  /** Score by emoji identity; unused emoji are absent. */
  scores: ReadonlyMap<string, number>;
  /** Registered bot commands, already filtered to those whose bot is online. */
  commands: readonly RegisteredCommand[];
  channels: readonly Channel[];
  /** Members who can be mentioned in the current channel. */
  users: readonly User[];
  now: number;
}

/** The popup rows for a trigger, or none when there is no trigger. */
export function suggestionsFor(trigger: Trigger | null, data: SuggestionData): Suggestion[] {
  if (!trigger) return [];
  const needle = trigger.query.toLowerCase();

  if (trigger.kind === 'emoji') return emojiSuggestions(needle, data);
  if (trigger.kind === 'slash') return slashSuggestions(needle, data.commands);
  if (trigger.kind === 'channel') return channelSuggestions(needle, data.channels);
  return mentionSuggestions(trigger, needle, data);
}

function emojiSuggestions(needle: string, data: SuggestionData): Suggestion[] {
  const byName = [...data.picker].sort((a, b) => a.name.localeCompare(b.name));
  const prefix = byName.filter((emoji) => emoji.name.toLowerCase().startsWith(needle));
  const rest = needle
    ? byName.filter(
        (emoji) => !emoji.name.toLowerCase().startsWith(needle) && emoji.name.toLowerCase().includes(needle),
      )
    : [];
  const server: Suggestion[] = [...prefix, ...rest].map((emoji) => ({
    key: `emoji:${emoji.id}`,
    label: `:${emoji.name}:`,
    detail: null,
    imageUrl: `/api/v1/emojis/${emoji.id}`,
    initial: null,
    icon: null,
    insert: `:${emoji.name}: `,
  }));

  // Unicode emoji share the trigger. The instance's own come first, so a custom
  // `:smile:` wins over the unicode one, and only a typed name brings them in:
  // an empty query would otherwise drown the server emoji.
  const unicode: Suggestion[] = needle
    ? data.unicode
        .filter((emoji) => emoji.name.toLowerCase().includes(needle))
        .sort((a, b) => {
          const aPrefix = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
          const bPrefix = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
          return aPrefix - bPrefix || a.name.localeCompare(b.name);
        })
        .map((emoji) => ({
          key: `unicode:${emoji.emoji}`,
          label: emoji.name,
          detail: null,
          imageUrl: null,
          initial: null,
          emoji: emoji.emoji,
          icon: null,
          insert: `${emoji.emoji} `,
        }))
    : [];

  // Emoji this member uses a lot rise: a bare `:` offers their top few, and a
  // typed query keeps its order except that used matches go first (the sort is
  // stable, so equal scores keep custom ahead of unicode).
  const scores = data.scores;
  const scoreOf = (suggestion: Suggestion): number => scores.get(suggestion.key.replace(/^(?:emoji|unicode):/, '')) ?? 0;
  const used: Suggestion[] = needle
    ? []
    : data.ranked.slice(0, 6).map((entry) =>
        entry.emojiId
          ? {
              key: `emoji:${entry.emojiId}`,
              label: entry.emoji,
              detail: null,
              imageUrl: `/api/v1/emojis/${entry.emojiId}`,
              initial: null,
              icon: null,
              insert: `${entry.emoji} `,
            }
          : {
              key: `unicode:${entry.emoji}`,
              label: data.unicode.find((e) => e.emoji === entry.emoji)?.name ?? entry.emoji,
              detail: null,
              imageUrl: null,
              initial: null,
              emoji: entry.emoji,
              icon: null,
              insert: `${entry.emoji} `,
            },
      );
  const seen = new Set(used.map((suggestion) => suggestion.key));
  const merged = [...used, ...[...server, ...unicode].filter((suggestion) => !seen.has(suggestion.key))];
  return (needle ? merged.sort((a, b) => scoreOf(b) - scoreOf(a)) : merged).slice(0, MAX_SUGGESTIONS);
}

function slashSuggestions(needle: string, commands: readonly RegisteredCommand[]): Suggestion[] {
  const builtins: Suggestion[] = matchSlashCommands(needle).map((command) => ({
    key: `slash:${command.name}`,
    label: command.usage,
    detail: command.description,
    imageUrl: null,
    initial: null,
    icon: null,
    insert: `/${command.name} `,
  }));
  // Bot commands join the same list, each naming the bot it belongs to. Only one
  // whose bot is online reaches here: an offline bot cannot answer, and a command
  // that silently does nothing is worse than not offering it.
  const fromBots: Suggestion[] = commands
    .filter((command) => command.name.startsWith(needle))
    .map((command) => ({
      key: `botcmd:${command.id}`,
      label: `/${command.name}`,
      detail: `${command.description} · by ${command.bot.displayName ?? command.bot.username}`,
      imageUrl: null,
      initial: null,
      icon: 'bot' as IconName,
      insert: `/${command.name} `,
      commandId: command.id,
    }));
  return [...builtins, ...fromBots];
}

function channelSuggestions(needle: string, channels: readonly Channel[]): Suggestion[] {
  const matches = channels
    .filter((channel) => channel.name.toLowerCase().includes(needle))
    .sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
      const bPrefix = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
      return aPrefix - bPrefix || a.name.localeCompare(b.name);
    })
    .slice(0, MAX_SUGGESTIONS);
  return matches.map((channel) => ({
    key: `channel:${channel.id}`,
    label: `#${channel.name}`,
    detail: null,
    imageUrl: null,
    initial: null,
    icon: null,
    insert: `#${channel.name} `,
  }));
}

function mentionSuggestions(
  trigger: Extract<Trigger, { kind: 'mention' }>,
  needle: string,
  data: SuggestionData,
): Suggestion[] {
  const people: Suggestion[] = mentionQuery.test(trigger.query)
    ? data.users
        .map((user) => ({ user, rank: rankMember(user, needle) }))
        .filter((entry) => entry.rank < 2)
        .sort((a, b) => a.rank - b.rank || a.user.username.localeCompare(b.user.username))
        .slice(0, MAX_SUGGESTIONS)
        .map(({ user }) => ({
          key: `mention:${user.id}`,
          label: user.displayName ?? user.username,
          detail: `@${user.username}`,
          imageUrl: avatarUrl(user),
          initial: initial(user),
          icon: null,
          insert: `@${user.username} `,
        }))
    : [];

  // Members come first: whoever types `@fri` is more likely after Frida than
  // Friday, and a time is never more than a few arrow presses below. When nobody
  // matches, the times are all there is and lead on their own.
  const times: Suggestion[] = trigger.moment
    ? timestampChoices(trigger.moment, { now: data.now }).map((choice) => ({
        key: `time:${choice.style}`,
        label: choice.preview,
        detail: choice.name,
        imageUrl: null,
        initial: null,
        icon: 'clock',
        insert: `${choice.token} `,
      }))
    : [];
  return [...people, ...times];
}
