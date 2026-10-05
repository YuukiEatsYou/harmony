/**
 * Pure helpers for the Server gifs tab and its admin section: tag text, search,
 * ordering and reordering. They know nothing about the network or the DOM so the
 * text smoke test can exercise them directly.
 */

/** Must match the server's limits in the shared schema. */
export const MAX_TAGS = 12;
export const MAX_TAG_LENGTH = 30;

/**
 * Turns what an admin typed ("Hello, wave  hello") into tags: split on commas and
 * whitespace, lower-cased, de-duplicated in first-seen order, and held to the
 * limits the server enforces so a long paste is trimmed here rather than refused.
 */
export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  for (const piece of input.split(/[\s,]+/)) {
    const tag = piece.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (tag.length > 0) seen.add(tag);
    if (seen.size >= MAX_TAGS) break;
  }
  return [...seen];
}

/** The inverse of parseTags, for filling a text field. */
export function formatTags(tags: readonly string[]): string {
  return tags.join(', ');
}

interface Searchable {
  name: string;
  tags: readonly string[];
  filename: string;
}

/** Whether a gif matches a search term, by name, tag or filename (case-insensitive, substring). */
export function matchesServerGif(gif: Searchable, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    gif.name.toLowerCase().includes(needle) ||
    gif.filename.toLowerCase().includes(needle) ||
    gif.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
}

interface Orderable {
  id: string;
  pinned: boolean;
  position: number;
}

/** The server's display order: pinned first, then by position; the sort is stable on ties. */
export function orderCurated<T extends Orderable>(gifs: readonly T[]): T[] {
  return [...gifs].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.position - b.position);
}

/**
 * Moves one id a step up (-1) or down (+1) within the displayed order, and returns
 * the new id order for the server. A move off either end, or of an unknown id,
 * returns the list unchanged. Pinned and unpinned gifs form two runs in the
 * display, and a gif never crosses from one run to the other (pinning does that),
 * so the order the server stores stays consistent with what is shown.
 */
export function moveInOrder<T extends Orderable>(gifs: readonly T[], id: string, delta: -1 | 1): string[] {
  const ids = gifs.map((gif) => gif.id);
  const from = gifs.findIndex((gif) => gif.id === id);
  const to = from + delta;
  const source = gifs[from];
  const target = gifs[to];
  if (!source || !target || source.pinned !== target.pinned) return ids;
  [ids[from], ids[to]] = [ids[to] as string, ids[from] as string];
  return ids;
}

/** Where the picker loads a tile from: the stored copy for a curated gif, the attachment otherwise. */
export function serverGifUrl(gif: { id: string; source: 'curated' | 'auto' }): string {
  return gif.source === 'curated' ? `/api/v1/gifs/server/${gif.id}/image` : `/api/v1/attachments/${gif.id}`;
}
