/**
 * The search box's filter syntax, in the style of Discord: free text plus
 * tokens such as `from:alice`, `in:general`, `has:image` or `after:2024-05-01`.
 * A value with spaces is quoted, `from:"Some Name"`.
 *
 * Everything here is pure so it can be checked without a browser. The panel
 * keeps the typed text in the input and the completed tokens as chips; this file
 * decides what is a token, turns tokens into API parameters, and offers
 * completions for the one being typed.
 */
import { SEARCH_HAS_VALUES } from '@harmony/shared';

/** The filters the box understands, in the order they are suggested. */
export const FILTER_KEYS = ['from', 'mentions', 'in', 'has', 'before', 'after', 'on'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export interface SearchFilter {
  key: FilterKey;
  value: string;
}

/** A token found in the text, with where it sat so it can be cut out again. */
interface Token {
  raw: string;
  start: number;
  end: number;
  /** The filter this token is, or null for plain text. */
  filter: SearchFilter | null;
  /** True when the token ends before whitespace, so it is finished being typed. */
  closed: boolean;
}

function isFilterKey(word: string): word is FilterKey {
  return (FILTER_KEYS as readonly string[]).includes(word);
}

/**
 * Splits the text into whitespace-separated tokens, honouring double quotes so
 * `from:"Some Name"` stays whole. An unterminated quote runs to the end of the
 * text, which is how a half-typed name is still one token.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    if (/\s/.test(input[index]!)) {
      index += 1;
      continue;
    }
    const start = index;
    let inQuote = false;
    while (index < input.length && (inQuote || !/\s/.test(input[index]!))) {
      if (input[index] === '"') inQuote = !inQuote;
      index += 1;
    }
    const raw = input.slice(start, index);
    tokens.push({ raw, start, end: index, filter: filterOf(raw), closed: index < input.length && !inQuote });
  }
  return tokens;
}

/** The filter a token spells, or null when it is ordinary text or has no value yet. */
function filterOf(raw: string): SearchFilter | null {
  const colon = raw.indexOf(':');
  if (colon <= 0) return null;
  const key = raw.slice(0, colon).toLowerCase();
  if (!isFilterKey(key)) return null;
  const value = unquote(raw.slice(colon + 1)).trim();
  return value.length === 0 ? null : { key, value };
}

/** Strips one pair of surrounding quotes, or a lone opening one. */
function unquote(value: string): string {
  if (!value.startsWith('"')) return value.replace(/"/g, '');
  const close = value.indexOf('"', 1);
  return close === -1 ? value.slice(1) : value.slice(1, close);
}

/** A filter written back as text, quoting a value that has spaces. */
export function filterToken(filter: SearchFilter): string {
  const value = filter.value.replace(/"/g, '');
  return /\s/.test(value) ? `${filter.key}:"${value}"` : `${filter.key}:${value}`;
}

/** The human wording of a filter, for a chip. */
export function filterLabel(filter: SearchFilter): string {
  return `${filter.key}: ${filter.value}`;
}

export interface ParsedSearch {
  /** What is left once the filter tokens are taken out, single-spaced. */
  text: string;
  filters: SearchFilter[];
}

/**
 * Pulls the filters out of `input`. With `final` false a token still being typed
 * (no whitespace after it yet) stays in the text, so the box never snatches a
 * word out from under the caret; `final` true takes it too.
 */
export function parseSearchInput(input: string, final = true): ParsedSearch {
  const filters: SearchFilter[] = [];
  const words: string[] = [];
  for (const token of tokenize(input)) {
    const done = final || token.closed;
    if (token.filter && done) filters.push(token.filter);
    else if (!done || !isBareKey(token.raw)) words.push(token.raw);
  }
  return { text: words.join(' '), filters };
}

/** `from:` with nothing after it: a half-typed filter that is not searched as text. */
function isBareKey(raw: string): boolean {
  const colon = raw.indexOf(':');
  return colon > 0 && isFilterKey(raw.slice(0, colon).toLowerCase()) && unquote(raw.slice(colon + 1)).trim() === '';
}

/** The same filter, so a duplicate chip can be refused. */
export function sameFilter(a: SearchFilter, b: SearchFilter): boolean {
  return a.key === b.key && a.value.toLowerCase() === b.value.toLowerCase();
}

/** Adds the filters not already present. */
export function mergeFilters(existing: SearchFilter[], added: SearchFilter[]): SearchFilter[] {
  const merged = [...existing];
  for (const filter of added) if (!merged.some((have) => sameFilter(have, filter))) merged.push(filter);
  return merged;
}

// ---------------------------------------------------------------------------
// Dates

/** Midnight at the start of the given local day, or null when it is not a real date. */
function localDay(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/**
 * Reads `YYYY-MM-DD`, `today` or `yesterday` as the start of that day in the
 * member's own time zone, or null when it is none of those.
 */
export function parseSearchDate(value: string, now: Date = new Date()): Date | null {
  const word = value.trim().toLowerCase();
  if (word === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (word === 'yesterday') return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(word);
  if (!match) return null;
  return localDay(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** The start of the day after `day`, found on the calendar so a clock change cannot skew it. */
function nextDay(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
}

// ---------------------------------------------------------------------------
// API parameters

export interface SearchRequest {
  params: URLSearchParams;
  /** Anything in the query that could not be understood; empty when it is fine. */
  problems: string[];
  /** Whether there is anything to search for at all. */
  searchable: boolean;
}

/**
 * Turns text and filters into the search endpoint's parameters. `before:` is the
 * start of that day, `after:` is the end of it (so it means "later than that
 * day"), and `on:` is the whole day; all in the local time zone.
 */
export function buildSearchParams(
  text: string,
  filters: SearchFilter[],
  now: Date = new Date(),
): SearchRequest {
  const params = new URLSearchParams();
  const problems: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length > 0) params.set('q', trimmed);

  let sentAfter: number | null = null;
  let sentBefore: number | null = null;
  for (const filter of filters) {
    switch (filter.key) {
      case 'from':
      case 'mentions':
      case 'in':
        params.append(filter.key, filter.value.replace(/^[@#]/, ''));
        break;
      case 'has': {
        const word = filter.value.toLowerCase();
        if ((SEARCH_HAS_VALUES as readonly string[]).includes(word)) params.append('has', word);
        else problems.push(`has:${filter.value} is not something messages can have. Try ${SEARCH_HAS_VALUES.join(', ')}.`);
        break;
      }
      default: {
        const day = parseSearchDate(filter.value, now);
        if (!day) {
          problems.push(`${filter.key}:${filter.value} is not a date. Use YYYY-MM-DD, today or yesterday.`);
          break;
        }
        const start = day.getTime();
        const end = nextDay(day).getTime();
        if (filter.key === 'before') sentBefore = Math.min(sentBefore ?? start, start);
        else if (filter.key === 'after') sentAfter = Math.max(sentAfter ?? end, end);
        else {
          sentAfter = Math.max(sentAfter ?? start, start);
          sentBefore = Math.min(sentBefore ?? end, end);
        }
      }
    }
  }
  if (sentAfter !== null) params.set('sentAfter', String(sentAfter));
  if (sentBefore !== null) params.set('sentBefore', String(sentBefore));

  return { params, problems, searchable: problems.length === 0 && params.size > 0 };
}

// ---------------------------------------------------------------------------
// Completion

export interface ActiveToken {
  key: FilterKey;
  /** What has been typed after the colon, without its opening quote. */
  partial: string;
  /** Where the whole token starts and ends in the input, to replace it. */
  start: number;
  end: number;
}

/**
 * The filter token the caret is inside, if it is a key with a value being typed
 * (or about to be), else null. This is what the suggestion list completes.
 */
export function activeToken(input: string, caret: number): ActiveToken | null {
  for (const token of tokenize(input)) {
    const touches = caret >= token.start && caret <= token.end;
    if (!touches) continue;
    const colon = token.raw.indexOf(':');
    if (colon <= 0) return null;
    const key = token.raw.slice(0, colon).toLowerCase();
    if (!isFilterKey(key)) return null;
    return { key, partial: unquote(token.raw.slice(colon + 1)), start: token.start, end: token.end };
  }
  // The caret is after trailing whitespace: nothing is being completed.
  return null;
}

export interface Suggestion {
  /** What the list shows. */
  label: string;
  /** A second, quieter line. */
  detail?: string;
  /** The value that goes after the colon. */
  value: string;
}

export interface SuggestionSources {
  members: ReadonlyArray<{ username: string; displayName?: string | null }>;
  channels: ReadonlyArray<{ name: string }>;
}

const DATE_WORDS = ['today', 'yesterday'];

/** The most a list offers; the box is for narrowing, not browsing. */
export const MAX_SUGGESTIONS = 8;

/** Completions for the token being typed: members, channels or a fixed list. */
export function suggestFor(
  token: ActiveToken,
  sources: SuggestionSources,
  now: Date = new Date(),
): Suggestion[] {
  const needle = token.partial.trim().toLowerCase();
  const matches = (...fields: Array<string | null | undefined>) =>
    needle.length === 0 || fields.some((field) => field?.toLowerCase().includes(needle));
  const starts = (text: string) => text.toLowerCase().startsWith(needle);

  let found: Suggestion[];
  switch (token.key) {
    case 'from':
    case 'mentions':
      found = sources.members
        .filter((member) => matches(member.username, member.displayName))
        .sort((a, b) => Number(starts(b.username)) - Number(starts(a.username)))
        .map((member) => ({
          // No second line: the username is what picking inserts, so the label
          // alone keeps the row short (and readable on a phone).
          label: member.displayName?.trim() || member.username,
          value: member.username,
        }));
      break;
    case 'in':
      found = sources.channels
        .filter((channel) => matches(channel.name))
        .sort((a, b) => Number(starts(b.name)) - Number(starts(a.name)))
        .map((channel) => ({ label: `#${channel.name}`, value: channel.name }));
      break;
    case 'has':
      found = SEARCH_HAS_VALUES.filter((word) => matches(word)).map((word) => ({
        label: word,
        detail: word === 'pin' ? 'pinned messages' : undefined,
        value: word,
      }));
      break;
    default: {
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      found = DATE_WORDS.filter((word) => matches(word)).map((word) => ({
        label: word,
        detail: formatDay(word === 'today' ? today : new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)),
        value: word,
      }));
    }
  }
  return found.slice(0, MAX_SUGGESTIONS);
}

function formatDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Puts a chosen suggestion into the input in place of the token being typed,
 * followed by a space so the token is complete. Returns the new text and where
 * the caret belongs.
 */
export function applySuggestion(
  input: string,
  token: ActiveToken,
  suggestion: Suggestion,
): { text: string; caret: number } {
  const inserted = `${filterToken({ key: token.key, value: suggestion.value })} `;
  const rest = input.slice(token.end).replace(/^\s+/, '');
  const text = input.slice(0, token.start) + inserted + rest;
  return { text, caret: token.start + inserted.length };
}
