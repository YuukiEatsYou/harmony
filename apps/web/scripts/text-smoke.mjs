// Focused checks for the client's pure logic: parsing message text into markdown,
// links, emoji and mentions, the merge that catches up after being away, deciding
// whether a message is aimed at you, what the emoji picker offers and finds, and
// the quick switcher's matching, the channel arrows, the unread tab title and
// how mutes change it, how a channel inherits its category's settings, where
// the "new" line and the new-messages bar land, and reading the time
// expressions the composer turns into timestamps.
//
// Run with: npm run smoke:text
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  MUTE_DURATIONS,
  isMuteActive,
  listEmbeddableUrls,
  matchChannelName,
  nextMuteExpiry,
  resolveChannelSettings,
  rewriteChannelMentions,
} from '@harmony/shared';
import { HIGHLIGHT_LANGUAGES, highlight } from '../src/lib/highlighter.ts';
import { inlineSegmentsOf, parseMessage } from '../src/lib/message-text.ts';
import { mergeLatest, mentionsUser } from '../src/lib/messages.ts';
import {
  matchScore,
  rankSwitcher,
  sidebarOrder,
  stepChannel,
  unreadBadge,
  unreadSummary,
  unreadTitle,
} from '../src/lib/quick-switch.ts';
import {
  dayFirst,
  fromDateTimeInputs,
  parseTimeExpression,
  timestampChoices,
  timestampToken,
  toDateTimeInputs,
} from '../src/lib/time-input.ts';
import { firstUnreadIndex, muteLabel, newMessageCount, newMessagesLabel, pillCount } from '../src/lib/unread.ts';
import { formatTimestamp, formatTimestampTitle } from '../src/lib/timestamp.ts';
import { draftPreview } from '../src/lib/composer-preview.ts';
import { filterByName, filterUnicodeGroups } from '../src/lib/unicode-emoji.ts';

const require = createRequire(import.meta.url);

