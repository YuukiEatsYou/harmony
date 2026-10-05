/**
 * Link helpers shared by the client's markdown parser and the server's link
 * unfurler, so both agree on what counts as a link and how it is trimmed.
 */

/** Regions that must never be unfurled: masked links, angle links and code. */
const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
const MASKED_LINK = /\[[^\]\n]+?\]\(https?:\/\/[^\s)]+\)/g;
const ANGLE_LINK = /<https?:\/\/[^\s>]+>/g;
const BARE_URL = /https?:\/\/[^\s<>]+/g;
/** Code spans, whose contents must survive `unwrapSuppressedLinks` untouched. */
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

/**
 * Strips trailing sentence punctuation that is almost never part of a bare URL,
 * and balances a stray closing parenthesis against any opening one.
 */
export function cleanUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?]+$/, '');
  while (url.endsWith(')')) {
    const open = (url.match(/\(/g) ?? []).length;
    const close = (url.match(/\)/g) ?? []).length;
    if (close <= open) break;
    url = url.slice(0, -1);
  }
  return url;
}

/**
 * The URLs in a message that are safe to unfurl, in order and without
 * duplicates. Masked and angle-bracket links are skipped because both are meant
 * to suppress previews, and anything inside code is skipped too.
 */
export function listEmbeddableUrls(text: string): string[] {
  // Blank the regions we must not scan, keeping the original length so a match
  // below cannot shift anything around it.
  const blank = (match: string): string => ' '.repeat(match.length);
  const scannable = text
    .replace(FENCED_CODE, blank)
    .replace(INLINE_CODE, blank)
    .replace(MASKED_LINK, blank)
    .replace(ANGLE_LINK, blank);

  const found: string[] = [];
  for (const match of scannable.matchAll(BARE_URL)) {
    const url = cleanUrl(match[0]);
    if (url.length === 0) continue;
    if (!found.includes(url)) found.push(url);
  }
  return found;
}

/**
 * Removes angle-bracket link suppression from message text, leaving plain URLs.
 *
 * The bridge no longer calls this: Harmony honors `<https://…>` itself (no
 * preview, drawn as an ordinary link), so bridged text keeps its brackets in
 * both directions and a suppressed link stays suppressed on either side. Kept
 * as a utility for callers that need the bare URL. Code spans are skipped,
 * since brackets there are literal characters.
 */
export function unwrapSuppressedLinks(text: string): string {
  const code: string[] = [];
  const masked = text.replace(CODE, (match) => {
    code.push(match);
    return `\u0000${code.length - 1}\u0000`;
  });
  const unwrapped = masked.replace(ANGLE_LINK, (match) => match.slice(1, -1));
  if (code.length === 0) return unwrapped;
  return unwrapped.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => code[Number(index)] ?? '');
}
