import type { Channel, Emoji, User } from '@harmony/shared';
import { inlineSegmentsOf, parseMessage, type MessageBlock } from './message-text.ts';

/**
 * What the message box shows above itself while a draft is being written.
 *
 * A custom emoji is typed, picked or completed as its `:name:` shortcode, and
 * only becomes a picture once the message is sent. The box is a plain textarea,
 * so it cannot show the picture in place; this parses the draft the way a sent
 * message is parsed and hands back the blocks for a small preview strip.
 *
 * It returns null unless the draft holds an emoji that will actually resolve:
 * an ordinary draft, an unknown `:name:`, an emoji inside a code block or an
 * escaped one (`\:name:`) has nothing to preview, and the strip stays away.
 */
export function draftPreview(
  text: string,
  emojiLookup: Map<string, Emoji>,
  mentionLookup: (username: string) => User | undefined,
  channels: readonly Channel[] = [],
): MessageBlock[] | null {
  // Every shortcode has a colon, so most drafts are ruled out without parsing.
  if (emojiLookup.size === 0 || !text.includes(':')) return null;
  const blocks = parseMessage(text, emojiLookup, mentionLookup, channels);
  return inlineSegmentsOf(blocks).some((segment) => segment.type === 'emoji') ? blocks : null;
}