let failures = 0;
function check(name, condition) {
  const ok = Boolean(condition);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

const noEmoji = new Map();
const noMention = () => undefined;

/** Every inline segment of a message, skipping code blocks. */
function inline(text, emoji = noEmoji, mention = noMention, channels = []) {
  return inlineSegmentsOf(parseMessage(text, emoji, mention, channels));
}

/** The concatenated visible text, ignoring styling. */
function plain(text, emoji = noEmoji, mention = noMention, channels = []) {
  return inline(text, emoji, mention, channels)
    .map((segment) => segment.value)
    .join('');
}

function parse(text, emoji = noEmoji, mention = noMention, channels = []) {
  return parseMessage(text, emoji, mention, channels);
}

const styled = (text, style, value) =>
  inline(text).some((segment) => segment.styles?.[style] === true && segment.value === value);

// --- Blocks ---
const single = parse('hello world');
check('plain text is a single paragraph', single.length === 1 && single[0].type === 'paragraph');
check('plain text round-trips', plain('hello world') === 'hello world');

const fenced = parse('```js\nconst a = 1;\n```');
check(
  'a fenced block becomes code',
  fenced.length === 1 && fenced[0].type === 'code' && fenced[0].text === 'const a = 1;' && fenced[0].language === 'js',
);
check('text around a fence stays in paragraphs', parse('before\n```\nx\n```\nafter').length === 3);

const longFence = parse('````\ncode\n```\nmore\n````');
check(
  'a longer fence is not closed by fewer backticks',
  longFence.length === 1 && longFence[0].type === 'code' && longFence[0].text === 'code\n```\nmore',
);

check('a level 1 header is detected', parse('# Title')[0].type === 'header' && parse('# Title')[0].level === 1);
check('a level 2 header is detected', parse('## Title')[0].level === 2);

const quote = parse('> one\n> two');
check('consecutive quote lines merge', quote.length === 1 && quote[0].type === 'quote');
check('a quote drops the markers', plain('> one\n> two') === 'one\ntwo');

// --- Inline emphasis ---
check('bold is applied', styled('a **b** c', 'bold', 'b'));
check('asterisk italics are applied', styled('*x*', 'italic', 'x'));
check('underscore italics are applied', styled('_x_', 'italic', 'x'));
check('underscore italics ignore words', plain('snake_case_name') === 'snake_case_name');
check('underline is applied', styled('__x__', 'underline', 'x'));
check('strikethrough is applied', styled('~~x~~', 'strike', 'x'));
check('spoilers are applied', styled('||x||', 'spoiler', 'x'));
check('triple stars are bold and italic', styled('***x***', 'bold', 'x') && styled('***x***', 'italic', 'x'));
check('triple stars leave no stray star', plain('***x***') === 'x');
check('triple underscores are bold and italic', styled('___x___', 'bold', 'x') && styled('___x___', 'italic', 'x'));

const nested = inline('**a *b* c**');
check(
  'emphasis nests',
  nested.some((segment) => segment.value === 'a ' && segment.styles?.bold && !segment.styles?.italic) &&
    nested.some((segment) => segment.value === 'b' && segment.styles?.bold && segment.styles?.italic),
);

check('inline code is literal', inline('`**x**`').some((segment) => segment.type === 'code' && segment.value === '**x**'));
check('backslash escapes markdown', plain('\\*x\\*') === '*x*');

// --- Links ---
check('bare urls become links', inline('see https://example.com/a').some((segment) => segment.type === 'link' && segment.href === 'https://example.com/a'));
check('trailing punctuation is left in the text', plain('see https://example.com/a.') === 'see https://example.com/a.');
check(
  'a url keeps its own parentheses',
  inline('https://en.wikipedia.org/wiki/Foo_(bar)').some(
    (segment) => segment.type === 'link' && segment.href === 'https://en.wikipedia.org/wiki/Foo_(bar)',
  ),
);
check(
  'a wrapping parenthesis is dropped',
  inline('(https://example.com/a)').some((segment) => segment.type === 'link' && segment.href === 'https://example.com/a'),
);
check(
  'masked links keep their label',
  inline('[docs](https://example.com)').some(
    (segment) => segment.type === 'link' && segment.value === 'docs' && segment.noEmbed === true,
  ),
);
check(
  'angle links suppress embeds',
  inline('<https://example.com>').some((segment) => segment.type === 'link' && segment.noEmbed === true),
);
check(
  'a bare link may be embedded',
  inline('https://example.com').every((segment) => segment.type !== 'link' || segment.noEmbed !== true),
);
check('javascript urls are never linked', inline('javascript:alert(1)').every((segment) => segment.type !== 'link'));
check(
  'a bare url leaves trailing stars to the text',
  inline('https://x.com**').some((segment) => segment.type === 'link' && segment.href === 'https://x.com') &&
    plain('https://x.com**') === 'https://x.com**',
);
check(
  'a masked link keeps balanced parentheses in its url',
  plain('[x](https://example.com/Foo_(bar))') === 'x' &&
    inline('[x](https://example.com/Foo_(bar))').some(
      (segment) => segment.type === 'link' && segment.href === 'https://example.com/Foo_(bar)',
    ),
);
check('emphasis inside a link label is parsed', styled('[**b**](https://example.com)', 'bold', 'b'));
check('italics inside a link label are parsed', styled('[*i*](https://example.com)', 'italic', 'i'));
check(
  'code inside a link label loses its backticks',
  inline('[`x`](https://example.com)').some((segment) => segment.type === 'link' && segment.value === 'x'),
);

// --- Emoji and mentions ---
const emoji = new Map([['YES', { id: 'e1', name: 'YES', hash: 'h', animated: false }]]);
check(
  'a known emoji resolves',
  inline('hi :YES: there', emoji).some((segment) => segment.type === 'emoji' && segment.emoji.id === 'e1'),
);
check('emoji names are case-sensitive', plain(':yes:', emoji) === ':yes:');
check('an unknown emoji stays literal', plain(':nope:', emoji) === ':nope:');

const alice = { id: 'u1', username: 'alice' };
const mentionOf = (name) => (name.toLowerCase() === 'alice' ? alice : undefined);
check('a mention resolves', inline('hey @alice', noEmoji, mentionOf).some((segment) => segment.type === 'mention'));
check('an unknown mention stays literal', plain('hey @bob', noEmoji, mentionOf) === 'hey @bob');
check(
  'reserved mentions stay literal',
  inline('@everyone', noEmoji, () => alice).every((segment) => segment.type !== 'mention'),
);
check('an email is not a mention', plain('me@example.com', noEmoji, mentionOf) === 'me@example.com');
check('a url is not mistaken for an emoji or mention', inline('https://x.com/:YES:').some((segment) => segment.type === 'link'));

// --- Channel references ---
// A channel name may contain a space, so a reference is resolved against the
// names that exist rather than matched by shape; longest wins.
const channels = [
  { id: 'c1', name: 'general' },
  { id: 'c2', name: 'Off Topic' },
  { id: 'c3', name: 'Off' },
  { id: 'c4', name: 'dev' },
];
const channelIn = (text) => inline(text, noEmoji, noMention, channels).find((segment) => segment.type === 'channel');

check('a channel reference resolves', channelIn('see #general now')?.channel.id === 'c1');
check('a channel reference is case-insensitive', channelIn('#GENERAL')?.channel.name === 'general');
check('a spaced channel name resolves whole', channelIn('in #Off Topic please')?.channel.id === 'c2');
check('the longest channel name wins', channelIn('#Off Topic')?.channel.id === 'c2');
check('a short name still works on its own', channelIn('#Off')?.channel.id === 'c3');
check('a name running into a word is not a reference', channelIn('#generalissimo') === undefined);
check('an unknown channel stays literal', plain('see #nope', noEmoji, noMention, channels) === 'see #nope');
check('a mid-word hash is not a reference', channelIn('issue#42') === undefined);
check(
  'a channel name ends at a word boundary',
  inline('#chanx', noEmoji, noMention, [{ id: 'c9', name: 'chan' }]).every((segment) => segment.type !== 'channel'),
);
// The `#` (like a mention's `@`) is added at render, so rebuild it to compare.
const rendered = (text) =>
  inline(text, noEmoji, noMention, channels)
    .map((segment) => (segment.type === 'channel' ? `#${segment.value}` : segment.value))
    .join('');
check('a channel reference keeps its text', rendered('see #general now') === 'see #general now');
check(
  'a channel reference inside code is literal',
  inline('`#general`', noEmoji, noMention, channels).every((segment) => segment.type !== 'channel'),
);

check('matchChannelName is case-insensitive', matchChannelName('GENERAL rest', ['general']) === 'general');
check('matchChannelName needs a boundary', matchChannelName('generalx', ['general']) === null);
check('matchChannelName prefers the longest', matchChannelName('Off Topic', ['Off', 'Off Topic']) === 'Off Topic');
check('rewriting maps a known name', rewriteChannelMentions('go #general now', ['general'], () => '<#123>') === 'go <#123> now');
check('rewriting leaves an unknown name', rewriteChannelMentions('go #nope now', ['general'], () => '<#123>') === 'go #nope now');
check('rewriting leaves a mid-word hash', rewriteChannelMentions('a#general', ['general'], () => 'X') === 'a#general');

// --- Lists ---
const bullets = parse('- one\n- two');
check('dash lines make a bulleted list', bullets.length === 1 && bullets[0].type === 'list' && !bullets[0].ordered);
check('each line is an item', bullets[0].items.length === 2);
check('star bullets work too', parse('* one\n* two')[0]?.type === 'list');

const tree = parse('- a\n  - b\n    - c\n- d')[0];
check('the top of a nested list keeps its own items', tree.items.map((item) => item.segments[0].value).join() === 'a,d');
check('two spaces nest an item under the one above', tree.items[0].children[0]?.items[0]?.segments[0]?.value === 'b');
check('nesting goes deeper with more indent', tree.items[0].children[0].items[0].children[0]?.items[0]?.segments[0]?.value === 'c');
check('one space is not enough to nest', parse('- a\n - b')[0].items.length === 2);

const numbered = parse('3. three\n4. four');
check('a numbered list is ordered', numbered[0].type === 'list' && numbered[0].ordered);
check('a numbered list starts at its first number', numbered[0].start === 3 && numbered[0].items.length === 2);
const mixed = parse('1. a\n   - b')[0];
check('a bulleted list can nest under a numbered one', mixed.ordered && mixed.items[0].children[0]?.ordered === false);
check('switching between bullets and numbers starts a new list', parse('- a\n1. b').length === 2);
check('a line without a marker ends the list', parse('- a\nafter').map((block) => block.type).join() === 'list,paragraph');
check('an indented line carries on the item', plain('- a\n  more') === 'a\nmore' && parse('- a\n  more').length === 1);

const richItem = inline('- **bold** for @alice', noEmoji, (name) => (name === 'alice' ? { id: 'u1', username: 'alice' } : undefined));
check('an item keeps its inline formatting', richItem.some((segment) => segment.styles?.bold && segment.value === 'bold'));
check('an item can mention someone', richItem.some((segment) => segment.type === 'mention'));
check(
  'a mention inside a nested item still counts as one',
  mentionsUser({ id: 'm', content: '- x\n  - hey @alice' }, 'u1', (name) => (name === 'alice' ? { id: 'u1' } : undefined)),
);
check(
  'a link in an item is a link',
  inline('- see https://example.com/a').some((segment) => segment.type === 'link' && segment.href === 'https://example.com/a'),
);
check('a link in an item can still unfurl', listEmbeddableUrls('- see https://example.com/a').includes('https://example.com/a'));

// What looks a little like a list but is not one.
check('a minus sign is not a bullet', parse('-5 degrees')[0].type === 'paragraph' && plain('-5 degrees') === '-5 degrees');
check('a decimal is not a numbered item', parse('1.5 liters')[0].type === 'paragraph');
check('a lone dash is just a dash', parse('-')[0].type === 'paragraph');
check('stars hugging a word are italics, not a bullet', styled('*shrug*', 'italic', 'shrug'));
check('stars with spaces inside are arithmetic', plain('2 * 3 * 4') === '2 * 3 * 4' && !inline('2 * 3 * 4').some((segment) => segment.styles?.italic));

// --- Quotes, headers and subtext ---
const rest = parse('before\n>>> a\nb\n\nc');
check('>>> quotes the rest of the message', rest.length === 2 && rest[1].type === 'quote');
check('>>> keeps every line after it', inlineSegmentsOf(rest[1].blocks).map((segment) => segment.value).join('') === 'a\nb\n\nc');
check('a quote line needs its space', parse('>.<')[0].type === 'paragraph' && parse('>>>')[0].type === 'paragraph');
check('a single quote ends with its last marked line', parse('> a\nb').map((block) => block.type).join() === 'quote,paragraph');
check('a quote can hold a list', parse('> - a\n> - b')[0].blocks[0]?.type === 'list');
check('quotes do not nest', parse('> > a')[0].blocks[0]?.type === 'paragraph');

check('subtext is its own block', parse('-# small print')[0].type === 'subtext' && plain('-# small print') === 'small print');
check('subtext needs its space', parse('-#tag')[0].type === 'paragraph');
check('a level 3 header is detected', parse('### Title')[0].type === 'header' && parse('### Title')[0].level === 3);
check('four hashes are not a header', parse('#### Title')[0].type === 'paragraph');
check('a header needs its space', parse('#Title')[0].type === 'paragraph');
check('a header needs a title', parse('# ')[0].type === 'paragraph');

// --- Escaping ---
check('escaped stars are literal', plain('\\*not italic\\*') === '*not italic*' && !inline('\\*not italic\\*').some((segment) => segment.styles?.italic));
check('an escaped dash is not a bullet', parse('\\- not a list')[0].type === 'paragraph' && plain('\\- not a list') === '- not a list');
check('an escaped hash is not a header', parse('\\# not a header')[0].type === 'paragraph');
check('an escaped number is not an item', plain('1\\. not a list') === '1. not a list' && parse('1\\. not a list')[0].type === 'paragraph');
check('an escaped mention stays text', inline('\\@alice', noEmoji, mentionOf).every((segment) => segment.type !== 'mention'));
check('an escaped emoji stays text', plain('\\:YES:', emoji) === ':YES:');
check('a backslash can escape itself', plain('\\\\') === '\\');
check('a backslash before a letter is kept', plain('C:\\Users') === 'C:\\Users');

// --- Timestamps ---
const stamp = (text) => inline(text).find((segment) => segment.type === 'timestamp');
check('a timestamp is recognised', stamp('at <t:1700000000>')?.epochMs === 1_700_000_000_000);
check('a timestamp without a style uses f', stamp('<t:1700000000>')?.style === 'f');
check('a timestamp keeps its style', stamp('<t:1700000000:R>')?.style === 'R');
check('an unknown style stays as written', stamp('<t:1700000000:X>') === undefined && plain('<t:1700000000:X>') === '<t:1700000000:X>');
check('an escaped timestamp stays as written', stamp('\\<t:1700000000>') === undefined);
check('a moment past what a date holds stays as written', stamp('<t:9999999999999>') === undefined);

const utc = { locale: 'en-US', timeZone: 'UTC' };
check('t is a short time', /^12:00\sAM$/.test(formatTimestamp(0, 't', utc)));
check('T is a long time', /^12:00:00\sAM$/.test(formatTimestamp(0, 'T', utc)));
check('d is a short date', formatTimestamp(0, 'd', utc) === '01/01/1970');
check('D is a long date', formatTimestamp(0, 'D', utc) === 'January 1, 1970');
check('f is a date and time', /^January 1, 1970( at|,) 12:00\sAM$/.test(formatTimestamp(0, 'f', utc)));
check('F adds the weekday', formatTimestamp(0, 'F', utc).startsWith('Thursday, January 1, 1970'));
check('the tooltip is the full date', formatTimestampTitle(0, utc) === formatTimestamp(0, 'F', utc));
const hour = 60 * 60 * 1000;
check('R reads ahead', formatTimestamp(10 * hour, 'R', { now: 7 * hour, locale: 'en-US' }) === 'in 3 hours');
check('R reads behind', formatTimestamp(0, 'R', { now: 50 * hour, locale: 'en-US' }) === '2 days ago');

// --- Writing timestamps ---
// "Now" is pinned to Wednesday 24 December 2025, 15:00 UTC, and the zone to UTC,
// so every expression has one right answer.
const writeNow = Date.UTC(2025, 11, 24, 15, 0, 0);
const gb = { now: writeNow, locale: 'en-GB', timeZone: 'UTC' };
const us = { ...gb, locale: 'en-US' };
const at = (text, options = gb) => parseTimeExpression(text, options);
const iso = (text, options = gb) => {
  const moment = at(text, options);
  return moment ? new Date(moment.epochMs).toISOString().slice(0, 16) : null;
};
check('@5pm is today while ahead', iso('5pm') === '2025-12-24T17:00');
check('@17:30 is today while ahead', iso('17:30') === '2025-12-24T17:30');
check('@5:30pm reads the minutes', iso('5:30pm') === '2025-12-24T17:30');
check('@5 pm may have a space', iso('5 pm') === '2025-12-24T17:00');
check('@2pm has passed, so it is tomorrow', iso('2pm') === '2025-12-25T14:00');
check('@5pm after 5pm is tomorrow', iso('5pm', { ...gb, now: Date.UTC(2025, 11, 24, 17, 30) }) === '2025-12-25T17:00');
check('@5pm at exactly 5pm is tomorrow', iso('5pm', { ...gb, now: Date.UTC(2025, 11, 24, 17, 0) }) === '2025-12-25T17:00');
check('@12am is midnight', iso('12am') === '2025-12-25T00:00');
check('@noon is midday', iso('noon') === '2025-12-25T12:00');
check('@tomorrow keeps the time of day', iso('tomorrow') === '2025-12-25T15:00');
check('@tomorrow 18:00', iso('tomorrow 18:00') === '2025-12-25T18:00');
check('@tomorrow at 6pm', iso('tomorrow at 6pm') === '2025-12-25T18:00');
check('@tomorrow 18 takes the bare hour', iso('tomorrow 18') === '2025-12-25T18:00');
check('@monday 9am is the coming Monday', iso('monday 9am') === '2025-12-29T09:00');
check('@mon 9am takes the short name', iso('mon 9am') === '2025-12-29T09:00');
check('@wed 4pm on a Wednesday is today', iso('wed 4pm') === '2025-12-24T16:00');
check('@wed 9am on a Wednesday is next week', iso('wed 9am') === '2025-12-31T09:00');
check('@wednesday on a Wednesday is next week', iso('wednesday') === '2025-12-31T15:00');
check('@in 2h', iso('in 2h') === '2025-12-24T17:00');
check('@in 30 minutes', iso('in 30 minutes') === '2025-12-24T15:30');
check('@in 3 days', iso('in 3 days') === '2025-12-27T15:00');
check('@in an hour', iso('in an hour') === '2025-12-24T16:00');
check('@2025-12-24 20:00', iso('2025-12-24 20:00') === '2025-12-24T20:00');
check('@2025-12-24 keeps the time of day', iso('2025-12-24') === '2025-12-24T15:00');
check('@24/12 20:00 reads day first in en-GB', iso('24/12 20:00') === '2025-12-24T20:00');
check('@12/24 20:00 reads month first in en-US', iso('12/24 20:00', us) === '2025-12-24T20:00');
check('@01/02 follows the locale', iso('01/02 10:00') === '2026-02-01T10:00' && iso('01/02 10:00', us) === '2026-01-02T10:00');
check('@24/12 is still a date in en-US', iso('24/12 20:00', us) === '2025-12-24T20:00');
check('@24.12.2026 takes a year', iso('24.12.2026 20:00') === '2026-12-24T20:00');
check('@24/12 9am has passed, so next year', iso('24/12 9am') === '2026-12-24T09:00');
check('@24/12 alone is today', iso('24/12') === '2025-12-24T15:00');
check('@29/02 waits for a leap year', iso('29/02') === '2028-02-29T15:00');
check('@now is now', at('now')?.epochMs === writeNow && at('now')?.kind === 'now');
check('@NOW ignores case', at('NOW')?.epochMs === writeNow);
check('now is counted from a whole second', at('now', { ...gb, now: writeNow + 999 })?.epochMs === writeNow);
check('@14:00 is read in the given zone', iso('14:00', { ...gb, timeZone: 'America/New_York' }) === '2025-12-24T19:00');
for (const nonsense of ['25:00', '24:00', '17:60', '13pm', '0pm', 'in 0h', 'in 2 parsecs', '31/02', '2025-13-01', 'tom', 'tomo', '17', 'bob', 'tomorrow bob', '']) {
  check(`@${nonsense} is not a time`, at(nonsense) === null);
}
check('the leading style suits what was typed', [
  ['5pm', 't'],
  ['tomorrow', 'D'],
  ['tomorrow 18:00', 'f'],
  ['in 2h', 'R'],
  ['now', 'f'],
].every(([text, style]) => timestampChoices(at(text), gb)[0].style === style));
const choices = timestampChoices(at('5pm'), gb);
check('every style is offered once', choices.map((choice) => choice.style).sort().join('') === 'DFRTdft');
check('a time-only preview names the day', choices.find((choice) => choice.style === 't').preview === 'Today at 17:00');
check('a time tomorrow says so', timestampChoices(at('2pm'), gb)[0].preview === 'Tomorrow at 14:00');
check('a time further out names the weekday', timestampChoices(at('monday 9am'), gb).find((c) => c.style === 't').preview === 'Monday at 9:00');
check('the full preview has the weekday', choices.find((choice) => choice.style === 'F').preview.startsWith('Wednesday, 24 December 2025'));
check('the relative preview counts from now', choices.find((choice) => choice.style === 'R').preview === 'in 2 hours');
check('the inserted token is <t:seconds:style>', choices[0].token === '<t:1766595600:t>');
check('the token holds whole seconds', timestampToken(1_766_595_600_999, 'R') === '<t:1766595600:R>');
const written = inline(`see you ${choices[0].token}`).find((segment) => segment.type === 'timestamp');
check('a written token renders as a timestamp', written?.epochMs === 1_766_595_600_000 && written.style === 't');
check('en-GB writes the day first', dayFirst('en-GB') && !dayFirst('en-US'));
check('the picker fields show the moment', JSON.stringify(toDateTimeInputs(writeNow, 'UTC')) === '{"date":"2025-12-24","time":"15:00"}');
check('the picker fields round-trip', fromDateTimeInputs('2025-12-24', '15:00', 'UTC') === writeNow);
check('the picker fields read the zone', fromDateTimeInputs('2025-12-24', '14:00', 'America/New_York') === Date.UTC(2025, 11, 24, 19));
check('an incomplete picker field is no moment', fromDateTimeInputs('', '15:00', 'UTC') === null);

// --- Code blocks ---
check('a code block keeps its language', parse('```python\nprint(1)\n```')[0].language === 'python');
check('a code block may close at the end of its last line', parse('```js\nfoo()```\nafter').map((block) => block.type).join() === 'code,paragraph');
check('a closing fence on the last line keeps that line', parse('```js\nfoo()```')[0].text === 'foo()');
check('a code block may sit on one line', parse('```x = 1```')[0].type === 'code' && parse('```x = 1```')[0].text === 'x = 1');
check('markdown inside code is literal', parse('```\n- a\n# b\n```').length === 1);

// The highlighter's output goes into the page as markup, so it must escape the
// code it is given; this is what makes that safe. Run every hostile payload
// through every registered language, so the whole {@html} surface is held to the
// claim rather than a single language that happens to escape well.
const hostileSources = [
  '<img src=x onerror="alert(1)"> & </code><script>',
  '"><svg onload=alert(1)>',
  "'; alert(1) //",
  '<a href="javascript:alert(1)">link</a>',
];
for (const language of HIGHLIGHT_LANGUAGES) {
  for (const source of hostileSources) {
    const hostile = highlight(source, language);
    check(
      `highlighted ${language} code is escaped`,
      hostile !== null && !hostile.includes('<img') && !hostile.includes('<script') && !hostile.includes('<svg'),
    );
    check(
      `highlighting ${language} adds only its own spans`,
      hostile !== null &&
        hostile
          .replace(/<span class="(?:hljs-[a-z0-9_ .-]+|language-[a-z0-9_ .-]+)">|<\/span>/g, '')
          .search(/[<>]/) === -1,
    );
  }
}
check('a language alias resolves', highlight('const a = 1;', 'js')?.includes('hljs-keyword'));
check('a language name ignores case', highlight('x = 1', 'Python') !== null);
check('an unknown language is left plain', highlight('x', 'brainfudge') === null);

// --- Catching up after being away ---
// A stand-in shape: mergeLatest compares ids and timestamps and copies
// references. A numeric id doubles as its second of the minute, so the order of
// the ids is the order in time.
const message = (id, extra = {}) => ({
  id,
  channelId: 'c1',
  content: id,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Number(id) || 0)).toISOString(),
  ...extra,
});
const ids = (result) => result.messages.map((entry) => entry.id).join(',');
const list = (...names) => names.map((name) => message(name));

