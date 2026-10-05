import type { Emoji } from '@harmony/shared';
import { inlineSegmentsOf, parseMessage } from './message-text.ts';
import { unicodeEmojiIn } from './jumbo-emoji.ts';

/** How many distinct emoji are remembered. */
export const USAGE_CAP = 36;

/** A use counts half as much after this long: recent habits outrank old ones. */
export const USAGE_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * One remembered emoji. `emoji` is the character for a unicode emoji and the
 * `:name:` shortcode for a custom one, `emojiId` is set only for custom emoji,
 * and `score` is the decayed use count as of `last`.
 */
export interface UsageEntry {
  emoji: string;
  emojiId: string | null;
  score: number;
  last: number;
}

/** What a use is made of; the id picks out a custom emoji. */
export interface UsedEmoji {
  emoji: string;
  emojiId: string | null;
}

/** The key an emoji is scored under: its id when custom, else the character. */
export const usageKey = (item: UsedEmoji): string => item.emojiId ?? item.emoji;

/** The entry's score brought forward to `now`. */
export function scoreAt(entry: UsageEntry, now: number): number {
  const elapsed = Math.max(0, now - entry.last);
  return entry.score * Math.pow(0.5, elapsed / USAGE_HALF_LIFE_MS);
}

/** Highest current score first; the more recent use breaks a tie. */
export function rankEntries(entries: readonly UsageEntry[], now: number): UsageEntry[] {
  return [...entries].sort((a, b) => scoreAt(b, now) - scoreAt(a, now) || b.last - a.last);
}

/** Adds a use of each emoji, trimming to the cap by dropping the lowest scores. */
export function recordUsage(entries: readonly UsageEntry[], used: readonly UsedEmoji[], now: number): UsageEntry[] {
  const byKey = new Map(entries.map((entry) => [usageKey(entry), { ...entry }]));
  for (const item of used) {
    const key = usageKey(item);
    const existing = byKey.get(key);
    // The shortcode is kept current, since a custom emoji can be renamed.
    byKey.set(key, {
      emoji: item.emoji,
      emojiId: item.emojiId,
      score: (existing ? scoreAt(existing, now) : 0) + 1,
      last: now,
    });
  }
  return rankEntries([...byKey.values()], now).slice(0, USAGE_CAP);
}

/**
 * The ranked entries, minus custom emoji that no longer exist. A surviving one
 * takes its current name. `customById` should hold only emoji a member can pick.
 */
export function resolveUsage(
  entries: readonly UsageEntry[],
  customById: ReadonlyMap<string, Pick<Emoji, 'id' | 'name'>>,
  now: number,
): UsedEmoji[] {
  const out: UsedEmoji[] = [];
  for (const entry of rankEntries(entries, now)) {
    if (entry.emojiId === null) {
      out.push({ emoji: entry.emoji, emojiId: null });
      continue;
    }
    const current = customById.get(entry.emojiId);
    if (current) out.push({ emoji: `:${current.name}:`, emojiId: current.id });
  }
  return out;
}

/** Score by emoji identity, for ranking suggestions. Emoji never used are absent (score 0). */
export function scoreMap(entries: readonly UsageEntry[], now: number): Map<string, number> {
  return new Map(entries.map((entry) => [usageKey(entry), scoreAt(entry, now)]));
}

/** Every emoji in message text, custom ones that resolve and unicode alike; code is skipped. */
export function emojiInContent(content: string, lookup: Map<string, Emoji>): UsedEmoji[] {
  const blocks = parseMessage(content, lookup, () => undefined);
  const out: UsedEmoji[] = [];
  for (const segment of inlineSegmentsOf(blocks)) {
    if (segment.type === 'emoji') {
      out.push({ emoji: `:${segment.emoji.name}:`, emojiId: segment.emoji.id });
    } else if (segment.type === 'text') {
      for (const emoji of unicodeEmojiIn(segment.value)) out.push({ emoji, emojiId: null });
    }
  }
  return out;
}

/** Reads stored usage defensively: anything malformed is dropped. */
export function parseUsage(raw: string | null): UsageEntry[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const out: UsageEntry[] = [];
    for (const item of data) {
      if (typeof item !== 'object' || item === null) continue;
      const { emoji, emojiId, score, last } = item as Record<string, unknown>;
      if (typeof emoji !== 'string' || emoji.length === 0 || emoji.length > 64) continue;
      if (emojiId !== null && typeof emojiId !== 'string') continue;
      if (typeof score !== 'number' || !Number.isFinite(score) || score <= 0) continue;
      if (typeof last !== 'number' || !Number.isFinite(last)) continue;
      out.push({ emoji, emojiId: emojiId ?? null, score, last });
    }
    return out.slice(0, USAGE_CAP);
  } catch {
    return [];
  }
}
