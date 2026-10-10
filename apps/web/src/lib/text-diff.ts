/**
 * A small word-level diff for the message edit history. Pure and bounded: it
 * never does more than `MAX_CELLS` steps of work, however long the two texts
 * are, so a pasted wall of text cannot freeze the page.
 */

export type DiffKind = 'same' | 'add' | 'del';

export interface DiffPart {
  kind: DiffKind;
  text: string;
}

/** Longer texts than this are cut before diffing; the cut tail is not compared. */
export const MAX_DIFF_CHARS = 8000;
/** The most table cells the diff of the differing middle may use. */
export const MAX_CELLS = 250_000;

// Words, runs of whitespace, and every other character on its own. Splitting by
// code point keeps emoji and other astral characters whole.
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** Joins neighbours of the same kind so the output stays short. */
function push(parts: DiffPart[], kind: DiffKind, text: string): void {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) last.text += text;
  else parts.push({ kind, text });
}

/**
 * Compares two texts word by word. Concatenating the `same` and `del` parts
 * gives back `before`; the `same` and `add` parts give `after` (within the
 * length cap). When the changed middle is too large to compare closely, it is
 * reported as one removal followed by one addition.
 */
export function diffWords(before: string, after: string): DiffPart[] {
  const cut = (text: string): string => {
    if (text.length <= MAX_DIFF_CHARS) return text;
    let end = MAX_DIFF_CHARS;
    // A hard cut can land between the two halves of a character outside the
    // basic plane; back off one unit so it falls before the character, not
    // through it (a lone surrogate would render as a replacement glyph).
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return text.slice(0, end);
  };
  const a = tokenize(cut(before));
  const b = tokenize(cut(after));
  const parts: DiffPart[] = [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  push(parts, 'same', a.slice(0, start).join(''));

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 || midB.length === 0 || (midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
    push(parts, 'del', midA.join(''));
    push(parts, 'add', midB.join(''));
  } else {
    // Longest common subsequence over the differing middle.
    const width = midB.length + 1;
    const table = new Uint16Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          midA[i] === midB[j]
            ? (table[(i + 1) * width + j + 1] as number) + 1
            : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        push(parts, 'same', midA[i] as string);
        i += 1;
        j += 1;
      } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
        push(parts, 'del', midA[i] as string);
        i += 1;
      } else {
        push(parts, 'add', midB[j] as string);
        j += 1;
      }
    }
    while (i < midA.length) push(parts, 'del', midA[i++] as string);
    while (j < midB.length) push(parts, 'add', midB[j++] as string);
  }

  push(parts, 'same', a.slice(endA).join(''));
  return parts;
}