check(
  'a catch-up page is appended in the order the server sent it',
  ids(mergeLatest(list('1', '2'), list('2', '3', '4'), false)) === '1,2,3,4',
);
check(
  'a message already loaded is refreshed rather than duplicated',
  mergeLatest([message('1', { content: 'old' })], [message('1', { content: 'edited' })], true).messages[0]
    ?.content === 'edited',
);
check(
  'older pages outside the fresh page are kept as they were',
  ids(mergeLatest(list('1', '2', '3'), list('2', '3', '4'), false)) === '1,2,3,4',
);
check(
  'a message deleted while away is dropped from the range the page covers',
  ids(mergeLatest(list('1', '2', '3', '4'), list('2', '4', '5'), false)) === '1,2,4,5',
);
check(
  'a message that arrived after the page was fetched is kept',
  ids(mergeLatest(list('1', '2', '9'), list('2', '3'), false)) === '1,2,3,9',
);
check(
  'a message sharing the page’s oldest millisecond is not taken for deleted',
  ids(
    mergeLatest(
      [message('a', { createdAt: message('2').createdAt }), message('2')],
      [message('2'), message('3')],
      false,
    ),
  ) === 'a,2,3',
);
const gap = mergeLatest(list('1', '2'), list('5', '6', '7'), false);
check(
  'a page that does not reach what is loaded replaces it instead of hiding the gap',
  ids(gap) === '5,6,7' && gap.reset === true,
);
check(
  'an overlapping page keeps the older history reachable',
  mergeLatest(list('1', '2'), list('2', '3'), false).reset === false,
);
const whole = mergeLatest(list('1', '2', '3'), list('3'), true);
check('a complete page is the whole channel', ids(whole) === '3' && whole.reset === true);
check('catching up on an empty channel loads the page', ids(mergeLatest([], list('1'), true)) === '1');
check('an empty catch-up page means the channel was emptied', mergeLatest(list('1'), [], true).messages.length === 0);

