/**
 * Bold, italic and underline from the keyboard: Ctrl+B, Ctrl+I and Ctrl+U (Cmd
 * on a Mac) in the message box or the edit box wrap the selection in the
 * markdown the message parser reads, **bold**, *italic* and __underline__, and a
 * second press takes the markers off again.
 *
 * Pure, so the text smoke test can import it. It takes the text and the
 * selection and gives back the new text and the selection to restore, which is
 * what both boxes need: the composer writes through the drafts store and the
 * edit box through its own state, so neither can let the browser edit in place.
 */

/** The marker each shortcut puts around the selection. */
export const FORMAT_MARKERS = { bold: '**', italic: '*', underline: '__' } as const;

export type FormatKind = keyof typeof FORMAT_MARKERS;

/** A box's text and the selection in it, as offsets into the text. */
export interface TextSelection {
  text: string;
  start: number;
  end: number;
}

/** The format a Ctrl or Cmd shortcut stands for, or null when it is not one of them. */
export function formatForKey(press: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): FormatKind | null {
  if (!(press.ctrlKey || press.metaKey) || press.altKey || press.shiftKey) return null;
  switch (press.key.toLowerCase()) {
    case 'b':
      return 'bold';
    case 'i':
      return 'italic';
    case 'u':
      return 'underline';
    default:
      return null;
  }
}

/**
 * How many characters of a run of one marker character belong to a format.
 * Asterisks stack: one is italic, two bold, three both, so italic is present in
 * a run of one or three and bold in a run of two or three. Underscores stack the
 * same way with underline in the place of bold. Anything else is not a marker
 * the parser would read, so it counts as no format at all.
 */
function holds(run: number, marker: string): boolean {
  if (marker.length === 2) return run === 2 || run === 3;
  return run === 1 || run === 3;
}

/** How many of `char` there are at the start of `text`. */
function leadingRun(text: string, char: string): number {
  let count = 0;
  while (count < text.length && text[count] === char) count += 1;
  return count;
}

/** How many of `char` there are at the end of `text`. */
function trailingRun(text: string, char: string): number {
  let count = 0;
  while (count < text.length && text[text.length - 1 - count] === char) count += 1;
  return count;
}

/**
 * Wraps the selection in a format, or unwraps it when it already has it.
 *
 * Already having it means either that the selection itself starts and ends with
 * the marker (the member selected the markers too), or that the marker sits just
 * outside it on both sides (they selected only the words). With nothing
 * selected the pair goes in with the caret between, ready to type into. Spaces
 * at either end of a selection are left outside the markers, since markdown does
 * not read `** bold**` as bold.
 */
export function toggleFormat(selection: TextSelection, kind: FormatKind): TextSelection {
  const marker = FORMAT_MARKERS[kind];
  const char = marker.charAt(0);
  const size = marker.length;
  const { text } = selection;
  const from = Math.max(0, Math.min(selection.start, selection.end, text.length));
  const to = Math.min(text.length, Math.max(selection.start, selection.end));

  if (from === to) {
    return { text: `${text.slice(0, from)}${marker}${marker}${text.slice(to)}`, start: from + size, end: from + size };
  }

  // An empty pair, as an earlier press with nothing selected left it, just goes.
  const selected = text.slice(from, to);
  if (selected === marker + marker) {
    return { text: `${text.slice(0, from)}${text.slice(to)}`, start: from, end: from };
  }

  // Selected with its markers: take them off the inside of the selection.
  const innerLead = leadingRun(selected, char);
  const innerTrail = trailingRun(selected, char);
  if (selected.length > size * 2 && holds(innerLead, marker) && holds(innerTrail, marker) && innerLead < selected.length) {
    const inner = selected.slice(size, selected.length - size);
    return { text: `${text.slice(0, from)}${inner}${text.slice(to)}`, start: from, end: from + inner.length };
  }

  // Only the words selected, with the markers just outside: take those off.
  const before = text.slice(0, from);
  const after = text.slice(to);
  if (holds(trailingRun(before, char), marker) && holds(leadingRun(after, char), marker)) {
    return {
      text: `${before.slice(0, before.length - size)}${selected}${after.slice(size)}`,
      start: from - size,
      end: to - size,
    };
  }

  // Wrap, leaving any spaces at the edges of the selection outside the markers.
  const lead = selected.length - selected.trimStart().length;
  const trail = selected.length - selected.trimEnd().length;
  if (lead === selected.length) {
    // Nothing but spaces selected: treat it like an empty selection at its end.
    return toggleFormat({ text, start: to, end: to }, kind);
  }
  const core = selected.slice(lead, selected.length - trail);
  const wrapped = `${selected.slice(0, lead)}${marker}${core}${marker}${selected.slice(selected.length - trail)}`;
  return {
    text: `${before}${wrapped}${after}`,
    start: from + lead + size,
    end: from + lead + size + core.length,
  };
}
