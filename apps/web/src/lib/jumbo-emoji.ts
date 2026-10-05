import type { MessageBlock } from './message-text.ts';

/** Discord's ceiling: past this many emoji a message is drawn at normal size. */
export const JUMBO_MAX_EMOJI = 27;

/**
 * One unicode emoji as a single grapheme: a pictograph with an optional
 * variation selector or skin tone, joined to more of them by ZWJ, with the tag
 * characters a subdivision flag ends in; a pair of regional indicators (a
 * flag); or a keycap. The pictograph class alone would also take the digits,
 * `#` and `*`, which are not emoji until they carry the keycap mark.
 */
const EMOJI_GRAPHEME = new RegExp(
  [
    '^(?:',
    '\\p{Regional_Indicator}{2}',
    '|[0-9#*]\\uFE0F?\\u20E3',
    '|\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?[\\u{E0020}-\\u{E007F}]*',
    '(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?)*',
    ')$',
  ].join(''),
  'u',
);

/** Pictographs that are plain text characters unless the emoji selector follows. */
const TEXT_BY_DEFAULT = /^[©®™](?!️)/u;

const segmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** Whether one grapheme cluster is a unicode emoji. */
export function isEmojiGrapheme(grapheme: string): boolean {
  return EMOJI_GRAPHEME.test(grapheme) && !TEXT_BY_DEFAULT.test(grapheme);
}

/**
 * The unicode emoji in a run of text, in order, or null when the run holds
 * anything else besides whitespace. Without `Intl.Segmenter` nothing is
 * recognised, which only costs the bigger emoji.
 */
export function unicodeEmojiOnly(text: string): string[] | null {
  if (!segmenter) return null;
  const found: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    if (/^\s+$/u.test(segment)) continue;
    if (!isEmojiGrapheme(segment)) return null;
    found.push(segment);
  }
  return found;
}

/** Every unicode emoji in a run of text, ignoring whatever surrounds them. */
export function unicodeEmojiIn(text: string): string[] {
  if (!segmenter) return [];
  const found: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    if (isEmojiGrapheme(segment)) found.push(segment);
  }
  return found;
}

/**
 * Whether a parsed message is nothing but emoji, which Discord draws large:
 * one paragraph holding between one and 27 emoji, custom ones that resolve
 * and/or unicode, with only whitespace between. Quotes, lists, headers, code
 * and links all make it an ordinary message, as does any text, an unknown
 * `:name:` (which stays plain text) and, for the caller to rule out, any
 * attachment.
 */
export function isJumbo(blocks: readonly MessageBlock[]): boolean {
  if (blocks.length !== 1) return false;
  const block = blocks[0];
  if (!block || block.type !== 'paragraph') return false;

  let count = 0;
  for (const segment of block.segments) {
    if (segment.type === 'emoji') {
      count++;
    } else if (segment.type === 'text') {
      const emoji = unicodeEmojiOnly(segment.value);
      if (!emoji) return false;
      count += emoji.length;
    } else {
      return false;
    }
    if (count > JUMBO_MAX_EMOJI) return false;
  }
  return count > 0;
}