// --- Whether a message is aimed at you ---
// This decides the louder notification sound, so it is worth being exact about.
check('naming you counts', mentionsUser(message('1', { content: 'hey @alice' }), 'u1', mentionOf));
check('naming somebody else does not', !mentionsUser(message('1', { content: 'hey @bob' }), 'u1', mentionOf));
check(
  'a reply to you counts even without your name',
  mentionsUser(message('1', { content: 'sure', replyTo: { author: alice } }), 'u1', mentionOf),
);
check(
  'a reply to somebody else does not',
  !mentionsUser(message('1', { content: 'sure', replyTo: { author: { id: 'u2' } } }), 'u1', mentionOf),
);
check(
  'your name in a code block is a quotation, not a mention',
  !mentionsUser(message('1', { content: '```\n@alice\n```' }), 'u1', mentionOf),
);
check('a reserved mention is never yours', !mentionsUser(message('1', { content: '@everyone' }), 'u1', mentionOf));
check('an ordinary message is not a mention', !mentionsUser(message('1', { content: 'good morning' }), 'u1', mentionOf));

// --- Searching the emoji picker ---
const named = [{ name: 'YES' }, { name: 'No' }, { name: 'yes_animated' }];

check('an empty search keeps everything', filterByName(named, '').length === 3);
check('a search ignores case', filterByName(named, 'yes').length === 2);
check('a search matches anywhere in the name', filterByName(named, 'anim').length === 1);
check('a search trims the space around it', filterByName(named, '  no  ').length === 1);
check('a search matching nothing returns nothing', filterByName(named, 'zzz').length === 0);

const searchable = [
  { name: 'Smileys & Emotion', emojis: [{ name: 'grinning face' }, { name: 'joy' }] },
  { name: 'Animals & Nature', emojis: [{ name: 'dog face' }] },
];
check('a search narrows the emoji inside each group', filterUnicodeGroups(searchable, 'face').length === 2);
check('a search drops the groups left with no match', filterUnicodeGroups(searchable, 'dog').length === 1);
check('a search matching nothing leaves no groups', filterUnicodeGroups(searchable, 'zzz').length === 0);
check('an empty search keeps every group intact', filterUnicodeGroups(searchable, '').length === 2);

// --- The unicode emoji data ---
// Read straight from the package, since the client reaches it through a
// bundler-only dynamic import that plain Node cannot perform. This guards the
// shape the picker relies on, which a package upgrade could otherwise change
// into an empty list with no error anywhere.
const emojiData = JSON.parse(
  readFileSync(require.resolve('unicode-emoji-json/data-by-group.json'), 'utf8'),
);

check('the unicode emoji data arrives as groups', Array.isArray(emojiData) && emojiData.length > 0);
check(
  'every group names itself and holds emoji that have names',
  emojiData.every(
    (group) =>
      typeof group.name === 'string' &&
      group.name.length > 0 &&
      Array.isArray(group.emojis) &&
      group.emojis.length > 0 &&
      group.emojis.every((emoji) => typeof emoji.emoji === 'string' && typeof emoji.name === 'string'),
  ),
);

const emojiCount = emojiData.reduce((total, group) => total + group.emojis.length, 0);
check('the set is the whole range rather than a sample', emojiCount > 1000, `${emojiCount} emoji`);
check(
  'a known emoji can be found by name',
  filterByName(
    emojiData.flatMap((group) => group.emojis),
    'waving hand',
  ).some((emoji) => emoji.emoji === '👋'),
);

// --- Quick switcher matching ---
check('an exact name beats a prefix', matchScore('general', 'general') > matchScore('general', 'general-chat'));
check('a prefix beats a word inside the name', matchScore('gen', 'general') > matchScore('gen', 'off-topic-gen'));
check(
  'a word inside the name beats a bare substring',
  matchScore('chat', 'general-chat') > matchScore('hat', 'general-chat'),
);
check('initials find a hyphenated name', matchScore('gc', 'general-chat') !== null);
check('letters in order still match', matchScore('gnrl', 'general') !== null);
check('letters out of order do not', matchScore('lrng', 'general') === null);
check('matching ignores case', matchScore('GEN', 'general') === matchScore('gen', 'general'));
check('a space can stand in for a hyphen', matchScore('general chat', 'general-chat') !== null);
check('separators alone match nothing', matchScore('--', 'general') === null);
check('a shorter name wins a tie', matchScore('dev', 'devops') > matchScore('dev', 'developers'));

// --- Sidebar order and the channel arrows ---
const switchCategories = [
  { id: 'cat-b', name: 'Games' },
  { id: 'cat-a', name: 'Text' },
];
const switchChannels = [
  { id: 'loose', name: 'lobby', categoryId: null },
  { id: 'gen', name: 'general', categoryId: 'cat-a' },
  { id: 'mc', name: 'minecraft', categoryId: 'cat-b' },
  { id: 'off', name: 'off-topic', categoryId: 'cat-a' },
  { id: 'orphan', name: 'ghost', categoryId: 'cat-gone' },
];
const switchOrder = sidebarOrder(switchCategories, switchChannels).map((channel) => channel.id);
check('sidebar order follows categories, then uncategorised channels', switchOrder.join(',') === 'mc,gen,off,loose');
check('a channel in an unknown category is left out, as the sidebar does', !switchOrder.includes('orphan'));
check('down moves to the next channel', stepChannel(switchOrder, 'gen', 1) === 'off');
check('up moves to the previous channel', stepChannel(switchOrder, 'gen', -1) === 'mc');
check('down from the last channel wraps to the first', stepChannel(switchOrder, 'loose', 1) === 'mc');
check('up from the first channel wraps to the last', stepChannel(switchOrder, 'mc', -1) === 'loose');
check('with nothing open, down starts at the top', stepChannel(switchOrder, null, 1) === 'mc');
check('with nothing open, up starts at the bottom', stepChannel(switchOrder, null, -1) === 'loose');
check('a lone channel has nowhere to go', stepChannel(['only'], 'only', 1) === null);
check('no channels means no step', stepChannel([], null, 1) === null);
const unreadOnly = (id) => id === 'loose' || id === 'gen';
check('the unread arrow skips read channels', stepChannel(switchOrder, 'mc', 1, unreadOnly) === 'gen');
check('the unread arrow goes up too', stepChannel(switchOrder, 'off', -1, unreadOnly) === 'gen');
check('the unread arrow wraps past the end', stepChannel(switchOrder, 'loose', 1, unreadOnly) === 'gen');
check(
  'the unread arrow never lands on the open channel',
  stepChannel(switchOrder, 'gen', 1, (id) => id === 'gen') === null,
);

// --- Quick switcher ranking ---
const switchMembers = [
  { id: 'u1', username: 'genevieve', displayName: null },
  { id: 'u2', username: 'bob', displayName: 'Minecraft Bob' },
];
const rank = (query, extra = {}) =>
  rankSwitcher({
    query,
    categories: switchCategories,
    channels: switchChannels,
    members: switchMembers,
    recentChannelIds: [],
    activeChannelId: null,
    ...extra,
  });
const rowIds = (rows) => rows.map((row) => `${row.kind}:${row.id}`).join(',');

check(
  'an empty query lists channels alone, in sidebar order',
  rowIds(rank('')) === 'channel:mc,channel:gen,channel:off,channel:loose',
);
check(
  'an empty query puts recent channels first and the open one last',
  rowIds(rank('', { recentChannelIds: ['gen', 'loose', 'off'], activeChannelId: 'gen' })) ===
    'channel:loose,channel:off,channel:mc,channel:gen',
);
check('a query finds channels and members alike', rowIds(rank('gen')) === 'channel:gen,member:u1');
check('a channel carries its category name', rank('minec')[0].category === 'Games');
check('an uncategorised channel has no category', rank('lobby')[0].category === null);
check('a member is found by username', rowIds(rank('bob')) === 'member:u2');
check('a member is found by display name', rowIds(rank('minecraft b')) === 'member:u2');
check('a channel ranks ahead of a member matching as well', rowIds(rank('minecraft')) === 'channel:mc,member:u2');
check('a leading # keeps to channels', rowIds(rank('#minecraft')) === 'channel:mc');
check('a leading @ keeps to members', rowIds(rank('@minecraft')) === 'member:u2');
check('a bare @ lists the members so they can be browsed', rowIds(rank('@')) === 'member:u1,member:u2');
check('a bare # lists channels as an empty query does', rowIds(rank('#')) === rowIds(rank('')));
const twins = [
  { id: 'red', name: 'team-red', categoryId: null },
  { id: 'blu', name: 'team-blu', categoryId: null },
];
check(
  'a tie between equal matches keeps sidebar order',
  rowIds(rank('team', { channels: twins })) === 'channel:red,channel:blu',
);
check(
  'recency breaks a tie between equal matches',
  rowIds(rank('team', { channels: twins, recentChannelIds: ['blu'] })) === 'channel:blu,channel:red',
);
check('the result list is capped', rank('', { limit: 2 }).length === 2);
check('a query matching nothing lists nothing', rank('zzz').length === 0);

// --- Unread tab title and app badge ---
check('nothing unread shows the bare name', unreadTitle('Harmony', 0, 0) === 'Harmony');
check('unread without mentions shows a dot', unreadTitle('Harmony', 0, 3) === '• Harmony');
check('mentions show how many are waiting', unreadTitle('Harmony', 2, 5) === '(2) Harmony');
check('the app badge is a number for mentions', unreadBadge(2, 5) === 2);
check('the app badge is a dot for plain unread', unreadBadge(0, 1) === 'dot');
check('the app badge clears when all is read', unreadBadge(0, 0) === null);

// --- Unread totals with mutes and notification levels ---
{
  const listed = [{ id: 'loud' }, { id: 'hushed' }, { id: 'silent' }, { id: 'pinged' }];
  const settings = {
    loud: { muted: false, level: 'all' },
    hushed: { muted: true, level: 'all' },
    silent: { muted: false, level: 'nothing' },
    pinged: { muted: true, level: 'mentions' },
  };
  const summary = (unread, counts) =>
    unreadSummary(listed, new Set(unread), counts, (channel) => settings[channel.id]);
  const quietOnly = summary(['hushed'], {});
  check('a muted channel adds nothing to the title', quietOnly.unread === 0 && quietOnly.mentions === 0);
  check('nor does the title mark it', unreadTitle('Harmony', quietOnly.mentions, quietOnly.unread) === 'Harmony');
  const both = summary(['loud', 'hushed'], {});
  check('an unmuted unread channel still counts', both.unread === 1 && unreadBadge(both.mentions, both.unread) === 'dot');
  const mentioned = summary(['pinged', 'silent'], { pinged: 3, silent: 4 });
  check(
    'mentions in a muted channel still count, but not where nothing is wanted',
    mentioned.mentions === 3 && mentioned.unread === 2,
  );
  check('the title counts mentions, not channels', unreadTitle('Harmony', 7, 2) === '(7) Harmony');
  check(
    'a channel that is no longer listed counts for nothing',
    summary(['gone'], { gone: 2 }).mentions === 0 && summary(['gone'], { gone: 2 }).unread === 0,
  );
}

// --- Mute and notification settings, with category inheritance ---
{
  const now = Date.parse('2026-01-01T12:00:00Z');
  const later = '2026-01-01T13:00:00.000Z';
  const sooner = '2026-01-01T12:30:00.000Z';
  const past = '2026-01-01T11:00:00.000Z';
  const setting = (fields) => ({ targetId: 'x', targetType: 'channel', muted: false, muteEndsAt: null, level: 'default', ...fields });

  const plain = resolveChannelSettings(undefined, undefined, now);
  check('no settings means unmuted and all messages', !plain.muted && plain.level === 'all');
  check(
    'a channel inherits its category level',
    resolveChannelSettings(undefined, setting({ level: 'mentions' }), now).level === 'mentions',
  );
  check(
    'a channel level beats its category',
    resolveChannelSettings(setting({ level: 'all' }), setting({ level: 'nothing' }), now).level === 'all',
  );
  check(
    'a category left on default falls back to the server default',
    resolveChannelSettings(setting({ level: 'default' }), setting({ level: 'default' }), now).level === 'all',
  );
  const byCategory = resolveChannelSettings(undefined, setting({ muted: true, muteEndsAt: later }), now);
  check(
    'a muted category mutes its channels',
    byCategory.muted && byCategory.mutedByCategory && byCategory.muteEndsAt === later,
  );
  check('an expired mute is no mute', !resolveChannelSettings(setting({ muted: true, muteEndsAt: past }), undefined, now).muted);
  check('a mute lifts exactly at its end', !isMuteActive({ muted: true, muteEndsAt: sooner }, Date.parse(sooner)));
  check('a mute without an end lasts', isMuteActive({ muted: true, muteEndsAt: null }, now + 1e12));
  const both = resolveChannelSettings(
    setting({ muted: true, muteEndsAt: sooner }),
    setting({ muted: true, muteEndsAt: later }),
    now,
  );
  check('with both muted the later end wins', both.muted && !both.mutedByCategory && both.muteEndsAt === later);
  check(
    'and a mute with no end beats any end',
    resolveChannelSettings(setting({ muted: true, muteEndsAt: sooner }), setting({ muted: true }), now).muteEndsAt === null,
  );
  check(
    'the next expiry is the soonest one still ahead',
    nextMuteExpiry(
      [
        { muted: true, muteEndsAt: later },
        { muted: true, muteEndsAt: sooner },
        { muted: true, muteEndsAt: past },
        { muted: true, muteEndsAt: null },
        { muted: false, muteEndsAt: null },
      ],
      now,
    ) === Date.parse(sooner),
  );
  check('nothing to expire gives null', nextMuteExpiry([{ muted: true, muteEndsAt: null }], now) === null);
  check('the menus offer Discord\'s six mute lengths', MUTE_DURATIONS.map((d) => d.seconds).join() === '900,3600,10800,28800,86400,');
  check('a mute with no end says so', muteLabel(null) === 'Muted until you turn it back on');
  check('a mute ending today gives just a time', /^Muted until \d/.test(muteLabel(new Date(now + 60_000).toISOString(), now)));
}

// --- The "new" line and the bar above it ---
{
  const me = 'me';
  const at = (minute) => `2026-01-01T12:${String(minute).padStart(2, '0')}:00.000Z`;
  const msg = (id, minute, author = 'them') => ({ id, createdAt: at(minute), author: author === null ? null : { id: author } });
  const list = [msg('a', 1), msg('b', 2), msg('c', 3, me), msg('d', 4), msg('e', 5)];

  check('no marker, no line', firstUnreadIndex(list, null, me, true) === -1);
  check('the line goes above the first message after the marker', firstUnreadIndex(list, at(1), me, false) === 1);
  check('your own message never gets the line', firstUnreadIndex(list, at(2), me, false) === 3);
  check('a message from a deleted account still counts', firstUnreadIndex([msg('x', 1), msg('y', 2, null)], at(1), me, false) === 1);
  check('nothing newer, no line', firstUnreadIndex(list, at(5), me, false) === -1);
  check(
    'when older history is not loaded the line waits for it',
    firstUnreadIndex(list, at(0), me, false) === -1 && firstUnreadIndex(list, at(0), me, true) === 0,
  );
  const counted = newMessageCount(list, at(1), me, false);
  check('the bar counts new messages from others', counted.count === 3 && !counted.more);
  const partial = newMessageCount(list, at(0), me, false);
  check('and says "more" when the marker is beyond what is loaded', partial.count === 4 && partial.more);
  check('a whole channel loaded has no "more"', newMessageCount(list, at(0), me, true).more === false);
  const clock = () => '12:01';
  check('the bar reads naturally', newMessagesLabel(3, false, at(1), clock) === '3 new messages since 12:01');
  check('one message is singular', newMessagesLabel(1, false, at(1), clock) === '1 new message since 12:01');
  check('a partial count gets a plus', newMessagesLabel(50, true, at(1), clock) === '50+ new messages since 12:01');
  check('pills cap at 99+', pillCount(5) === '5' && pillCount(99) === '99' && pillCount(100) === '99+');
}

// --- Composer preview ---
{
  const lookup = new Map([['YES', { id: 'e1', name: 'YES', hash: 'h', animated: false }]]);
  const draft = (text, map = lookup) => draftPreview(text, map, noMention);
  const hasEmoji = (blocks) => blocks !== null && inlineSegmentsOf(blocks).some((segment) => segment.type === 'emoji');
  check('a known emoji gets a preview', hasEmoji(draft('hi :YES:')));
  check('plain text gets none', draft('hello world') === null);
  check('text with a colon but no emoji gets none', draft('see http://example.com at 3:4') === null);
  check('an unknown name gets none', draft(':NOPE:') === null);
  check('names are case sensitive', draft(':yes:') === null);
  check('no custom emoji at all gets none', draft(':YES:', new Map()) === null);
  check('an escaped shortcode gets none', draft('\\:YES:') === null);
  check('inside a code block gets none', draft('```\n:YES:\n```') === null);
  check('inside inline code gets none', draft('`:YES:`') === null);
  check('next to a link it still counts', hasEmoji(draft(':YES: https://example.com/a')));
  check('formatting is kept in the preview', hasEmoji(draft('**bold** :YES:')));
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
