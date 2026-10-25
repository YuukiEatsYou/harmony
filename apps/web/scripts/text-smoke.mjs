// Focused checks for the client's pure logic, the modules under apps/web/src/lib
// that touch no DOM and hold no state, so Node can import them straight:
//
// - message text: markdown, links, emoji, mentions and timestamps, and whether a
//   message is aimed at you;
// - reading a channel: catching up after being away, where the "new" line and
//   the new-messages bar land, jumping to any message and reading on from it,
//   marking unread, the dates beside messages and the lines between days;
// - finding things: the emoji picker, the quick switcher, the channel arrows,
//   the unread tab title and how mutes and category settings change it;
// - the composer: the time expressions it turns into timestamps, its
//   formatting keys and the Up arrow that edits your last message;
// - getting around: launch links (a notification tap or a deep link), going
//   back and forward between channels, and which keys the app-wide keyboard
//   layer takes and which it leaves alone;
// - what's new: the changelog and when its dialog shows;
// - loading: the panels fetched on first use, one reload for a burst of member
//   and role events, and the numbering that keeps an older answer from undoing a
//   newer one;
// - voice: the native host bridge (its off flag, the join and leave hand-off and
//   the call state it pushes back) and the per-member volume control (the clamp,
//   the stored map, deafen over volume, and the element and graph stages).
//
// Run with: npm run smoke:text
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  MUTE_DURATIONS,
  isMuteActive,
  isNewerVersion,
  listEmbeddableUrls,
  matchChannelName,
  nextMuteExpiry,
  parseVersionFile,
  resolveChannelSettings,
  rewriteChannelMentions,
  socialLink,
  validSocialValue,
} from '@harmony/shared';
import {
  POLL_LIMITS,
  applyPollUpdate,
  createPollSchema,
  isPollClosed,
  nextPollChoice,
  pollLeaders,
  pollPercent,
  pollTimeLeft,
} from '@harmony/shared';
import { createEventSchema, eventGroup, groupEvents, interestedLabel, updateEventSchema } from '@harmony/shared';
import {
  applyEventUpdate,
  describeEventTime,
  draftFromEvent,
  eventDraftProblem,
  eventStatusLabel,
  newEventDraft,
  removeEvent,
  reminderText,
  toCreateEventBody,
  toUpdateEventBody,
} from '../src/lib/event-form.ts';
import { HIGHLIGHT_LANGUAGES, highlight } from '../src/lib/highlighter.ts';
import { MAX_TAGS, formatTags, matchesServerGif, moveInOrder, orderCurated, parseTags, serverGifUrl } from '../src/lib/server-gifs.ts';
import { addServerGifSchema, updateServerGifSchema } from '@harmony/shared';
import { isJumbo, unicodeEmojiIn } from '../src/lib/jumbo-emoji.ts';
import {
  USAGE_CAP,
  USAGE_HALF_LIFE_MS,
  emojiInContent,
  parseUsage,
  rankEntries,
  recordUsage,
  resolveUsage,
  scoreAt,
} from '../src/lib/emoji-usage.ts';
import { gifCopyUrl, linkedGifSources } from '../src/lib/linked-gif.ts';
import { inlineSegmentsOf, parseMessage } from '../src/lib/message-text.ts';
import { MAX_DIFF_CHARS, diffWords } from '../src/lib/text-diff.ts';
import { mergeLatest, mentionsUser } from '../src/lib/messages.ts';
import { draftProblem, newPollDraft, toCreatePollBody, withAddedOption, withoutOption } from '../src/lib/poll-draft.ts';
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
import {
  defaultScheduleTime,
  describeSendTime,
  parseScheduleInput,
  removeScheduled,
  scheduleChoices,
  scheduleProblem,
  scheduledBadge,
  upsertScheduled,
} from '../src/lib/schedule-time.ts';
import {
  firstUnreadIndex,
  muteLabel,
  newMessageCount,
  newMessagesLabel,
  pillCount,
  withChannelReadState,
} from '../src/lib/unread.ts';
import { groupedRows, isGrouped } from '../src/lib/message-grouping.ts';
import { detectTrigger, rankMember, suggestionsFor } from '../src/lib/composer-suggest.ts';
import {
  HOST_VOICE_EVENT,
  HOST_VOICE_MAX_CHANNEL_NAME,
  HOST_VOICE_MAX_ID,
  HOST_VOICE_MAX_MEMBERS,
  HOST_VOICE_MAX_NAME,
  askHostToJoin,
  askHostToLeave,
  parseHostVoiceMessage,
  subscribeHostVoiceState,
  voiceHost,
  webVoiceDisabled,
} from '../src/lib/voice-mode.ts';
import { clampVolume, effectiveLevel, elementVolumeFor, graphGainFor, parseVolumes, serializeVolumes, volumeOverride, VOICE_VOLUME_DEFAULT, VOICE_VOLUME_MAX } from '../src/lib/voice-volume.ts';
import { formatTimestamp, formatTimestampTitle } from '../src/lib/timestamp.ts';
import { draftPreview } from '../src/lib/composer-preview.ts';
import { filterByName, filterUnicodeGroups } from '../src/lib/unicode-emoji.ts';
import {
  activeToken,
  applySuggestion,
  buildSearchParams,
  filterToken,
  mergeFilters,
  parseSearchDate,
  parseSearchInput,
  suggestFor,
} from '../src/lib/search-query.ts';
import { SLASH_COMMANDS, applySlashCommand, matchSlashCommands, slashQuery } from '../src/lib/slash-commands.ts';
import { mediaFilesFrom } from '../src/lib/files.ts';
import { hasLaunchTarget, messageLink, parseLaunchParams, withoutLaunchParams } from '../src/lib/launch-params.ts';
import { historyAroundSplit } from '@harmony/shared';
import { appendNewer, windowAround } from '../src/lib/history-window.ts';
import {
  clockTime,
  dayDividerLabel,
  dayKey,
  messageTimeLabel,
  messageTimeTitle,
  withDayStarts,
} from '../src/lib/message-time.ts';
import {
  mayCarryOn,
  mouseButtonStep,
  ownedBy,
  planOverlay,
  planVisit,
  popAction,
  readEntry,
  returnAfterClose,
  stepDirection,
  stepsOffMarker,
  writeEntry,
} from '../src/lib/channel-history.ts';
import {
  CHANGELOG,
  CHANGELOG_VERSION_PATTERN,
  HARMONY_VERSION,
  changelogSeenSchema,
  changelogToShow,
  latestChangelog,
} from '@harmony/shared';
import { changelogSeenKey, formatChangelogDate, newerSeen, planChangelog, readSeenMarker } from '../src/lib/changelog.ts';
import { globalShortcut, typesCharacter } from '../src/lib/global-shortcuts.ts';
import { FORMAT_MARKERS, formatForKey, toggleFormat } from '../src/lib/composer-format.ts';
import { lastEditable } from '../src/lib/message-edit.ts';
import { SLOW_LOAD_MS, lazy } from '../src/lib/lazy.ts';
import { MEMBER_RELOAD_MAX_WAIT_MS, MEMBER_RELOAD_QUIET_MS, MemberReloadQueue } from '../src/lib/member-reload.ts';
import { ResponseOrder } from '../src/lib/response-order.ts';

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

// --- Message grouping ---
{
  const at = (minute) => `2026-01-01T12:${String(minute).padStart(2, '0')}:00.000Z`;
  const msg = (id, minute, author = 'them', replyTo = null) => ({
    id,
    createdAt: at(minute),
    author: author === null ? null : { id: author },
    replyTo,
  });

  check('same author, close in time, is grouped', isGrouped(msg('a', 1), msg('b', 2)));
  check('a gap past the window is not', !isGrouped(msg('a', 1), msg('b', 9)));
  check('a different author is not', !isGrouped(msg('a', 1), msg('b', 2, 'other')));
  check('a reply starts its own group', !isGrouped(msg('a', 1), msg('b', 2, 'them', { id: 'x' })));
  check('a missing author is not grouped', !isGrouped(msg('a', 1, null), msg('b', 2)));
  check('the first message of a list is not grouped', !isGrouped(undefined, msg('a', 1)));

  const rows = groupedRows([msg('a', 1), msg('b', 2), msg('c', 3, 'other'), msg('d', 4, 'other')], null);
  check(
    'groupedRows marks continuations, not the first of a run',
    rows.map((row) => row.grouped).join(',') === 'false,true,false,true',
  );
  check('the message under the new line starts a group', groupedRows([msg('a', 1), msg('b', 2)], 'b')[1].grouped === false);
}

// --- Composer autocomplete: triggers and suggestions ---
{
  const commands = [
    {
      id: 'c1',
      name: 'timeout',
      description: 'Times a member out',
      requiredPermissions: '0',
      bot: { id: 'b1', username: 'helper', displayName: 'Helper', avatarHash: null },
    },
  ];

  const emojiTrigger = detectTrigger('hello :sm', 9, []);
  check(
    'an emoji trigger reads the fragment at the caret',
    emojiTrigger?.kind === 'emoji' && emojiTrigger.start === 6 && emojiTrigger.query === 'sm',
  );
  const mentionTrigger = detectTrigger('hey @alice', 10, []);
  check(
    'a mention trigger reads the name',
    mentionTrigger?.kind === 'mention' && mentionTrigger.query === 'alice' && mentionTrigger.moment === null,
  );
  const timeTrigger = detectTrigger('@in 2h', 6, []);
  check('an @ that reads as a time carries the moment', timeTrigger?.kind === 'mention' && timeTrigger.moment !== null);
  const channelTrigger = detectTrigger('go to #off', 10, []);
  check('a channel trigger reads the name', channelTrigger?.kind === 'channel' && channelTrigger.query === 'off');
  check('a built-in slash opens the popup', detectTrigger('/sh', 3, [])?.kind === 'slash');
  check('a registered bot command opens it too', detectTrigger('/time', 5, commands)?.kind === 'slash');
  check('an unknown slash word is plain text', detectTrigger('/usr', 4, commands) === null);
  check('ordinary text is no trigger', detectTrigger('just talking', 12, commands) === null);

  check(
    'a prefix member ranks above a substring',
    rankMember({ username: 'frida', displayName: null }, 'fri') === 0 &&
      rankMember({ username: 'africa', displayName: null }, 'fri') === 1,
  );
  check('no match ranks last', rankMember({ username: 'bob', displayName: null }, 'fri') === 2);

  const data = (over = {}) => ({
    picker: [],
    unicode: [],
    ranked: [],
    scores: new Map(),
    commands: [],
    channels: [],
    users: [],
    now: 0,
    ...over,
  });

  check('no trigger means no suggestions', suggestionsFor(null, data()).length === 0);

  const picker = [{ id: 'e1', name: 'smile' }, { id: 'e2', name: 'smirk' }];
  const unicode = [{ emoji: '😀', name: 'grinning face' }];
  const typedEmoji = suggestionsFor({ kind: 'emoji', start: 0, query: 'sm' }, data({ picker, unicode }));
  check('a typed emoji query keeps only the custom matches', typedEmoji.length === 2 && typedEmoji[0].key === 'emoji:e1');
  const bothEmoji = suggestionsFor({ kind: 'emoji', start: 0, query: 'gr' }, data({ picker: [{ id: 'e3', name: 'grin' }], unicode }));
  check(
    'a custom match comes before a unicode one for the same query',
    bothEmoji[0]?.key === 'emoji:e3' && bothEmoji.some((row) => row.key === 'unicode:😀'),
  );
  const usedEmoji = suggestionsFor(
    { kind: 'emoji', start: 0, query: '' },
    data({ picker, unicode, ranked: [{ emoji: '😀', emojiId: null }] }),
  );
  check('a frequently used emoji leads a bare : list', usedEmoji[0]?.key === 'unicode:😀');

  const channels = [{ id: 'a', name: 'general' }, { id: 'b', name: 'nerd' }];
  const channelRows = suggestionsFor({ kind: 'channel', start: 0, query: 'ner' }, data({ channels }));
  check('a channel prefix match sorts ahead of a substring', channelRows[0]?.label === '#nerd' && channelRows[1]?.label === '#general');

  const users = [
    { id: 'u1', username: 'frida', displayName: 'Frida' },
    { id: 'u2', username: 'africa', displayName: null },
    { id: 'u3', username: 'bob', displayName: 'Bob' },
  ];
  const mentionRows = suggestionsFor({ kind: 'mention', start: 0, query: 'fri', moment: null }, data({ users }));
  check(
    'a mention lists the prefix match before the substring, and drops non-matches',
    mentionRows.length === 2 && mentionRows[0].key === 'mention:u1' && mentionRows[1].key === 'mention:u2',
  );

  const timeRows = suggestionsFor(
    { kind: 'mention', start: 0, query: 'in 2h', moment: { epochMs: 7_200_000, kind: 'relative' } },
    data({ now: 0 }),
  );
  check('a time trigger offers timestamp styles', timeRows.length > 0 && timeRows[0].key.startsWith('time:'));

  const builtinRows = suggestionsFor({ kind: 'slash', start: 0, query: 'sh' }, data({}));
  check('a built-in slash helper is offered', builtinRows.some((row) => row.key === 'slash:shrug'));
  const botRows = suggestionsFor({ kind: 'slash', start: 0, query: 'time' }, data({ commands }));
  check(
    'a bot command is offered and names its bot',
    botRows.some((row) => row.key === 'botcmd:c1' && row.commandId === 'c1' && row.detail.includes('Helper')),
  );
}

// --- Host-controlled voice ---
{
  const savedFlag = globalThis.__harmonyVoiceDisabled;
  const savedLocation = globalThis.location;
  const savedHost = globalThis.HarmonyVoiceHost;
  try {
    delete globalThis.__harmonyVoiceDisabled;
    delete globalThis.location;
    check('voice is on by default', webVoiceDisabled() === false);
    globalThis.__harmonyVoiceDisabled = true;
    check('the host global turns voice off', webVoiceDisabled() === true);
    globalThis.__harmonyVoiceDisabled = 'off';
    check('a string "off" also turns it off', webVoiceDisabled() === true);
    delete globalThis.__harmonyVoiceDisabled;
    globalThis.location = { search: '?voice=off' };
    check('a query parameter turns voice off', webVoiceDisabled() === true);
    globalThis.location = { search: '?voice=on' };
    check('any other value leaves it on', webVoiceDisabled() === false);

    // The host bridge hands a channel tap to native voice.
    delete globalThis.HarmonyVoiceHost;
    check('no host is detected as none', voiceHost() === null);
    check('without a host the client keeps its own join', askHostToJoin('c1', 'Lounge') === false);
    const posted = [];
    globalThis.HarmonyVoiceHost = { postMessage: (message) => posted.push(message) };
    check('a present host is detected', voiceHost() !== null);
    check('a tap is handed to the host', askHostToJoin('c1', 'Lounge') === true);
    const handoff = posted.length === 1 ? JSON.parse(posted[0]) : null;
    check(
      'the hand-off carries the channel id and name',
      handoff?.type === 'join' && handoff.channelId === 'c1' && handoff.channelName === 'Lounge',
    );

    // The inbound half: the shell pushes call state back so the row can read it.
    check('a non-message is ignored', parseHostVoiceMessage(null) === null && parseHostVoiceMessage('nope') === null);
    check('an unknown version is ignored', parseHostVoiceMessage({ version: 2, type: 'state', channelId: 'c1' }) === null);
    check('an unknown type is ignored', parseHostVoiceMessage({ version: 1, type: 'join' }) === null);
    check('a state without a channel id is useless', parseHostVoiceMessage({ version: 1, type: 'state' }) === null);

    const parsed = parseHostVoiceMessage({
      version: 1,
      type: 'state',
      channelId: 'c1',
      channelName: 'Lounge',
      self: { muted: true, deafened: false, sharing: false },
      members: [
        { id: 'u1', name: 'Nanahoshi', muted: true, sharing: false, speaking: true },
        { id: 'u2', name: 'Eris', muted: false, sharing: true, speaking: false },
        { id: '' },
        null,
      ],
    });
    check(
      'a state message is read',
      parsed?.type === 'state' && parsed.channelId === 'c1' && parsed.channelName === 'Lounge',
    );
    check('self flags are read', parsed?.self.muted === true && parsed?.self.deafened === false);
    check(
      'members mirror the roster and drop the unusable',
      parsed?.members.length === 2 && parsed.members[0].speaking === true && parsed.members[1].sharing === true,
    );
    check(
      'a missing name falls back to the id',
      parseHostVoiceMessage({ version: 1, type: 'state', channelId: 'c1', members: [{ id: 'u3' }] })?.members[0].name ===
        'u3',
    );
    check('the terminal message is read', parseHostVoiceMessage('{"version":1,"type":"left"}')?.type === 'left');

    // The parser is the one place shell input becomes roster rows, so its bounds
    // live here: the roster is capped, an over-long name is truncated, an
    // over-long id drops its entry, and a repeated id collapses to one row.
    const crowd = Array.from({ length: HOST_VOICE_MAX_MEMBERS + 200 }, (_, i) => ({ id: `u${i}`, name: 'many' }));
    check(
      'an oversized member list is clamped',
      parseHostVoiceMessage({ version: 1, type: 'state', channelId: 'c1', members: crowd })?.members.length ===
        HOST_VOICE_MAX_MEMBERS,
    );
    check(
      'an over-long member name is bounded',
      parseHostVoiceMessage({
        version: 1,
        type: 'state',
        channelId: 'c1',
        members: [{ id: 'u1', name: 'n'.repeat(4096) }],
      })?.members[0].name.length === HOST_VOICE_MAX_NAME,
    );
    const longId = parseHostVoiceMessage({
      version: 1,
      type: 'state',
      channelId: 'c1',
      members: [{ id: 'x'.repeat(HOST_VOICE_MAX_ID + 1), name: 'ghost' }, { id: 'ok' }],
    });
    check('a member with an over-long id is dropped', longId?.members.length === 1 && longId.members[0].id === 'ok');
    const repeated = parseHostVoiceMessage({
      version: 1,
      type: 'state',
      channelId: 'c1',
      members: [
        { id: 'u1', name: 'first' },
        { id: 'u1', name: 'second' },
        { id: 'u2' },
      ],
    });
    check(
      'a repeated member id collapses to its first row',
      repeated?.members.length === 2 && repeated.members[0].name === 'first',
    );
    check(
      'an over-long channel name is bounded',
      parseHostVoiceMessage({ version: 1, type: 'state', channelId: 'c1', channelName: 'c'.repeat(4096) })?.channelName
        ?.length === HOST_VOICE_MAX_CHANNEL_NAME,
    );
    check(
      'a state whose channel id is over-long is dropped',
      parseHostVoiceMessage({ version: 1, type: 'state', channelId: 'x'.repeat(HOST_VOICE_MAX_ID + 1) }) === null,
    );

    // Both delivery routes: the bridge callback, and the window event a shell
    // may dispatch instead. Node has no window, so the event is proven against
    // a stand-in listener target.
    const delivered = [];
    const unsubscribe = subscribeHostVoiceState((message) => delivered.push(message));
    check('the client assigns the bridge callback', typeof globalThis.HarmonyVoiceHost?.onState === 'function');
    globalThis.HarmonyVoiceHost.onState('{"version":1,"type":"left"}');
    check('a callback message reaches the handler', delivered.length === 1 && delivered[0].type === 'left');
    unsubscribe();
    check('unsubscribing clears the callback', globalThis.HarmonyVoiceHost.onState === undefined);

    const eventListeners = new Map();
    const savedAdd = globalThis.addEventListener;
    const savedRemove = globalThis.removeEventListener;
    globalThis.addEventListener = (type, listener) => eventListeners.set(type, listener);
    globalThis.removeEventListener = (type) => eventListeners.delete(type);
    try {
      const seen = [];
      const stop = subscribeHostVoiceState((message) => seen.push(message));
      check('the event route is registered', eventListeners.has(HOST_VOICE_EVENT));
      eventListeners.get(HOST_VOICE_EVENT)({ detail: { version: 1, type: 'left' } });
      check('an event message reaches the handler', seen.length === 1 && seen[0].type === 'left');
      stop();
      check('unsubscribing removes the event route', !eventListeners.has(HOST_VOICE_EVENT));
    } finally {
      if (savedAdd === undefined) delete globalThis.addEventListener;
      else globalThis.addEventListener = savedAdd;
      if (savedRemove === undefined) delete globalThis.removeEventListener;
      else globalThis.removeEventListener = savedRemove;
    }

    // Leaving from the row goes through the same bridge.
    check('a leave tap reaches the host', askHostToLeave() === true);
    check('the leave carries the terminal type', posted.length === 2 && JSON.parse(posted[1]).type === 'leave');
    delete globalThis.HarmonyVoiceHost;
    check('a leave without a host falls back', askHostToLeave() === false);
  } finally {
    if (savedFlag === undefined) delete globalThis.__harmonyVoiceDisabled;
    else globalThis.__harmonyVoiceDisabled = savedFlag;
    if (savedLocation === undefined) delete globalThis.location;
    else globalThis.location = savedLocation;
    if (savedHost === undefined) delete globalThis.HarmonyVoiceHost;
    else globalThis.HarmonyVoiceHost = savedHost;
  }
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

// ---- Jumbo emoji and frequently used emoji ----
{
  console.log('\nJumbo emoji');
  const lookup = new Map([
    ['party', { id: 'e-party', name: 'party', hash: 'h', animated: false }],
    ['cat', { id: 'e-cat', name: 'cat', hash: 'h', animated: false }],
  ]);
  const jumbo = (text) => isJumbo(parseMessage(text, lookup, () => undefined));
  check('one custom emoji is jumbo', jumbo(':party:'));
  check('one unicode emoji is jumbo', jumbo('😀'));
  check('mixed custom and unicode, spaced, is jumbo', jumbo(':party: 😀  :cat:\n🎉'));
  check('unicode emoji with no spaces between is jumbo', jumbo('😀😀😀'));
  check('text makes it ordinary', !jumbo('hi 😀') && !jumbo(':party: lol'));
  check('an unknown shortcode is not jumbo', !jumbo(':nope:') && !jumbo(':party: :nope:'));
  check('the empty message is not jumbo', !jumbo('') && !jumbo('   '));
  check('27 emoji are jumbo, 28 are not', jumbo('😀'.repeat(27)) && !jumbo('😀'.repeat(28)));
  check('the cap counts custom and unicode together', jumbo(':party:' + ' 😀'.repeat(26)) && !jumbo(':party: ' + '😀 '.repeat(27)));
  check('skin tones are one emoji', jumbo('👍🏽') && unicodeEmojiIn('👍🏽').length === 1);
  check('ZWJ sequences are one emoji', jumbo('👩‍👩‍👧‍👦') && unicodeEmojiIn('👩‍👩‍👧‍👦').length === 1);
  check('a ZWJ sequence with a skin tone is one emoji', unicodeEmojiIn('🧑🏽‍🚀').length === 1);
  check('flags are one emoji', jumbo('🇯🇵 🇺🇸') && unicodeEmojiIn('🇯🇵').length === 1);
  check('a lone regional indicator is not an emoji', !jumbo('🇯'));
  check('a subdivision flag is one emoji', jumbo('🏴󠁧󠁢󠁥󠁮󠁧󠁿'));
  check('a keycap is an emoji', jumbo('1️⃣') && jumbo('#️⃣'));
  check('plain digits, # and * are not emoji', !jumbo('1') && !jumbo('#') && !jumbo('*') && !jumbo('123'));
  check('a text-style copyright sign is not an emoji', !jumbo('©') && jumbo('©️'));
  check('a heart with a variation selector is an emoji', jumbo('❤️') && jumbo('❤'));
  check('emoji inside code are not jumbo', !jumbo('`😀`') && !jumbo('```\n😀\n```'));
  check('a quote of emoji is not jumbo', !jumbo('> 😀') && !jumbo('> :party:'));
  check('a list of emoji is not jumbo', !jumbo('- 😀') && !jumbo('1. :party:'));
  check('a header of emoji is not jumbo', !jumbo('# 😀'));
  check('blank lines between emoji keep it jumbo', jumbo('😀\n\n😀'));
  check('a link is not jumbo', !jumbo('https://example.com'));
  check('bold emoji still count', jumbo('**😀**'));

  console.log('\nEmoji usage');
  const DAY = 24 * 60 * 60 * 1000;
  const t0 = 1_700_000_000_000;
  const use = (emoji, emojiId = null) => ({ emoji, emojiId });
  let entries = recordUsage([], [use('😀'), use(':party:', 'e-party'), use('😀')], t0);
  check('uses are counted', entries.length === 2 && entries[0].emoji === '😀' && entries[0].score === 2);
  check('scores halve every half-life', Math.abs(scoreAt(entries[0], t0 + USAGE_HALF_LIFE_MS) - 1) < 1e-9);
  const later = t0 + 60 * DAY;
  entries = recordUsage(entries, [use(':party:', 'e-party')], later);
  check('recent use outranks a stale favourite', rankEntries(entries, later)[0].emojiId === 'e-party');
  check('a custom emoji is keyed by id, so a rename merges', recordUsage(entries, [use(':fiesta:', 'e-party')], later).length === 2);
  const many = Array.from({ length: USAGE_CAP + 10 }, (_, i) => use(String.fromCodePoint(0x1f600 + i)));
  check('usage is capped', recordUsage([], many, t0).length === USAGE_CAP);
  const kept = recordUsage(recordUsage([], [use('😀'), use('😀'), use('😀')], t0), many.slice(1), t0);
  check('the cap drops the lowest scores, not the favourites', kept.some((e) => e.emoji === '😀'));
  const live = new Map([['e-party', { id: 'e-party', name: 'party2' }]]);
  const resolved = resolveUsage(entries, live, later);
  check('deleted custom emoji are dropped and renamed ones take the new name', resolved.length === 2 && resolved[0].emoji === ':party2:');
  check('with no custom emoji left only unicode remains', resolveUsage(entries, new Map(), later).every((e) => e.emojiId === null));
  const sent = emojiInContent('hi :party: 😀 `:cat:` 👍🏽 :nope:', lookup);
  check('sent content yields its resolvable emoji, outside code', sent.length === 3 && sent[0].emojiId === 'e-party' && sent[1].emoji === '😀' && sent[2].emoji === '👍🏽');
  check('stored usage round-trips', parseUsage(JSON.stringify(entries)).length === 2);
  check('malformed storage reads as empty', parseUsage('nope').length === 0 && parseUsage('{}').length === 0 && parseUsage(null).length === 0);
  check('malformed entries are skipped', parseUsage(JSON.stringify([{ emoji: 1 }, null, { emoji: 'x', emojiId: null, score: 1, last: 1 }])).length === 1);
}

// --- Search filter syntax ---
{
  const keys = (parsed) => parsed.filters.map((filter) => `${filter.key}=${filter.value}`).join('|');

  const basic = parseSearchInput('hello from:alice in:general world has:image ');
  check('filters come out of the text', basic.text === 'hello world');
  check('every filter is kept in order', keys(basic) === 'from=alice|in=general|has=image');
  check('keys are case-insensitive', keys(parseSearchInput('FROM:Bob Has:GIF ')) === 'from=Bob|has=GIF');
  check('a quoted value may hold spaces', keys(parseSearchInput('from:"Some Name" ')) === 'from=Some Name');
  check('quoted values do not leak into the text', parseSearchInput('x from:"Some Name" y ').text === 'x y');
  check('an unknown key stays as text', parseSearchInput('re:thing ').text === 're:thing');
  check('a time-looking word stays text', parseSearchInput('meet at 10:30 ').text === 'meet at 10:30');
  check('a bare key is dropped, not searched', parseSearchInput('from: hello ').text === 'hello');
  check('a token still being typed stays in the text', parseSearchInput('hi from:ali', false).text === 'hi from:ali');
  check('a finished token is taken while typing', keys(parseSearchInput('hi from:ali ', false)) === 'from=ali');
  check('the last token is taken on submit', keys(parseSearchInput('hi from:ali')) === 'from=ali');
  check(
    'an unterminated quote is one token',
    parseSearchInput('from:"Some Na', false).text === 'from:"Some Na' && keys(parseSearchInput('from:"Some Na')) === 'from=Some Na',
  );
  check('tokens round-trip with quoting', filterToken({ key: 'from', value: 'Some Name' }) === 'from:"Some Name"');
  check('a plain value is not quoted', filterToken({ key: 'in', value: 'general' }) === 'in:general');
  check(
    'duplicate filters are merged away',
    mergeFilters([{ key: 'from', value: 'Al' }], [{ key: 'from', value: 'al' }, { key: 'has', value: 'pin' }]).length === 2,
  );

  const now = new Date(2024, 4, 15, 13, 30);
  const day = (y, m, d) => new Date(y, m - 1, d).getTime();
  check('a date is the local start of that day', parseSearchDate('2024-05-01', now)?.getTime() === day(2024, 5, 1));
  check('today and yesterday work', parseSearchDate('today', now)?.getTime() === day(2024, 5, 15) && parseSearchDate('Yesterday', now)?.getTime() === day(2024, 5, 14));
  check('an impossible date is refused', parseSearchDate('2024-02-31', now) === null && parseSearchDate('soon', now) === null);

  const request = (text, filters) => buildSearchParams(text, filters, now);
  const built = request('cats', [
    { key: 'from', value: 'alice' },
    { key: 'from', value: '@Bob' },
    { key: 'in', value: '#general' },
    { key: 'has', value: 'Image' },
  ]);
  check('text becomes q', built.params.get('q') === 'cats');
  check('repeated from values are all sent, without the @', built.params.getAll('from').join() === 'alice,Bob');
  check('in drops a leading hash', built.params.get('in') === 'general');
  check('has is lower-cased', built.params.get('has') === 'image' && built.problems.length === 0);
  check('on: is the whole local day', (() => {
    const r = request('', [{ key: 'on', value: '2024-05-01' }]);
    return r.params.get('sentAfter') === String(day(2024, 5, 1)) && r.params.get('sentBefore') === String(day(2024, 5, 2));
  })());
  check('before: is the start of the day', request('', [{ key: 'before', value: 'today' }]).params.get('sentBefore') === String(day(2024, 5, 15)));
  check('after: is the end of the day', request('', [{ key: 'after', value: 'yesterday' }]).params.get('sentAfter') === String(day(2024, 5, 15)));
  check('a filter alone is searchable', request('', [{ key: 'has', value: 'pin' }]).searchable === true);
  check('nothing at all is not searchable', request('', []).searchable === false);
  const bad = request('x', [{ key: 'has', value: 'banana' }, { key: 'after', value: 'whenever' }]);
  check('bad values are reported and block the search', bad.problems.length === 2 && bad.searchable === false);

  const sources = {
    members: [
      { username: 'alice', displayName: 'Alice Liddell' },
      { username: 'bob', displayName: null },
      { username: 'malice', displayName: null },
    ],
    channels: [{ name: 'general' }, { name: 'off topic' }, { name: 'gaming' }],
  };
  const text = 'hello from:ali';
  const token = activeToken(text, text.length);
  check('the token under the caret is found', token?.key === 'from' && token.partial === 'ali' && token.start === 6);
  check('plain text under the caret has no token', activeToken('hello wor', 9) === null);
  check('after trailing whitespace there is no token', activeToken('from:alice ', 11) === null);
  check('an unknown key has no token', activeToken('re:ali', 6) === null);
  check('a quoted partial is read without its quote', activeToken('from:"Some Na', 13)?.partial === 'Some Na');
  const people = suggestFor(token, sources);
  check('members match by username or display name', people.map((s) => s.value).join() === 'alice,malice');
  check('a prefix match ranks first', people[0]?.value === 'alice' && people[0].label === 'Alice Liddell' && people[0].detail === undefined);
  check('an empty partial offers everyone', suggestFor({ key: 'from', partial: '', start: 0, end: 5 }, sources).length === 3);
  check('channels are offered by name', suggestFor({ key: 'in', partial: 'g', start: 0, end: 4 }, sources).map((s) => s.value).join() === 'general,gaming');
  check('has offers the fixed list', suggestFor({ key: 'has', partial: 'p', start: 0, end: 5 }, sources).map((s) => s.value).join() === 'pin');
  check('dates offer today and yesterday', suggestFor({ key: 'on', partial: 'to', start: 0, end: 5 }, sources, now).map((s) => s.value).join() === 'today');
  const applied = applySuggestion('hello in:off other', activeToken('hello in:off other', 12), { label: '#off topic', value: 'off topic' });
  check('applying a suggestion quotes a name with spaces', applied.text === 'hello in:"off topic" other');
  check('and puts the caret after the token', applied.caret === 'hello in:"off topic" '.length);
}

// --- Scheduled messages: choosing and describing the time ---
{
  const base = { now: writeNow, locale: 'en-US', timeZone: 'UTC' };
  const asIso = (epoch) => (epoch === null ? null : new Date(epoch).toISOString().slice(0, 16));

  check('a typed time reads like the composer expressions', asIso(parseScheduleInput('5pm', base)) === '2025-12-24T17:00');
  check('with or without the @', parseScheduleInput('@5pm', base) === parseScheduleInput('5pm', base));
  check('a day and a time', asIso(parseScheduleInput('tomorrow 9am', base)) === '2025-12-25T09:00');
  check('a countdown', asIso(parseScheduleInput('in 2h', base)) === '2025-12-24T17:00');
  check('nonsense is not a time', parseScheduleInput('whenever', base) === null);
  check('empty is not a time', parseScheduleInput('  ', base) === null);

  check('nothing chosen is a problem', scheduleProblem(null, writeNow) !== null);
  check('a time in the past is a problem', scheduleProblem(writeNow - 1000, writeNow) !== null);
  check('a time seconds away is a problem', scheduleProblem(writeNow + 10_000, writeNow) !== null);
  check('a time a few minutes out is fine', scheduleProblem(writeNow + 5 * 60_000, writeNow) === null);
  check('a time within a year is fine', scheduleProblem(writeNow + 300 * 86_400_000, writeNow) === null);
  check('a time past a year is a problem', scheduleProblem(writeNow + 400 * 86_400_000, writeNow) !== null);

  const choices = scheduleChoices(writeNow, { locale: 'en-US', timeZone: 'UTC' });
  check('quick choices run from soonest to latest', choices.every((choice, index) => index === 0 || choice.at > choices[index - 1].at));
  check('in 30 minutes is 30 minutes', choices[0].at === writeNow + 30 * 60_000);
  check('tomorrow morning is 9:00 the next day', asIso(choices.at(-1).at) === '2025-12-25T09:00');
  check('and every quick choice can be scheduled', choices.every((choice) => scheduleProblem(choice.at, writeNow) === null));
  check('the default is an hour out, on a five minute mark', defaultScheduleTime(writeNow) === writeNow + 60 * 60_000);
  check('and rounds up', defaultScheduleTime(writeNow + 60_000) === writeNow + 65 * 60_000);

  check(
    'a time today is described as today, with the zone',
    describeSendTime(writeNow + 2 * hour, base) === 'Today at 5:00 PM (UTC)',
  );
  check('tomorrow is named', describeSendTime(Date.UTC(2025, 11, 25, 9, 0), base) === 'Tomorrow at 9:00 AM (UTC)');
  check('later this week is a weekday', describeSendTime(Date.UTC(2025, 11, 27, 9, 0), base) === 'Saturday at 9:00 AM (UTC)');
  check(
    'further out is a date',
    describeSendTime(Date.UTC(2026, 0, 10, 9, 0), base) === 'Jan 10, 2026 at 9:00 AM (UTC)',
  );
  check(
    'the member\'s own zone decides the day',
    describeSendTime(Date.UTC(2025, 11, 25, 23, 30), { ...base, timeZone: 'Asia/Tokyo' }) === 'Tomorrow at 8:30 AM (Asia/Tokyo)' && describeSendTime(Date.UTC(2025, 11, 24, 23, 30), { ...base, timeZone: 'Asia/Tokyo' }) === 'Today at 8:30 AM (Asia/Tokyo)',
  );

  const entry = (id, sendAt, status = 'pending') => ({ id, sendAt, status, content: id, channelId: 'c', attachments: [], replyToId: null, createdAt: sendAt, error: null });
  const early = entry('a', '2026-01-01T10:00:00.000Z');
  const late = entry('b', '2026-01-01T12:00:00.000Z', 'failed');
  let list = upsertScheduled([], late);
  list = upsertScheduled(list, early);
  check('the list stays soonest first', list.map((item) => item.id).join() === 'a,b');
  list = upsertScheduled(list, { ...early, sendAt: '2026-01-01T13:00:00.000Z' });
  check('an update replaces in place and re-sorts', list.map((item) => item.id).join() === 'b,a' && list.length === 2);
  check('removing drops one', removeScheduled(list, 'a').map((item) => item.id).join() === 'b');
  check('removing a stranger changes nothing', removeScheduled(list, 'zzz').length === 2);
  check('the badge counts everything and the failed ones', scheduledBadge(list).count === 2 && scheduledBadge(list).failed === 1);
  check('an empty list has an empty badge', scheduledBadge([]).count === 0 && scheduledBadge([]).failed === 0);
}

// --- Suppressed links: <url> shows a plain link and asks for no preview ---
{
  const angle = inline('see <https://example.com/a?b=1> now');
  check(
    'an angle link is drawn without its brackets',
    plain('see <https://example.com/a?b=1> now') === 'see https://example.com/a?b=1 now',
  );
  check(
    'and links to the bare address',
    angle.some((s) => s.type === 'link' && s.href === 'https://example.com/a?b=1' && s.noEmbed === true),
  );
  check('so nothing in it is offered for a preview', listEmbeddableUrls('see <https://example.com/a?b=1> now').length === 0);
  check(
    'a bare link beside an angle link is still the only one offered',
    listEmbeddableUrls('<https://example.com/a> and https://example.com/b').join() === 'https://example.com/b',
  );
  check(
    'trailing punctuation outside the brackets stays text',
    plain('<https://example.com/a>.') === 'https://example.com/a.',
  );
  check(
    'inside code the brackets are literal',
    plain('`<https://example.com/a>`') === '<https://example.com/a>' && listEmbeddableUrls('`<https://example.com/a>`').length === 0,
  );
  check(
    'an edit that removes the brackets makes the link embeddable again',
    listEmbeddableUrls('<https://example.com/a>').length === 0 && listEmbeddableUrls('https://example.com/a').length === 1,
  );
}

// --- Slash helpers ---
{
  // The text sent is escaped Markdown that displays as ¯\_(ツ)_/¯.
  const SHRUG = '¯\\\\\\_(ツ)\\_/¯';
  const FLIP = '(╯°□°)╯︵ ┻━┻';
  check('slash: shrug alone is the face', applySlashCommand('/shrug') === SHRUG);
  check('slash: and the shrug displays intact through the markdown parser', plain(applySlashCommand('/shrug')) === '¯\\_(ツ)_/¯');
  check('slash: every face survives the markdown parser', plain(applySlashCommand('/unflip')) === '┬─┬ノ( º _ ºノ)' && plain(applySlashCommand('/lenny')) === '( ͡° ͜ʖ ͡°)' && plain(applySlashCommand('/tableflip')) === '(╯°□°)╯︵ ┻━┻');
  check('slash: shrug appends to text', applySlashCommand('/shrug oh well') === `oh well ${SHRUG}`);
  check('slash: trailing spaces are dropped', applySlashCommand('/shrug   ') === SHRUG);
  check('slash: extra spaces before the text are dropped', applySlashCommand('/shrug    hi  ') === `hi ${SHRUG}`);
  check('slash: tableflip', applySlashCommand('/tableflip') === FLIP && applySlashCommand('/tableflip ugh') === `ugh ${FLIP}`);
  check('slash: unflip', applySlashCommand('/unflip') === '┬─┬ノ( º _ ºノ)');
  check('slash: lenny', applySlashCommand('/lenny') === '( ͡° ͜ʖ ͡°)');
  check('slash: me italicizes', applySlashCommand('/me waves') === '_waves_');
  check('slash: me with no text is left as typed', applySlashCommand('/me') === '/me' && applySlashCommand('/me   ') === '/me   ');
  check('slash: me keeps each line italic on its own', applySlashCommand('/me one\ntwo') === '_one_\n_two_');
  check('slash: me leaves blank lines alone', applySlashCommand('/me one\n\ntwo') === '_one_\n\n_two_');
  check('slash: me with an underscore uses stars', applySlashCommand('/me snake_case') === '*snake_case*');
  check('slash: me with text on the next line', applySlashCommand('/me\nhello') === '_hello_');
  check('slash: spoiler wraps', applySlashCommand('/spoiler the butler did it') === '||the butler did it||');
  check('slash: spoiler spans lines', applySlashCommand('/spoiler a\nb') === '||a\nb||');
  check('slash: spoiler with no text is left as typed', applySlashCommand('/spoiler') === '/spoiler');
  check('slash: an unknown command is plain text', applySlashCommand('/foo bar') === '/foo bar');
  check('slash: a path is untouched', applySlashCommand('/usr/bin/env') === '/usr/bin/env');
  check('slash: a path that starts with a command word is untouched', applySlashCommand('/shrugged') === '/shrugged');
  check('slash: a command with a path after it is untouched', applySlashCommand('/me/profile') === '/me/profile');
  check('slash: a command later in the text is untouched', applySlashCommand('hi /shrug') === 'hi /shrug');
  check('slash: commands are lowercase only', applySlashCommand('/Shrug') === '/Shrug');
  check('slash: a backslash escape sends a literal slash', applySlashCommand('\\/shrug') === '/shrug');
  check('slash: the escape works on any text', applySlashCommand('\\/me hi') === '/me hi');
  check('slash: a lone slash is text', applySlashCommand('/') === '/');
  check('slash: multi-line text after a face', applySlashCommand('/shrug a\nb') === `a\nb ${SHRUG}`);
  check('slash: a tab separates the command', applySlashCommand('/spoiler\thi') === '||hi||');
  check('slash: ordinary text is untouched', applySlashCommand('hello world') === 'hello world');
  check('slash: popup lists every command for a bare slash', matchSlashCommands('').length === SLASH_COMMANDS.length);
  check('slash: popup filters by prefix', matchSlashCommands('s').map((c) => c.name).join() === 'shrug,spoiler');
  check('slash: popup is empty for an unknown word', matchSlashCommands('zzz').length === 0);
  check('slash: the query is read only at the start', slashQuery('/sh') === 'sh' && slashQuery('hi /sh') === null);
  check('slash: a path is not a query', slashQuery('/usr/bin') === null && slashQuery('/sh ') === null);
}

// Polls: the pure pieces behind the poll view and the poll form.
{
  const poll = {
    messageId: 'm1',
    question: 'q',
    allowMultiple: false,
    closesAt: null,
    closedAt: null,
    source: 'harmony',
    totalVoters: 4,
    myVotes: ['a'],
    options: [
      { id: 'a', text: 'A', emoji: null, count: 2 },
      { id: 'b', text: 'B', emoji: null, count: 2 },
      { id: 'c', text: 'C', emoji: null, count: 0 },
    ],
  };
  check('a share is a whole percentage', pollPercent(1, 3) === 33 && pollPercent(2, 3) === 67 && pollPercent(4, 4) === 100);
  check('nobody voting is 0%, not NaN', pollPercent(0, 0) === 0 && pollPercent(3, 0) === 0);
  check('ties all lead; no votes means no leader', pollLeaders(poll).join() === 'a,b' && pollLeaders({ options: [{ count: 0 }] }).length === 0);
  const now = Date.parse('2026-01-01T12:00:00Z');
  const at = (ms) => new Date(now + ms).toISOString();
  check('a poll with no expiry never closes by the clock', isPollClosed({ closedAt: null, closesAt: null }, now) === false);
  check('a poll closes when its time passes', isPollClosed({ closedAt: null, closesAt: at(-1) }, now) && !isPollClosed({ closedAt: null, closesAt: at(1000) }, now));
  check('a poll closed by hand stays closed', isPollClosed({ closedAt: at(-5000), closesAt: at(60_000) }, now));
  check(
    'time left reads in minutes, hours and days',
    pollTimeLeft(at(90_000), now) === '2 minutes left' &&
      pollTimeLeft(at(3_600_000), now) === '1 hour left' &&
      pollTimeLeft(at(5 * 3_600_000), now) === '5 hours left' &&
      pollTimeLeft(at(3 * 86_400_000), now) === '3 days left',
  );
  check('a minute is singular, and a lapsed time says closing soon', pollTimeLeft(at(30_000), now) === '1 minute left' && pollTimeLeft(at(-1), now) === 'Closing soon');
  check('no expiry reads as nothing', pollTimeLeft(null, now) === '');
  check('a single-answer poll swaps the choice', nextPollChoice(poll, ['a'], 'b').join() === 'b');
  check('clicking the chosen option withdraws it', nextPollChoice(poll, ['a'], 'a').length === 0);
  const multi = { allowMultiple: true };
  check('a multiple-answer poll toggles', nextPollChoice(multi, ['a'], 'b').join() === 'a,b' && nextPollChoice(multi, ['a', 'b'], 'a').join() === 'b');
  const update = {
    messageId: 'm1',
    channelId: 'c',
    closedAt: null,
    totalVoters: 5,
    options: [{ id: 'a', count: 2 }, { id: 'b', count: 3 }, { id: 'c', count: 0 }],
    actorId: 'me',
    actorVotes: ['b'],
  };
  const mine = applyPollUpdate(poll, update, 'me');
  check('an update sets the counts, and the choice when it is the viewer\'s own', mine.options[1].count === 3 && mine.totalVoters === 5 && mine.myVotes.join() === 'b');
  const theirs = applyPollUpdate(poll, update, 'someone-else');
  check('someone else\'s vote leaves the viewer\'s choice alone', theirs.options[1].count === 3 && theirs.myVotes.join() === 'a');
  const closing = applyPollUpdate(poll, { ...update, actorId: null, actorVotes: null, closedAt: at(0) }, 'me');
  check('a close update keeps the choice and marks it closed', closing.myVotes.join() === 'a' && closing.closedAt === at(0));
  check('an update does not mutate the poll it was applied to', poll.options[1].count === 2 && poll.totalVoters === 4);

  let draft = newPollDraft();
  check('a new form has two empty options, one answer, a day', draft.options.length === 2 && draft.allowMultiple === false && draft.durationHours === 24);
  check('an empty form says what it lacks', draftProblem(draft) === 'Ask a question first.');
  draft.question = '  Lunch?  ';
  check('a question alone still needs options', draftProblem(draft) === 'Give at least 2 options.');
  draft.options[0].text = 'Soup';
  draft.options[1].text = '   ';
  check('blank options do not count', draftProblem(draft) === 'Give at least 2 options.');
  draft.options[1].text = 'Salad';
  draft.options[1].emoji = ' 🥗 ';
  check('a complete form can be sent', draftProblem(draft) === null);
  draft = withAddedOption(draft);
  check('a spare row is dropped from the request, text and emoji are trimmed', (() => {
    const body = toCreatePollBody(draft);
    return body.question === 'Lunch?' && body.options.length === 2 && body.options[0].emoji === null && body.options[1].emoji === '🥗' && body.durationHours === 24;
  })());
  check('the request the form builds passes the server schema', createPollSchema.safeParse(toCreatePollBody(draft)).success);
  while (draft.options.length < POLL_LIMITS.optionsMax) draft = withAddedOption(draft);
  check('options stop at ten', withAddedOption(draft).options.length === 10);
  check('rows keep distinct keys', new Set(draft.options.map((o) => o.key)).size === 10);
  let shrunk = draft;
  for (const option of [...draft.options]) shrunk = withoutOption(shrunk, option.key);
  check('options stop at two', shrunk.options.length === 2);
  const noExpiry = { ...newPollDraft(), question: 'q', durationHours: null };
  noExpiry.options[0].text = 'a';
  noExpiry.options[1].text = 'b';
  check('no expiry is sent as null and accepted', toCreatePollBody(noExpiry).durationHours === null && createPollSchema.safeParse(toCreatePollBody(noExpiry)).success);
}

// Edit history word diff.
{
  const side = (parts, kinds) => parts.filter((p) => kinds.includes(p.kind)).map((p) => p.text).join('');
  const roundTrips = (a, b) => {
    const parts = diffWords(a, b);
    return side(parts, ['same', 'del']) === a && side(parts, ['same', 'add']) === b;
  };
  check('identical texts diff to one unchanged part', JSON.stringify(diffWords('same words', 'same words')) === '[{"kind":"same","text":"same words"}]');
  const ins = diffWords('hello world', 'hello brave world');
  check('an insertion is an add', ins.some((p) => p.kind === 'add' && p.text.includes('brave')) && !ins.some((p) => p.kind === 'del'));
  const del = diffWords('hello brave world', 'hello world');
  check('a deletion is a del', del.some((p) => p.kind === 'del' && p.text.includes('brave')) && !del.some((p) => p.kind === 'add'));
  const swap = diffWords('the cat sat', 'the dog sat');
  check('a replaced word is one del and one add', swap.filter((p) => p.kind === 'del').map((p) => p.text).join() === 'cat' && swap.filter((p) => p.kind === 'add').map((p) => p.text).join() === 'dog');
  check('the empty text diffs to a full insertion', JSON.stringify(diffWords('', 'new')) === '[{"kind":"add","text":"new"}]');
  check('a full deletion', JSON.stringify(diffWords('old', '')) === '[{"kind":"del","text":"old"}]');
  check('both empty is empty', diffWords('', '').length === 0);
  check('unicode and emoji survive', roundTrips('héllo 🎉 wörld 日本語', 'héllo 🎊 wörld 日本'));
  check('emoji are not split into halves', diffWords('a 😀', 'a 😁').every((p) => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(p.text)));
  check('markdown characters survive', roundTrips('**bold** and `code` > quote', '*bold* and `codes` > quote [x](y)'));
  check('markup is only ever text in the parts', diffWords('<b>x</b>', '<i>x</i>').every((p) => typeof p.text === 'string'));
  check('whitespace and newlines survive', roundTrips('a\n\nb  c', 'a\nb c\n'));
  check('a repeated token still round trips', roundTrips('a a a a b', 'a a b b b'));
  let big = '';
  for (let i = 0; i < 6000; i += 1) big += `word${i} `;
  let bigger = '';
  for (let i = 0; i < 6000; i += 1) bigger += `term${i} `;
  const started = Date.now();
  const huge = diffWords(big, bigger);
  check('a huge unrelated pair is bounded in time', Date.now() - started < 1500);
  check('and falls back to one removal and one addition', huge.filter((p) => p.kind === 'del').length === 1 && huge.filter((p) => p.kind === 'add').length === 1);
  const long = 'x'.repeat(MAX_DIFF_CHARS * 3);
  check('over-long text is cut to the cap', side(diffWords(long, long + 'y'), ['same', 'del']).length <= MAX_DIFF_CHARS);
  // The cap falls one unit before an astral character, so a naive cut would
  // keep its high surrogate and drop the low half.
  const straddle = `${'x'.repeat(MAX_DIFF_CHARS - 1)}😀tail`;
  check(
    'a cut at the cap never leaves a lone surrogate half',
    diffWords(straddle, straddle).every((p) => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(p.text)),
  );
}

// --- Server gifs: tags, search, ordering and reordering ---
{
  check('tags split on commas and spaces, lower-cased', JSON.stringify(parseTags('Hello, wave  HELLO,Dance')) === JSON.stringify(['hello', 'wave', 'dance']));
  check('blank tag input is no tags', parseTags('  , ,').length === 0);
  check('tags stop at the limit the server enforces', parseTags(Array.from({ length: 30 }, (_, i) => 't' + i).join(' ')).length === MAX_TAGS);
  check('a long tag is cut to the server limit', parseTags('x'.repeat(80))[0]?.length === 30);
  check('tags round-trip through the text field', JSON.stringify(parseTags(formatTags(['a', 'b c']))) === JSON.stringify(['a', 'b', 'c']));
  check('parsed tags satisfy the shared schema', addServerGifSchema.safeParse({ url: 'https://static.klipy.com/x.gif', tags: parseTags('A, b'), name: 'x' }).success);

  const gif = { name: 'Cat Dance', tags: ['feline', 'funny'], filename: 'tmp-123.gif' };
  check('search matches the name', matchesServerGif(gif, 'cat'));
  check('search matches a tag', matchesServerGif(gif, 'FELI'));
  check('search matches the filename', matchesServerGif(gif, 'tmp-12'));
  check('search ignores surrounding spaces', matchesServerGif(gif, '  dance '));
  check('an empty search matches everything', matchesServerGif(gif, '   '));
  check('a non-matching search does not match', !matchesServerGif(gif, 'dog'));

  const list = [
    { id: 'a', pinned: false, position: 1 },
    { id: 'b', pinned: false, position: 0 },
    { id: 'c', pinned: true, position: 5 },
    { id: 'd', pinned: true, position: 2 },
  ];
  check('pinned gifs lead, each run by position', orderCurated(list).map((g) => g.id).join('') === 'dcba');
  check('ordering does not mutate its input', list[0].id === 'a');
  const ordered = orderCurated(list);
  check('a gif moves up one place', moveInOrder(ordered, 'a', -1).join('') === 'dcab');
  check('a gif moves down one place', moveInOrder(ordered, 'd', 1).join('') === 'cdba');
  check('the first gif cannot move up', moveInOrder(ordered, 'd', -1).join('') === 'dcba');
  check('the last gif cannot move down', moveInOrder(ordered, 'a', 1).join('') === 'dcba');
  check('a gif never crosses from pinned to unpinned by moving', moveInOrder(ordered, 'c', 1).join('') === 'dcba');
  check('an unknown id changes nothing', moveInOrder(ordered, 'zz', 1).join('') === 'dcba');
  check('a reorder body is accepted by the shared schema', updateServerGifSchema.safeParse({ position: 3 }).success && !updateServerGifSchema.safeParse({}).success);

  check('a curated tile loads the stored copy', serverGifUrl({ id: 'g1', source: 'curated' }) === '/api/v1/gifs/server/g1/image');
  check('an auto tile loads its attachment', serverGifUrl({ id: 'at1', source: 'auto' }) === '/api/v1/attachments/at1');
}

{
  // Where a linked gif is drawn from.
  const url = 'https://media.giphy.com/media/a/giphy.gif?cid=1&ep=v1';
  const copy = `/api/v1/gifs/copy?url=${encodeURIComponent(url)}`;
  check('the copy address carries the whole link, query included', gifCopyUrl(url) === copy && copy.includes('%3Fcid%3D1%26ep%3Dv1'));
  const linkMode = linkedGifSources('link', url, 'image/gif');
  check('link mode: the remote first, this server\'s copy if it is gone', linkMode.primary === url && linkMode.fallback === copy);
  const storeMode = linkedGifSources('store', url, 'image/gif');
  check('store mode: this server\'s copy, nothing else', storeMode.primary === copy && storeMode.fallback === null);
  const linkClip = linkedGifSources('link', url, 'video/mp4');
  check('link mode: a clip has no copy to fall back to', linkClip.primary === url && linkClip.fallback === null);
  const storeClip = linkedGifSources('store', url, 'video/webm');
  check('store mode: a clip cannot be copied, so the link is shown', storeClip.primary === null && storeClip.fallback === null);
  const unknown = linkedGifSources(undefined, url, 'image/gif');
  check('before the instance settings are known nothing is loaded', unknown.primary === null && unknown.fallback === null);
}


// ---- Server events: grouping, labels and the form ----
{
  const evNow = Date.UTC(2025, 11, 24, 15, 0, 0);
  const hour = 3_600_000;
  const ev = (id, status, startsAt, endsAt = null) => ({
    id,
    status,
    startsAt,
    endsAt,
    title: id,
    description: '',
    locationKind: 'external',
    channelId: null,
    locationText: 'Park',
    interestedCount: 0,
    interested: false,
  });

  const grouped = groupEvents([
    ev('later', 'scheduled', evNow + 5 * hour),
    ev('soon', 'scheduled', evNow + hour),
    ev('live-b', 'active', evNow - hour),
    ev('live-a', 'active', evNow - 2 * hour),
    ev('old', 'ended', evNow - 30 * hour, evNow - 28 * hour),
    ev('older', 'canceled', evNow - 60 * hour),
    ev('newest-past', 'ended', evNow - 5 * hour, evNow - 3 * hour),
  ]);
  check('events are grouped into now, upcoming and past', grouped.now.length === 2 && grouped.upcoming.length === 2 && grouped.past.length === 3);
  check('now and upcoming are soonest first', grouped.now.map((e) => e.id).join() === 'live-a,live-b' && grouped.upcoming.map((e) => e.id).join() === 'soon,later');
  check('past is most recent first', grouped.past.map((e) => e.id).join() === 'newest-past,old,older');
  check('a canceled event is past', eventGroup({ status: 'canceled' }) === 'past');
  check('the interested label reads naturally', interestedLabel(0) === 'No one yet' && interestedLabel(1) === '1 interested' && interestedLabel(12) === '12 interested');
  check('the status pill is a word', eventStatusLabel('active') === 'Happening now' && eventStatusLabel('canceled') === 'Canceled');

  // Applying a broadcast keeps the viewer's own interest unless it was theirs that changed.
  const held = [{ ...ev('x', 'scheduled', evNow + hour), interested: true, interestedCount: 1 }];
  const others = applyEventUpdate(held, { event: { ...ev('x', 'scheduled', evNow + hour), interestedCount: 2 }, rsvpUserId: 'someone', rsvpInterested: true }, 'me');
  check('someone else\'s RSVP updates the count and keeps my flag', others[0].interestedCount === 2 && others[0].interested === true);
  const mine = applyEventUpdate(others, { event: { ...ev('x', 'scheduled', evNow + hour), interestedCount: 1 }, rsvpUserId: 'me', rsvpInterested: false }, 'me');
  check('my own RSVP from another session flips my flag', mine[0].interested === false && mine[0].interestedCount === 1);
  const fresh = applyEventUpdate([], { event: ev('new', 'scheduled', evNow + hour), rsvpUserId: null, rsvpInterested: null }, 'me');
  check('an unknown event is added, not interested', fresh.length === 1 && fresh[0].interested === false);
  check('an event can be removed', removeEvent(fresh, 'new').length === 0);

  // Describing the time in the reader's zone.
  const zone = { now: evNow, locale: 'en-US', timeZone: 'UTC' };
  check('a start today reads as today with the zone', describeEventTime({ startsAt: evNow + 2 * hour, endsAt: null }, zone) === 'Today at 5:00 PM (UTC)');
  check('a same-day end adds only the clock time', describeEventTime({ startsAt: evNow + 2 * hour, endsAt: evNow + 4 * hour }, zone) === 'Today at 5:00 PM (UTC) to 7:00 PM');
  check('an end on another day spells that day out', describeEventTime({ startsAt: evNow + 2 * hour, endsAt: evNow + 30 * hour }, zone) === 'Today at 5:00 PM (UTC) to Tomorrow at 9:00 PM (UTC)');
  check('the same instant reads differently per zone', describeEventTime({ startsAt: evNow, endsAt: null }, { ...zone, timeZone: 'Asia/Tokyo' }).includes('Tokyo') && describeEventTime({ startsAt: evNow, endsAt: null }, { ...zone, timeZone: 'Asia/Tokyo' }).includes('12:00 AM'));
  check('a reminder says how long is left', reminderText({ title: 'Game night', startsAt: evNow + 15 * 60_000 }, evNow) === 'Game night starts in 15 minutes.');
  check('a reminder under a minute still says one minute', reminderText({ title: 'Game night', startsAt: evNow + 10_000 }, evNow) === 'Game night starts in 1 minute.');
  check('a reminder after the start says it is starting', reminderText({ title: 'Game night', startsAt: evNow - 1000 }, evNow) === 'Game night is starting now.');

  // The form.
  let draft = newEventDraft(evNow);
  check('a new draft starts about an hour out, on a five-minute mark', draft.startsAt === evNow + hour && draft.locationKind === 'external');
  check('a new draft asks for a title first', eventDraftProblem(draft, evNow) === 'Give the event a title.');
  draft.title = '  Game night ';
  check('then for a place', eventDraftProblem(draft, evNow) === 'Say where it takes place.');
  draft.locationText = ' The park ';
  check('a complete draft can be sent', eventDraftProblem(draft, evNow) === null);
  check('the create request is trimmed and passes the server schema', (() => {
    const body = toCreateEventBody(draft);
    return body.title === 'Game night' && body.locationText === 'The park' && body.channelId === null && createEventSchema.safeParse(body).success;
  })());
  draft.startsAt = evNow - 1000;
  check('a start in the past is a problem when creating', eventDraftProblem(draft, evNow) === 'The start has to be in the future.');
  check('but not when editing an event already under way', eventDraftProblem(draft, evNow, true) === null);
  draft.startsAt = evNow + hour;
  draft.endsAt = evNow + hour;
  check('an end at or before the start is a problem', eventDraftProblem(draft, evNow) === 'The end has to come after the start.');
  draft.endsAt = evNow + hour + 40 * 86_400_000;
  check('an end over 30 days after the start is a problem', eventDraftProblem(draft, evNow) === 'Events can run for up to 30 days.');
  draft.endsAt = null;
  draft.startsAt = evNow + 400 * 86_400_000;
  check('a start over a year ahead is a problem', eventDraftProblem(draft, evNow) === 'Events can start up to a year ahead.');
  draft.startsAt = null;
  check('an incomplete start is a problem', eventDraftProblem(draft, evNow) === 'Pick a start date and time.');
  const channelDraft = { ...newEventDraft(evNow, 'chan-1'), title: 'In channel' };
  check('a channel draft sends its channel and no place', (() => {
    const body = toCreateEventBody(channelDraft);
    return body.locationKind === 'channel' && body.channelId === 'chan-1' && body.locationText === '' && createEventSchema.safeParse(body).success;
  })());
  check('a channel draft without a channel is a problem', eventDraftProblem({ ...channelDraft, channelId: null }, evNow) === 'Pick a channel.');

  const original = { ...ev('e1', 'scheduled', evNow + hour), title: 'Old title', description: 'Old', locationText: 'Park' };
  const same = draftFromEvent(original);
  check('an untouched edit sends nothing', Object.keys(toUpdateEventBody(same, original)).length === 0);
  const changed = { ...same, title: 'New title', endsAt: evNow + 3 * hour };
  const patch = toUpdateEventBody(changed, original);
  check('an edit sends only what changed', patch.title === 'New title' && patch.endsAt === evNow + 3 * hour && patch.description === undefined && patch.startsAt === undefined && patch.locationKind === undefined);
  check('clearing the end is sent as null', toUpdateEventBody({ ...same, endsAt: null }, { ...original, endsAt: evNow + 3 * hour }).endsAt === null);
  const moved = toUpdateEventBody({ ...same, locationKind: 'channel', channelId: 'c9' }, original);
  check('changing the place kind sends the new place', moved.locationKind === 'channel' && moved.channelId === 'c9' && moved.locationText === undefined && updateEventSchema.safeParse(moved).success);
  check('an edit request passes the server schema', updateEventSchema.safeParse(patch).success);
}

// --- The update check's version comparison ---
{
  check('a version file is read for its version', parseVersionFile("export const HARMONY_VERSION = '1.25.0';") === '1.25.0');
  check('a file with no version reads as none', parseVersionFile('export const OTHER = 1;') === null);
  check('a newer patch is newer', isNewerVersion('1.24.3', '1.24.2'));
  check('a newer minor is newer', isNewerVersion('1.25.0', '1.24.9'));
  check('a newer major is newer', isNewerVersion('2.0.0', '1.99.99'));
  check('the same version is not newer', !isNewerVersion('1.24.2', '1.24.2'));
  check('an older version is not newer', !isNewerVersion('1.23.9', '1.24.0'));
  check('a missing part pads with zeros', !isNewerVersion('1.24', '1.24.0') && isNewerVersion('1.24.1', '1.24'));
  check('a non-numeric part counts as zero, not a false update', !isNewerVersion('1.24.x', '1.24.0'));
}

// --- Profile social links ---
{
  check('a handle becomes a fixed-base link', socialLink('github', 'octocat') === 'https://github.com/octocat');
  check('a youtube handle uses the @ base', socialLink('youtube', 'somechannel') === 'https://youtube.com/@somechannel');
  check('a website is used as given', socialLink('website', 'https://example.com/me') === 'https://example.com/me');
  check('a non-http website is refused', socialLink('website', 'javascript:alert(1)') === null);
  check('an empty value is no link', socialLink('github', '') === null && socialLink('github', undefined) === null);
  check(
    'a handle with a slash or space is refused',
    !validSocialValue('github', 'a/b') && !validSocialValue('github', 'a b'),
  );
}

// --- Files carried by a paste or a drop ---
{
  // A fresh object each call, as a browser builds one per source and encoding.
  const image = (over = {}) => ({ name: 'image.png', size: 4096, type: 'image/png', lastModified: 111, ...over });
  const fake = (items, files) => ({ items: items.map((file) => ({ kind: 'file', getAsFile: () => file })), files });
  // The files list is authoritative while it has anything; items is ignored, which
  // is what stops a picture offered once through each source from attaching twice.
  check('files is used when present, items is ignored', (() => {
    const got = mediaFilesFrom(fake([image({ name: 'a.png' })], [image({ name: 'b.png' })]));
    return got.length === 1 && got[0].name === 'b.png';
  })());
  check('a paste that only fills items is still read', mediaFilesFrom(fake([image()], [])).length === 1);
  check('two different images in files are both kept', mediaFilesFrom(fake([], [image({ size: 1 }), image({ size: 2 })])).length === 2);
  check('two different images in items are both kept', mediaFilesFrom(fake([image({ size: 1 }), image({ size: 2 })], [])).length === 2);
  check('the same image listed twice in one source is taken once', mediaFilesFrom(fake([], [image(), image()])).length === 1);
  check('a non-media file is left out', mediaFilesFrom(fake([], [image({ type: 'application/pdf', name: 'a.pdf' })])).length === 0);
  check('no clipboard means no files', mediaFilesFrom(null).length === 0);
}

// --- Launch parameters: a notification tap or a deep link ---
{
  const parsed = parseLaunchParams('?channel=c1&message=m1');
  check('a launch link names its channel and message', parsed.channelId === 'c1' && parsed.messageId === 'm1');
  const channelOnly = parseLaunchParams('?channel=c1');
  check('a link may name only a channel', channelOnly.channelId === 'c1' && channelOnly.messageId === null);
  check('a link naming nothing yields nothing', parseLaunchParams('').channelId === null);
  check('a blank id is treated as absent', parseLaunchParams('?channel=&message=').messageId === null);
  check('an id is trimmed', parseLaunchParams('?channel=%20c1%20').channelId === 'c1');
  check('a message without a channel is still read', parseLaunchParams('?message=m1').messageId === 'm1');
  check('an unrelated parameter is ignored', parseLaunchParams('?discord=linked').channelId === null);
  check('hasLaunchTarget spots a channel alone', hasLaunchTarget(parseLaunchParams('?channel=c1')));
  check('hasLaunchTarget is false when nothing is named', !hasLaunchTarget(parseLaunchParams('?voice=off')));

  check('the strip takes the launch parameters out', withoutLaunchParams('?channel=c1&message=m1') === '');
  check(
    'the strip keeps other parameters',
    withoutLaunchParams('?channel=c1&discord=linked&message=m1') === '?discord=linked',
  );
  check('the strip of a clean search changes nothing', withoutLaunchParams('?discord=linked') === '?discord=linked');
  check('the strip of an empty search is empty', withoutLaunchParams('') === '');
}

// --- Message times: the day beside the clock, and the date lines ---
{
  const zone = { locale: 'en-GB', timeZone: 'Europe/London' };
  const now = Date.parse('2026-10-22T09:00:00Z');
  const at = (iso) => Date.parse(iso);
  check('a day key is the calendar day in the zone', dayKey(at('2026-10-21T23:30:00Z'), 'Europe/London') === '2026-10-22');
  check('the same instant is another day elsewhere', dayKey(at('2026-10-21T23:30:00Z'), 'America/New_York') === '2026-10-21');
  check('the clock alone is hours and minutes', clockTime(at('2026-10-22T08:05:00Z'), zone) === '09:05');
  check('a message from today shows only its time', messageTimeLabel(at('2026-10-22T07:15:00Z'), { ...zone, now }) === '08:15');
  check(
    'a message from yesterday says so',
    messageTimeLabel(at('2026-10-21T20:00:00Z'), { ...zone, now }) === 'Yesterday at 21:00',
  );
  check(
    'an older message carries its date',
    messageTimeLabel(at('2026-09-03T11:00:00Z'), { ...zone, now }) === '03/09/2026 12:00',
  );
  // Clocks went back in London on 25 October 2026, so that day is 25 hours long.
  const afterChange = Date.parse('2026-10-26T00:30:00Z');
  check(
    'yesterday is the calendar day before, across a clock change',
    messageTimeLabel(at('2026-10-25T00:10:00Z'), { ...zone, now: afterChange }).startsWith('Yesterday at'),
  );
  check(
    'yesterday reaches back across a year end',
    messageTimeLabel(at('2026-12-31T22:00:00Z'), { ...zone, now: at('2027-01-01T10:00:00Z') }) === 'Yesterday at 22:00',
  );
  check('the tooltip names the full date', messageTimeTitle(at('2026-10-21T20:00:00Z'), zone).includes('21 October 2026'));
  check('a date line reads as a date', dayDividerLabel(at('2026-10-21T20:00:00Z'), zone) === '21 October 2026');

  const row = (createdAt, grouped = true) => ({ message: { createdAt }, grouped });
  const rows = withDayStarts(
    [row('2026-10-21T20:00:00Z', false), row('2026-10-21T20:03:00Z'), row('2026-10-22T08:00:00Z'), row('2026-10-22T08:01:00Z')],
    false,
    'Europe/London',
  );
  check('a new day opens where the date changes', rows.map((entry) => entry.dayStart).join() === 'false,false,true,false');
  check('the first message of a day starts a fresh group', rows[2].grouped === false && rows[3].grouped === true);
  check('a row inside a day keeps its grouping', rows[1].grouped === true);
  check(
    'the first row opens its day only when the list reaches the start of the channel',
    withDayStarts([row('2026-10-21T20:00:00Z', false)], true, 'Europe/London')[0].dayStart === true,
  );
  check(
    'grouping across midnight is broken by the date line',
    withDayStarts([row('2026-10-21T22:58:00Z', false), row('2026-10-21T23:02:00Z')], false, 'Europe/London')[1].grouped === false,
  );
}

// --- Channel history: back and forward between the channels opened ---

/**
 * A session history and an app wired the way ChannelHistory wires them, to
 * check whole sequences rather than single decisions. The tab came from
 * another page, so stepping back past the app's first entry leaves it.
 *
 * The installed app has no page before its first entry: a press there closes
 * the app, which the browser does by itself, while a step the app takes there
 * goes nowhere. So it matters there that the page is never left sitting on a
 * marker it no longer needs, where the press that should close the app would
 * only reach the entry beneath.
 *
 * The app's quiet step back off a marker lands at once here, where a browser
 * lands it a moment later; nothing else happens in between in these sequences.
 */
function historySession(channelIds, { installed = false } = {}) {
  const known = new Set(channelIds);
  const foreign = { foreign: true };
  const entries = installed ? [] : [foreign];
  let at = 0;
  let active = null;
  /** How many layers are open over the chat. */
  let depth = 0;
  /** The entry the app last saw itself on. */
  let here = null;
  let left = false;
  let closed = false;
  const current = () => readEntry(entries[at] ?? null);
  const push = (entry) => {
    entries.splice(at + 1, entries.length, writeEntry(null, entry));
    at += 1;
    here = entry;
  };
  /** Pushes made without a click, which Chrome's back button punishes. */
  let unclicked = 0;
  // The component's effect, which runs whenever the open channel or what is
  // open over it changes. `clicked` is whether a person has just acted.
  const sync = (clicked = true) => {
    const now = current();
    const visit = planVisit(now, active, now !== null && known.has(now.channelId), here?.index ?? 0);
    if (visit?.op === 'push') {
      if (!clicked) unclicked += 1;
      push(visit.entry);
    } else if (visit) {
      entries[at] = writeEntry(entries[at] ?? null, visit.entry);
      here = visit.entry;
    }
    const marker = planOverlay(current(), active, depth, clicked);
    if (marker) push(marker);
    if (stepsOffMarker(current(), active, depth)) {
      at -= 1;
      here = current();
      sync();
    }
  };
  /** A step: a press when `pressed`, otherwise one the app takes itself. */
  const go = (step, pressed = true) => {
    const target = at + step;
    if (target < 0 && pressed) closed = true;
    if (target < 0 || target >= entries.length) return;
    at = target;
    if (entries[at] === foreign) {
      left = true;
      return;
    }
    const popped = readEntry(entries[at]);
    const from = here;
    here = popped;
    const direction = stepDirection(from?.index ?? 0, popped.index);
    const action = popAction(popped, active, known.has(popped.channelId), direction, depth);
    if (action === 'close') {
      const forward = returnAfterClose(popped, from, active);
      depth = popped.depth;
      if (forward !== null) {
        at += forward;
        here = current();
      }
      // A step is no click, whatever pressed it.
      sync(false);
      return;
    }
    if (action === 'stale') {
      here = { ...popped, channelId: active };
      entries[at] = writeEntry(entries[at], here);
    }
    if (action === 'open') {
      depth = 0;
      active = popped.channelId;
      sync();
    } else if (mayCarryOn(direction, popped.index, from, active)) go(direction, false);
  };
  // The page loads on an entry the browser made, with no state of ours yet.
  entries.push(null);
  at = entries.length - 1;
  return {
    /** Opens a channel with nothing open over the chat, as the sidebar does on a wide screen. */
    open: (channelId) => {
      active = channelId;
      sync();
    },
    /** Opens a channel from something open over the chat, which closes it: a search result, a pick in the drawer. */
    jump: (channelId) => {
      depth = 0;
      active = channelId;
      sync();
    },
    /** Opens one more layer over the chat: a panel or drawer, then the lightbox over it. */
    show: () => {
      depth += 1;
      sync();
    },
    /** Something that opens by itself, with no click: the notes after an update. */
    appear: () => {
      depth += 1;
      sync(false);
    },
    /** Closes the top layer through its own controls: a close button, Escape, the backdrop. */
    dismiss: () => {
      depth -= 1;
      sync();
    },
    /** Reloads the page: nothing is open, and the channel comes back from the entry's state. */
    reload: () => {
      depth = 0;
      here = current();
      active = here?.channelId ?? null;
      sync();
    },
    go,
    remove: (channelId) => known.delete(channelId),
    get active() {
      return active;
    },
    get depth() {
      return depth;
    },
    get left() {
      return left;
    },
    /** Whether a press closed the installed app. */
    get closed() {
      return closed;
    },
    /** How many entries were pushed without a click. */
    get unclicked() {
      return unclicked;
    },
    /** How many entries are the app's, not counting the page it came from. */
    get length() {
      return entries.length - (installed ? 0 : 1);
    },
  };
}

{
  const entry = { channelId: 'c1', index: 2, depth: 0 };
  check('an entry round-trips through history state', JSON.stringify(readEntry(writeEntry(null, entry))) === JSON.stringify(entry));
  check('a null state holds no entry', readEntry(null) === null);
  check("someone else's state holds no entry", readEntry({ other: 1 }) === null);
  check('an entry with a blank channel is refused', readEntry(writeEntry(null, { channelId: '', index: 0, depth: 0 })) === null);
  check('an entry with a fractional index is refused', readEntry({ harmonyChannel: { channelId: 'c1', index: 0.5 } }) === null);
  check('writing keeps the rest of the state', writeEntry({ other: 1 }, entry).other === 1);
  const signed = { ...entry, userId: 'u1' };
  check('the account that wrote an entry round-trips', readEntry(writeEntry(null, signed))?.userId === 'u1');
  check("an entry is its writer's", ownedBy(signed, 'u1'));
  check('but not the next account to sign in', !ownedBy(signed, 'u2'));
  check("an entry with no account is anyone's", ownedBy(entry, 'u2'));
  check(
    'an entry with a non-string account reads as having none',
    readEntry({ harmonyChannel: { channelId: 'c1', index: 0, userId: 7 } })?.userId === undefined,
  );

  const first = planVisit(null, 'c1', false, 0);
  check('the first channel opened rewrites the entry the page loaded on', first?.op === 'replace' && first.entry.index === 0);
  const next = planVisit({ channelId: 'c1', index: 4, depth: 0 }, 'c2', true, 0);
  check('opening another channel adds an entry after the current one', next?.op === 'push' && next.entry.index === 5);
  const healed = planVisit({ channelId: 'gone', index: 4, depth: 0 }, 'c2', false, 0);
  check('a channel that took over from a gone one rewrites its entry', healed?.op === 'replace' && healed.entry.index === 4);
  check('the channel an entry already names adds nothing', planVisit({ channelId: 'c1', index: 4, depth: 0 }, 'c1', true, 0) === null);
  check('nothing open adds nothing', planVisit({ channelId: 'c1', index: 4, depth: 0 }, null, true, 0) === null);

  check('a step onto a gone channel is stale', popAction({ channelId: 'x', index: 1, depth: 0 }, 'c1', false, -1, 0) === 'stale');
  check('a step onto the open channel is skipped', popAction({ channelId: 'c1', index: 1, depth: 0 }, 'c1', true, -1, 0) === 'skip');
  check('a step onto another channel opens it', popAction({ channelId: 'c2', index: 1, depth: 0 }, 'c1', true, -1, 0) === 'open');
  check('a lower position is a step back', stepDirection(3, 2) === -1);
  check('a higher position is a step forward', stepDirection(2, 3) === 1);
  check('mouse button 3 is back and 4 is forward', mouseButtonStep(3) === -1 && mouseButtonStep(4) === 1);
  check('the main, middle and right buttons are not history', [0, 1, 2].every((button) => mouseButtonStep(button) === null));

  check('a back step may carry on while there are entries of ours behind', mayCarryOn(-1, 1));
  check('but never back past the first of them', !mayCarryOn(-1, 0));
  check('a forward step may carry on', mayCarryOn(1, 0));

  const walk = historySession(['a', 'b', 'c']);
  walk.open('a');
  walk.open('b');
  walk.open('c');
  check('three channels opened make three entries', walk.length === 3);
  walk.go(-1);
  check('back returns to the channel before', walk.active === 'b');
  walk.go(-1);
  check('back again returns to the first channel', walk.active === 'a');
  walk.go(1);
  check('forward goes the other way', walk.active === 'b');
  walk.open('a');
  check('opening a channel after going back drops the forward entries', walk.length === 3);
  walk.go(1);
  check('so there is nothing to go forward to', walk.active === 'a');
  walk.go(-1);
  check('and back is the channel left', walk.active === 'b');

  const gone = historySession(['a', 'b', 'c']);
  gone.open('a');
  gone.open('b');
  gone.open('c');
  gone.remove('b');
  gone.go(-1);
  check('back skips over a channel that has gone', gone.active === 'a');
  gone.go(1);
  check('and forward skips over it too', gone.active === 'c');

  const stuck = historySession(['a', 'b']);
  stuck.open('a');
  stuck.open('b');
  stuck.remove('a');
  stuck.go(-1);
  check('back with only gone channels behind stays in the app', stuck.active === 'b' && !stuck.left);

  const loop = historySession(['a', 'x']);
  loop.open('a');
  loop.open('x');
  loop.open('a');
  loop.remove('x');
  loop.go(-1);
  check('skipping a gone channel never steps back out of the app', !loop.left && loop.active === 'a');
  loop.go(-1);
  check('while an ordinary back from the first channel still leaves, as a browser does', loop.left);
}

// --- Per-member playback volume: the clamp and the stored map ---
{
  check('a volume at the default stays the default', clampVolume(VOICE_VOLUME_DEFAULT) === VOICE_VOLUME_DEFAULT);
  check('a volume above the maximum is clamped', clampVolume(5) === VOICE_VOLUME_MAX);
  check('a negative volume is clamped to silence', clampVolume(-1) === 0);
  check('a non-number volume falls back to the default', clampVolume(Number.NaN) === VOICE_VOLUME_DEFAULT);

  check('nothing stored reads as no overrides', Object.keys(parseVolumes(null)).length === 0);
  check('malformed storage reads as no overrides', Object.keys(parseVolumes('{oops')).length === 0);
  check('a stored non-object reads as no overrides', Object.keys(parseVolumes('42')).length === 0);
  check('a stored number is read back', parseVolumes('{"u2":0.5}')['u2'] === 0.5);
  check('a stored out-of-range number is clamped on read', parseVolumes('{"u2":9}')['u2'] === VOICE_VOLUME_MAX);
  check('a stored non-number entry is dropped', parseVolumes('{"u2":"loud"}')['u2'] === undefined);

  check(
    'the element stage carries the level up to full and caps at 1',
    elementVolumeFor(0.5) === 0.5 && elementVolumeFor(1) === 1 && elementVolumeFor(2) === 1,
  );
  check(
    'the graph stage is unity through the range and only lifts the boost',
    graphGainFor(0.5) === 1 && graphGainFor(1) === 1 && graphGainFor(2) === VOICE_VOLUME_MAX,
  );
  // The two stages must compose back to the level in range with no double
  // counting: the element's volume is applied before its source node, so the
  // net playback is the product. 0 fully silences, 1 is unity, >1 only boosts.
  for (const level of [0, 0.25, 0.5, 1, 1.5, 2]) {
    check(
      `the element volume and graph gain compose back to the level (${level})`,
      elementVolumeFor(level) * graphGainFor(level) === level,
    );
  }
  check('a deafened element is fully silent', elementVolumeFor(0) === 0);
  check('a deafened graph gain stays at unity', graphGainFor(0) === 1);
  // The helpers must not trust their caller to pre-clamp: a level outside
  // [0, 2] used to reach element.volume and throw IndexSizeError mid-loop (or
  // poison gain.value with NaN), so each one clamps on the way in.
  check(
    'the element stage never returns a negative or non-finite volume',
    elementVolumeFor(-1) === 0 &&
      elementVolumeFor(-Infinity) === VOICE_VOLUME_DEFAULT &&
      elementVolumeFor(Number.NaN) === VOICE_VOLUME_DEFAULT,
  );
  check('the element stage still caps an inflated level at 1', elementVolumeFor(9) === 1 && elementVolumeFor(Infinity) === 1);
  check(
    'the graph stage never returns below unity or a non-finite gain',
    graphGainFor(-1) === 1 &&
      graphGainFor(-Infinity) === 1 &&
      graphGainFor(Number.NaN) === 1 &&
      graphGainFor(Infinity) === 1,
  );
  check('the graph stage still caps an inflated level at the maximum', graphGainFor(9) === VOICE_VOLUME_MAX);

  // Deafening must win over any per-member gain, so a member turned up cannot
  // be heard through it; that rule is what a rebuilt connection now preserves.
  check('deafening silences a member who was boosted', effectiveLevel(true, VOICE_VOLUME_MAX) === 0);
  check('deafening silences a member at a partial level', effectiveLevel(true, 0.5) === 0);
  check('undeafened, the member keeps their own level', effectiveLevel(false, 0.5) === 0.5);
  check('deafening silences even an out-of-range volume', effectiveLevel(true, 9) === 0);
  check(
    'a deafened member is silent through both stages',
    elementVolumeFor(effectiveLevel(true, VOICE_VOLUME_MAX)) === 0 && graphGainFor(effectiveLevel(true, VOICE_VOLUME_MAX)) === 1,
  );

  check('only overrides are written', serializeVolumes({ u1: VOICE_VOLUME_DEFAULT, u2: 0 }) === '{"u2":0}');
  check('a map with no overrides writes nothing', serializeVolumes({ u1: VOICE_VOLUME_DEFAULT }) === null);
  check('an empty map writes nothing', serializeVolumes({}) === null);
  check('a write clamps out-of-range values', serializeVolumes({ u2: 9 }) === `{"u2":${VOICE_VOLUME_MAX}}`);

  const roundTrip = parseVolumes(serializeVolumes({ u2: 0.25, u3: 0 }));
  check('a written map reads back the same', roundTrip['u2'] === 0.25 && roundTrip['u3'] === 0);

  // A member id that names an Object.prototype property must not resolve to the
  // inherited value: the reads are by own key, so such a key is simply unset.
  for (const key of ['constructor', 'toString', 'valueOf', '__proto__']) {
    check(`a prototype-name key (${key}) reads as no override`, volumeOverride({}, key) === undefined);
    check(`a prototype-name key (${key}) supplies the default`, (volumeOverride({}, key) ?? VOICE_VOLUME_DEFAULT) === VOICE_VOLUME_DEFAULT);
    check(`a prototype-name key (${key}) is not adjusted`, (volumeOverride({}, key) !== undefined) === false);
  }
  check('an ordinary stored key still reads back', volumeOverride({ u2: 0.5 }, 'u2') === 0.5);
  check('a key absent from the stored map is undefined', volumeOverride(parseVolumes(null), 'u9') === undefined);
}

// --- What's new: the changelog, and when the dialog shows it ---
{
  // The data itself. Only the newest entry is ever shown, so the order matters,
  // and notes for a version newer than the build would never be shown to anyone.
  const versions = CHANGELOG.map((entry) => entry.version);
  check('the changelog has at least one entry', CHANGELOG.length > 0);
  check('every changelog version is three dotted numbers', versions.every((version) => CHANGELOG_VERSION_PATTERN.test(version)));
  check('changelog versions are unique', new Set(versions).size === versions.length);
  check(
    'the changelog is newest first, each version older than the one above it',
    versions.every((version, index) => index === 0 || isNewerVersion(versions[index - 1], version)),
  );
  check(
    'every changelog date is a real YYYY-MM-DD day',
    CHANGELOG.every(
      (entry) =>
        /^\d{4}-\d{2}-\d{2}$/.test(entry.date) &&
        !Number.isNaN(Date.parse(`${entry.date}T00:00:00Z`)) &&
        new Date(`${entry.date}T00:00:00Z`).toISOString().slice(0, 10) === entry.date,
    ),
  );
  check(
    'changelog dates never go forward down the list',
    CHANGELOG.every((entry, index) => index === 0 || CHANGELOG[index - 1].date >= entry.date),
  );
  check('every entry has a title', CHANGELOG.every((entry) => entry.title.trim().length > 0));
  check(
    'every entry says something, with no blank items',
    CHANGELOG.every((entry) => entry.items.length > 0 && entry.items.every((item) => item.trim().length > 0)),
  );
  check('the newest notes are not for a version newer than this build', !isNewerVersion(versions[0], HARMONY_VERSION));

  const latest = latestChangelog();
  const [major] = latest.version.split('.');
  const newer = `${Number(major) + 1}.0.0`;
  check('the latest entry is the first', latest === CHANGELOG[0]);
  check('someone who has seen nothing is shown the latest', changelogToShow(null) === latest);
  check('someone who saw an older version is shown the latest', changelogToShow('0.0.1') === latest);
  check('someone who saw the latest is shown nothing', changelogToShow(latest.version) === null);
  check('someone who saw a newer version is shown nothing', changelogToShow(newer) === null);

  check('the version pattern takes a release number', CHANGELOG_VERSION_PATTERN.test('2.9.0') && CHANGELOG_VERSION_PATTERN.test('10.0.12'));
  for (const bad of ['2.9', '2.9.0.1', 'v2.9.0', '02.9.0', '2.9.0 ', '', '2.x.0']) {
    check(`the version pattern refuses ${JSON.stringify(bad)}`, !CHANGELOG_VERSION_PATTERN.test(bad));
  }
  check('the seen request takes a version', changelogSeenSchema.safeParse({ version: '2.9.0' }).success);
  check('the seen request refuses a malformed one', !changelogSeenSchema.safeParse({ version: '2.9' }).success);
  check('the seen request refuses a missing one', !changelogSeenSchema.safeParse({}).success);

  // The browser's copy, and how it combines with the server's.
  check('each account has its own stored key', changelogSeenKey('u1') === 'harmony:changelog-seen:u1');
  check('nothing stored reads as nothing seen', readSeenMarker(null) === null);
  check('garbage in storage reads as nothing seen', readSeenMarker('soon') === null && readSeenMarker('') === null);
  check('a stored version reads back', readSeenMarker('2.9.0') === '2.9.0');
  check('the newer of nothing is nothing', newerSeen(null, null) === null);
  check('either side alone wins', newerSeen('2.8.3', null) === '2.8.3' && newerSeen(null, '2.9.0') === '2.9.0');
  check('the newer side wins, compared as numbers', newerSeen('2.10.0', '2.9.0') === '2.10.0' && newerSeen('2.9.0', '2.10.0') === '2.10.0');

  const plan = (server, stored) => planChangelog(server, stored);
  const fresh = plan(null, null);
  check('a member who has seen nothing anywhere is shown the latest', fresh.show === latest && fresh.report === null);
  check('a member the server has down for the latest is shown nothing', plan(latest.version, null).show === null);
  check('and nothing is sent', plan(latest.version, null).report === null);
  const missed = plan(null, latest.version);
  check('notes this browser showed are not shown again when the server missed it', missed.show === null);
  check('and the server is told what it missed', missed.report === latest.version);
  check('an older server copy is caught up too', plan('0.0.1', latest.version).report === latest.version);
  check('a server copy ahead of this browser is left alone', plan(latest.version, '0.0.1').report === null && plan(latest.version, '0.0.1').show === null);
  check('both up to date means nothing at all', plan(latest.version, latest.version).show === null && plan(latest.version, latest.version).report === null);
  check('garbage in storage does not hide the notes', plan(null, 'soon').show === latest);
  const rolledBack = plan(null, newer);
  check('a copy from a newer build hides the notes', rolledBack.show === null);
  check('but is not sent to a server that would refuse it', rolledBack.report === null);

  check('a changelog date reads as a day (en-GB)', formatChangelogDate('2026-10-22', 'en-GB') === '22 October 2026');
  check('a changelog date reads as a day (en-US)', formatChangelogDate('2026-10-22', 'en-US') === 'October 22, 2026');
  check('the first of a month stays on that day', formatChangelogDate('2026-01-01', 'en-GB') === '1 January 2026');
  check('an unreadable date is shown as written', formatChangelogDate('someday', 'en-GB') === 'someday');
}

// --- Jumping to any message: the page around it, and reading on to the present ---
{
  // A channel of 200 messages, m0 oldest, and the pages the server would answer
  // with: around a message as historyAroundSplit lays it out, and after one.
  const all = Array.from({ length: 200 }, (_, i) => ({
    id: `m${i}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
  const around = (i, limit = 50) => {
    const split = historyAroundSplit(limit);
    return all.slice(Math.max(0, i - split.before), i + split.after + 1);
  };
  const after = (id, limit = 50) => {
    const index = all.findIndex((message) => message.id === id);
    return all.slice(index + 1, index + 1 + limit);
  };
  const ids = (messages) => messages.map((message) => message.id).join(',');
  const span = (from, to) => ids(all.slice(from, to + 1));
  const newest = { messages: all.slice(150), hasMore: true };

  const split = historyAroundSplit(50);
  check('a page of 50 around a message is 25 before, it, and 24 after', split.before === 25 && split.after === 24);
  check('a page of one is the message alone', historyAroundSplit(1).before === 0 && historyAroundSplit(1).after === 0);
  check('a page of two takes the one before', historyAroundSplit(2).before === 1 && historyAroundSplit(2).after === 0);
  check('the largest page is 50 before and 49 after', historyAroundSplit(100).before === 50 && historyAroundSplit(100).after === 49);

  const old = windowAround(around(40), 'm40', 50, newest);
  check('an old message is shown with its page around it', ids(old.messages) === span(15, 64));
  check('a page that misses the present is an older stretch', old.detached === true);
  check('with older history above it', old.hasMore === true);

  const first = windowAround(around(3), 'm3', 50, newest);
  check('near the channel start the page begins at its first message', ids(first.messages) === span(0, 27));
  check('and has nothing older above it', first.hasMore === false && first.detached === true);

  const recent = windowAround(around(160), 'm160', 50, newest);
  check('a page that meets the present is joined to it', ids(recent.messages) === span(135, 199));
  check('and the reader is in the present', recent.detached === false && recent.hasMore === true);

  const latest = windowAround(around(190), 'm190', 50, null);
  check('a page whose newer side came back short reaches the present by itself', latest.detached === false);
  check('and keeps the messages it holds', ids(latest.messages) === span(165, 199));

  const longPresent = windowAround(around(120), 'm120', 50, { messages: all.slice(90), hasMore: false });
  check('a present reaching further back than the page is kept whole', ids(longPresent.messages) === span(90, 199));
  check('and it is the one that knows what is older', longPresent.hasMore === false);

  const raced = windowAround(around(190), 'm190', 50, { messages: all.slice(150, 199), hasMore: true });
  check(
    'a message newer than the present on screen lands at the end, once',
    ids(raced.messages) === span(150, 199) && raced.detached === false,
  );

  const small = all.slice(0, 10);
  const whole = windowAround(small, 'm5', 50, { messages: small, hasMore: false });
  check('a small channel is simply the whole channel', ids(whole.messages) === span(0, 9) && !whole.hasMore && !whole.detached);
  check('a page without the message is not laid out', windowAround(around(40), 'm999', 50, newest) === null);

  const forward = appendNewer(old.messages, after('m64'), 50);
  check('the page after an older stretch is appended', ids(forward.messages) === span(15, 114));
  check('a full page leaves it short of the present', forward.detached === true);
  const withLive = appendNewer([...old.messages, all[65]], after('m64'), 50);
  check('a message already held is not repeated', ids(withLive.messages) === span(15, 114));

  // Reading on from an old message gets back to the present with every message once.
  let view = windowAround(around(40), 'm40', 50, newest);
  let steps = 0;
  while (view.detached && steps < 10) {
    const next = appendNewer(view.messages, after(view.messages.at(-1).id), 50);
    view = { ...view, messages: next.messages, detached: next.detached };
    steps++;
  }
  check('reading on from an old message reaches the present', view.detached === false && steps === 3);
  check('with every message from the page on exactly once', ids(view.messages) === span(15, 199));

  // A link to a message, which the launch handling opens.
  const link = messageLink('https://chat.example.com', 'c1', 'm1');
  check('a message link is the launch link on the instance', link === 'https://chat.example.com/?channel=c1&message=m1');
  const linked = parseLaunchParams(new URL(link).search);
  check('the launch handling reads a message link back', linked.channelId === 'c1' && linked.messageId === 'm1');
  check(
    'an origin with a trailing slash does not double it',
    messageLink('https://chat.example.com/', 'c1', 'm1') === 'https://chat.example.com/?channel=c1&message=m1',
  );
  const odd = parseLaunchParams(new URL(messageLink('http://127.0.0.1:8787', 'a&b=c', 'd e/é?#')).search);
  check('ids are encoded so any id reads back unchanged', odd.channelId === 'a&b=c' && odd.messageId === 'd e/é?#');
  check('the strip after handling leaves nothing of a message link', withoutLaunchParams(new URL(link).search) === '');
}

// --- Marking a channel unread from a message ---
{
  const me = 'me';
  const at = (minute) => `2026-01-01T12:${String(minute).padStart(2, '0')}:00.000Z`;
  // The server puts the marker a millisecond before the message it is marked from.
  const markerBefore = (minute) => new Date(Date.parse(at(minute)) - 1).toISOString();
  const msg = (id, minute, author = 'them') => ({ id, createdAt: at(minute), author: { id: author } });
  const list = [msg('a', 1), msg('b', 2), msg('c', 3, me), msg('d', 4), msg('e', 5)];

  check('marked unread from a message, the line goes above it', firstUnreadIndex(list, markerBefore(2), me, false) === 1);
  check('and the bar counts it and everything after', newMessageCount(list, markerBefore(2), me, false).count === 3);
  check(
    'marked unread from your own message, the line goes above the next one by someone else',
    firstUnreadIndex(list, markerBefore(3), me, false) === 3,
  );
  check(
    'marked from your own last message, there is no line',
    firstUnreadIndex([msg('a', 1), msg('b', 2, me)], markerBefore(2), me, false) === -1,
  );
  check(
    'marked from the oldest message loaded, the line waits for older history unless there is none',
    firstUnreadIndex(list, markerBefore(1), me, false) === -1 && firstUnreadIndex(list, markerBefore(1), me, true) === 0,
  );

  const after = withChannelReadState(['x'], { x: 1 }, { channelId: 'c', unread: true, mentionCount: 2 });
  check('the channel joins the unread list', after.unreadChannelIds.join(',') === 'x,c');
  check('with its mention count', after.mentionCounts.c === 2 && after.mentionCounts.x === 1);
  const again = withChannelReadState(['c', 'x'], { c: 5 }, { channelId: 'c', unread: true, mentionCount: 1 });
  check('a channel already listed is not listed twice', again.unreadChannelIds.join(',') === 'c,x' && again.mentionCounts.c === 1);
  const read = withChannelReadState(['c', 'x'], { c: 5, x: 1 }, { channelId: 'c', unread: false, mentionCount: 0 });
  check('a channel left read drops off the list', read.unreadChannelIds.join(',') === 'x');
  check('and its count goes rather than reading zero', !('c' in read.mentionCounts) && read.mentionCounts.x === 1);
  const input = ['x'];
  const counts = { x: 1 };
  withChannelReadState(input, counts, { channelId: 'c', unread: true, mentionCount: 3 });
  check('the lists it was given are left alone', input.length === 1 && !('c' in counts));
}

// --- Global shortcuts: which key does what, and when the layer stays out of the way ---
{
  const press = (key, mods = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });
  const ctrl = (key, mods = {}) => press(key, { ctrlKey: true, ...mods });
  // A channel open, its message box ready, focus on nothing in particular and
  // nothing open over the chat.
  const calm = {
    handled: false,
    panel: false,
    dialog: false,
    popover: false,
    card: false,
    typing: false,
    inComposer: false,
    composerReady: true,
    channelOpen: true,
    hasNew: true,
    inVoice: false,
  };
  const scene = (changes = {}) => ({ ...calm, ...changes });
  const inComposer = scene({ typing: true, inComposer: true });
  const inOtherField = scene({ typing: true });
  const action = (pressed, where = calm) => globalShortcut(pressed, where)?.action ?? null;

  check('Ctrl+K opens the quick switcher', action(ctrl('k')) === 'switcher');
  check('Ctrl+K works from the message box', action(ctrl('k'), inComposer) === 'switcher');
  check('Cmd+K is taken the same as Ctrl+K', action(press('k', { metaKey: true })) === 'switcher');
  check('Ctrl+K stays quiet while a panel is open', action(ctrl('k'), scene({ panel: true })) === null);
  check('Ctrl+K closes the switcher it opened', action(ctrl('k'), scene({ dialog: true })) === 'switcher');

  check('Ctrl+F opens search', action(ctrl('f')) === 'search');
  check('Ctrl+F works from the message box', action(ctrl('f'), inComposer) === 'search');
  check('Ctrl+F works from any other text box', action(ctrl('f'), inOtherField) === 'search');
  check(
    'Ctrl+F inside a panel (search included) is left to the browser',
    action(ctrl('f'), scene({ panel: true })) === null,
  );
  check('Ctrl+Shift+F is not search', action(ctrl('F', { shiftKey: true })) === null);

  check('Ctrl+P opens the pins of the open channel', action(ctrl('p')) === 'pins');
  check('Ctrl+P works from the message box', action(ctrl('p'), inComposer) === 'pins');
  check('Ctrl+P with no channel open is left to the browser', action(ctrl('p'), scene({ channelOpen: false })) === null);

  check('Ctrl+I opens the inbox', action(ctrl('i')) === 'inbox');
  check('Ctrl+I in the message box is left to it (italic)', action(ctrl('i'), inComposer) === null);
  check('Ctrl+Shift+I is the browser’s, not the inbox', action(ctrl('I', { shiftKey: true })) === null);
  check('Ctrl+U shows or hides the member list', action(ctrl('u')) === 'members');
  check('Ctrl+U in the message box is left to it (underline)', action(ctrl('u'), inComposer) === null);
  check('Ctrl+Shift+U is not the member list', action(ctrl('U', { shiftKey: true })) === null);
  check('Ctrl+U stays quiet while a panel is open', action(ctrl('u'), scene({ panel: true })) === null);

  check('Ctrl+/ opens the shortcut list', action(ctrl('/')) === 'help');
  check('Ctrl+/ toggles the list while it is open', action(ctrl('/'), scene({ dialog: true })) === 'help');
  check('Ctrl+/ in a text box is left alone', action(ctrl('/'), inComposer) === null);
  check('Escape closes the switcher or the list', action(press('Escape'), scene({ dialog: true })) === 'close-dialog');
  check('the switcher takes nothing else', action(ctrl('f'), scene({ dialog: true })) === null);

  const down = globalShortcut(press('ArrowDown', { altKey: true }), calm);
  check('Alt+Down is the next channel', down?.action === 'step' && down.direction === 1 && !down.unreadOnly);
  const upUnread = globalShortcut(press('ArrowUp', { altKey: true, shiftKey: true }), calm);
  check(
    'Alt+Shift+Up is the previous unread channel',
    upUnread?.action === 'step' && upUnread.direction === -1 && upUnread.unreadOnly,
  );
  check('Alt+Down in a text box is left alone', action(press('ArrowDown', { altKey: true }), inComposer) === null);

  check('Escape marks the open channel read', action(press('Escape')) === 'dismiss-new');
  check('Escape with nothing new does nothing', action(press('Escape'), scene({ hasNew: false })) === null);
  check('Escape with no channel open does nothing', action(press('Escape'), scene({ channelOpen: false })) === null);
  check('Escape the composer used is not taken again', action(press('Escape'), scene({ ...inComposer, handled: true })) === null);
  check('Escape the composer let through marks read', action(press('Escape'), inComposer) === 'dismiss-new');
  check('Escape in another text box is left to it', action(press('Escape'), inOtherField) === null);
  check('Escape while a menu or picker is open is left to it', action(press('Escape'), scene({ popover: true })) === null);
  check('Escape while a profile card shows is left to it', action(press('Escape'), scene({ card: true })) === null);
  check('Escape while a panel is open closes it', action(press('Escape'), scene({ panel: true })) === 'close-panel');
  check(
    'Escape over a panel closes it even from a text box inside it',
    action(press('Escape'), scene({ panel: true, typing: true })) === 'close-panel',
  );
  check('Shift+Escape over a panel does nothing', action(press('Escape', { shiftKey: true }), scene({ panel: true })) === null);
  check('Ctrl+Escape over a panel does nothing', action(press('Escape', { ctrlKey: true }), scene({ panel: true })) === null);
  check('a key already used over a panel is left alone', action(press('Escape'), scene({ panel: true, handled: true })) === null);
  check(
    "Escape closes a phone's drawer",
    action(press('Escape'), scene({ popover: true, drawer: true })) === 'close-panel',
  );
  check(
    'but not while a profile card shows over it',
    action(press('Escape'), scene({ popover: true, drawer: true, card: true })) === null,
  );
  check('Shift+Escape marks every channel read', action(press('Escape', { shiftKey: true })) === 'read-all');
  check(
    'Shift+Escape marks every channel read even with nothing new here',
    action(press('Escape', { shiftKey: true }), scene({ hasNew: false })) === 'read-all',
  );
  check(
    'Shift+Escape while a menu is open is left to it',
    action(press('Escape', { shiftKey: true }), scene({ popover: true })) === null,
  );

  const inVoice = scene({ inVoice: true });
  check('Ctrl+Shift+M mutes in voice', action(ctrl('M', { shiftKey: true }), inVoice) === 'mute');
  check('Ctrl+Shift+D deafens in voice', action(ctrl('D', { shiftKey: true }), inVoice) === 'deafen');
  check(
    'Ctrl+Shift+M works from the message box',
    action(ctrl('M', { shiftKey: true }), scene({ ...inComposer, inVoice: true })) === 'mute',
  );
  check(
    'Ctrl+Shift+D works with a panel open',
    action(ctrl('D', { shiftKey: true }), scene({ panel: true, inVoice: true })) === 'deafen',
  );
  check('Ctrl+Shift+M out of voice is left to the browser', action(ctrl('M', { shiftKey: true })) === null);
  check('Ctrl+M without Shift is not mute', action(ctrl('m'), inVoice) === null);

  check('a letter typed with nothing focused goes to the message box', action(press('a')) === 'type');
  check('a capital letter does too', action(press('A', { shiftKey: true })) === 'type');
  check('so does punctuation, which starts a slash command', action(press('/')) === 'type');
  check('a letter typed while a profile card shows still goes there', action(press('a'), scene({ card: true })) === 'type');
  check('a letter typed in a text box stays there', action(press('a'), inComposer) === null);
  check('a letter typed with a menu open is the menu’s', action(press('a'), scene({ popover: true })) === null);
  check('a letter typed in the switcher is the switcher’s', action(press('a'), scene({ dialog: true })) === null);
  check('a letter typed over a panel is the panel’s', action(press('a'), scene({ panel: true })) === null);
  check('a letter typed with no usable message box goes nowhere', action(press('a'), scene({ composerReady: false })) === null);
  check('a key already used is not taken again', action(press('a'), scene({ handled: true })) === null);

  check('one character types', typesCharacter(press('x')));
  check('an emoji outside the basic plane is one character', typesCharacter(press('\u{1F600}')));
  check('Space does not type into the box, so a list can still scroll', !typesCharacter(press(' ')));
  check('a named key does not type', !typesCharacter(press('Enter')) && !typesCharacter(press('ArrowDown')));
  check('a dead key does not type', !typesCharacter(press('Dead')));
  check('Ctrl plus a letter is a shortcut, not typing', !typesCharacter(ctrl('c')));
  check('Alt plus a letter is not typing', !typesCharacter(press('x', { altKey: true })));
  check('Cmd plus a letter is not typing', !typesCharacter(press('v', { metaKey: true })));
  check('AltGr, reported as Ctrl and Alt, types', typesCharacter(press('@', { ctrlKey: true, altKey: true, altGraph: true })));
}

// --- The message box's own keys: formatting and the Up arrow ---
{
  const press = (key, extra = {}) => ({ key, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...extra });
  check('Ctrl+B, Ctrl+I and Ctrl+U are bold, italic and underline', formatForKey(press('b')) === 'bold' && formatForKey(press('i')) === 'italic' && formatForKey(press('u')) === 'underline');
  check('Cmd works where Ctrl does', formatForKey(press('B', { ctrlKey: false, metaKey: true })) === 'bold');
  check('Shift or Alt makes it some other shortcut', formatForKey(press('u', { shiftKey: true })) === null && formatForKey(press('b', { altKey: true })) === null);
  check('a plain letter is not a format', formatForKey(press('b', { ctrlKey: false })) === null);
  check('the markers are the ones the parser reads', FORMAT_MARKERS.bold === '**' && FORMAT_MARKERS.italic === '*' && FORMAT_MARKERS.underline === '__');

  const at = (text, start, end = start) => ({ text, start, end });
  const same = (got, text, start, end) => got.text === text && got.start === start && got.end === end;

  check('wrapping a word keeps it selected', same(toggleFormat(at('say hello now', 4, 9), 'bold'), 'say **hello** now', 6, 11));
  check('nothing selected puts the pair in with the caret between', same(toggleFormat(at('ab', 1), 'italic'), 'a**b', 2, 2));
  check('an empty box gets the pair', same(toggleFormat(at('', 0), 'underline'), '____', 2, 2));
  check('a second press takes the markers off the selected words', same(toggleFormat(at('say **hello** now', 6, 11), 'bold'), 'say hello now', 4, 9));
  check('selecting the markers too takes them off as well', same(toggleFormat(at('say **hello** now', 4, 13), 'bold'), 'say hello now', 4, 9));
  check('spaces at the edges stay outside the markers', same(toggleFormat(at('a  word  b', 1, 8), 'bold'), 'a  **word**  b', 5, 9));
  check('a selection of only spaces acts like the caret at its end', toggleFormat(at('a   b', 1, 4), 'bold').text === 'a   ****b');
  check('a selection made backwards is taken the right way round', same(toggleFormat(at('hello', 5, 0), 'italic'), '*hello*', 1, 6));
  check('several lines are wrapped as one', toggleFormat(at('one\ntwo', 0, 7), 'bold').text === '**one\ntwo**');
  check('italic on bold words makes them both', toggleFormat(at('**bold**', 0, 8), 'italic').text === '***bold***');
  check('italic comes off bold-and-italic words and leaves the bold', toggleFormat(at('***both***', 0, 10), 'italic').text === '**both**');
  check('bold comes off bold-and-italic words and leaves the italic', toggleFormat(at('***both***', 0, 10), 'bold').text === '*both*');
  check('italic is not mistaken for bold markers around the words', toggleFormat(at('**bold**', 2, 6), 'italic').text === '***bold***');
  check('bold words inside get their markers taken off by bold', same(toggleFormat(at('***both***', 3, 7), 'bold'), '*both*', 1, 5));
  check('underline wraps in double underscores', toggleFormat(at('x', 0, 1), 'underline').text === '__x__');
  check('an empty pair selected is taken away', same(toggleFormat(at('a****b', 1, 5), 'bold'), 'ab', 1, 1));
  check('a press, then a press with the pair selected, leaves nothing behind', (() => {
    const first = toggleFormat(at('', 0), 'italic');
    return toggleFormat({ text: first.text, start: 0, end: first.text.length }, 'italic').text === '';
  })());
  check('a selection past the end is held to the text', same(toggleFormat(at('hi', 0, 99), 'bold'), '**hi**', 2, 4));

  const message = (id, authorId, poll = null) => ({ id, author: authorId === null ? null : { id: authorId }, poll });
  const list = [message('m1', 'me'), message('m2', 'you'), message('m3', 'me', { question: 'q' }), message('m4', 'you')];
  check('the Up arrow edits your newest message', lastEditable(list, 'me')?.id === 'm1');
  check('a poll is passed over, since it cannot be edited', lastEditable([message('m1', 'me'), message('m2', 'me', {})], 'me')?.id === 'm1');
  check('nothing of yours means nothing to edit', lastEditable(list, 'them') === null);
  check('signed out means nothing to edit', lastEditable(list, undefined) === null);
  check("a deleted account's message is nobody's", lastEditable([message('m1', null)], 'me') === null);
}

// --- Lazy panels: one fetch, kept once loaded, tried again after a failure ---
{
  let calls = 0;
  const panel = lazy(async () => {
    calls++;
    return { default: 'panel' };
  });
  check('nothing is fetched before a panel is first wanted', calls === 0 && panel.current === null);
  const [first, second] = await Promise.all([panel.load(), panel.load()]);
  check('two openings in quick succession share one fetch', calls === 1 && first === 'panel' && second === 'panel');
  check('the loaded panel is kept, so the next opening draws it at once', panel.current === 'panel');
  await panel.load();
  check('a later opening does not fetch again', calls === 1);

  let attempts = 0;
  const flaky = lazy(async () => {
    attempts++;
    if (attempts === 1) throw new TypeError('Failed to fetch dynamically imported module');
    return { default: 'flaky' };
  });
  const failure = await flaky.load().then(
    () => null,
    (cause) => cause,
  );
  check('a failed fetch rejects, so the panel can say so', failure instanceof TypeError && flaky.current === null);
  check('the loader forgets a failure, so the next opening asks again', (await flaky.load()) === 'flaky' && attempts === 2);
  check('the loading line waits a moment, but not long', SLOW_LOAD_MS > 0 && SLOW_LOAD_MS <= 500);
}

// --- Member and role events: one reload per burst ---
{
  const queue = new MemberReloadQueue();
  check('an empty queue has nothing to reload', queue.take() === null);

  check('a first change waits the quiet period', queue.member('u1', 0) === MEMBER_RELOAD_QUIET_MS);
  check('another change starts the wait over', queue.member('u2', 100) === MEMBER_RELOAD_QUIET_MS);
  queue.member('u1', 150);
  const people = queue.take();
  check(
    'a burst about members reloads once, for the union of them',
    people !== null && people.channels === false && people.authors?.size === 2 && people.authors.has('u1') && people.authors.has('u2'),
  );
  check('taking the batch empties the queue', queue.take() === null);

  queue.member('u3', 1000);
  queue.role(1100);
  queue.member('u4', 1200);
  const roles = queue.take();
  check('a role change rechecks everyone on screen', roles !== null && roles.authors === null);
  check('a role change reloads the channel list too', roles?.channels === true);

  // A steady stream still reloads within the limit, rather than waiting for it to stop.
  check('the first change of a long run waits the quiet period', queue.member('u5', 5000) === MEMBER_RELOAD_QUIET_MS);
  check(
    'near the limit the wait is cut short',
    queue.member('u5', 5000 + MEMBER_RELOAD_MAX_WAIT_MS - 100) === 100,
  );
  check('past the limit the reload is due at once', queue.member('u6', 5000 + MEMBER_RELOAD_MAX_WAIT_MS + 50) === 0);
  queue.take();
  check('a new batch gets the full quiet period again', queue.role(9000) === MEMBER_RELOAD_QUIET_MS);
  queue.clear();
  check('clearing drops what had gathered', queue.take() === null);
  check('the quiet period is a short pause', MEMBER_RELOAD_QUIET_MS >= 250 && MEMBER_RELOAD_QUIET_MS <= 500);
}

// --- Overlapping reloads: an older answer never undoes a newer one ---
{
  const order = new ResponseOrder();
  const first = order.begin();
  const second = order.begin();
  check('an older answer landing first is applied', order.accept(first));
  check('a newer answer after it is applied too', order.accept(second));

  const slow = order.begin();
  const fast = order.begin();
  check('a newer answer landing first is applied', order.accept(fast));
  check('a slower, older answer is then turned away', !order.accept(slow));

  const pending = order.begin();
  order.cancel();
  check('an answer still out when the store was emptied is turned away', !order.accept(pending));
  check('a request sent afterwards is applied', order.accept(order.begin()));
}

// --- Channel history: back closes what is open over the chat first ---
{
  const marker = { channelId: 'c1', index: 3, depth: 2 };
  check('a marker round-trips through history state', JSON.stringify(readEntry(writeEntry(null, marker))) === JSON.stringify(marker));
  check(
    'an entry written before markers existed reads as a channel entry',
    readEntry({ harmonyChannel: { channelId: 'c1', index: 2 } })?.depth === 0,
  );
  check('a negative depth is refused', readEntry({ harmonyChannel: { channelId: 'c1', index: 2, depth: -1 } }) === null);
  check('a fractional depth is refused', readEntry({ harmonyChannel: { channelId: 'c1', index: 2, depth: 0.5 } }) === null);

  const onChannel = { channelId: 'c1', index: 4, depth: 0 };
  const onMarker = { channelId: 'c1', index: 5, depth: 1 };
  check(
    'something that opened by itself gets no marker, so Chrome cannot skip the channel under it',
    planOverlay(onChannel, 'c1', 1, false) === null,
  );
  check('something opened with a click or a key does', planOverlay(onChannel, 'c1', 1, true) !== null);
  const pushed = planOverlay(onChannel, 'c1', 1);
  check(
    'opening something pushes a marker for the open channel after the current entry',
    pushed?.channelId === 'c1' && pushed.index === 5 && pushed.depth === 1,
  );
  check('nothing open pushes nothing', planOverlay(onChannel, 'c1', 0) === null);
  check('a marker that already covers what is open is reused', planOverlay(onMarker, 'c1', 1) === null);
  check('one more layer over a marker pushes another', planOverlay(onMarker, 'c1', 2)?.depth === 2);
  check('a marker for another channel is not reused', planOverlay(onMarker, 'c2', 1)?.channelId === 'c2');
  check('no entry of ours yet pushes nothing', planOverlay(null, 'c1', 1) === null);
  check('no open channel pushes nothing', planOverlay(onChannel, null, 1) === null);
  check(
    'a replaced marker stays a marker',
    planVisit({ channelId: 'gone', index: 5, depth: 1 }, 'c2', false, 0)?.entry.depth === 1,
  );

  check('a marker whose layers were closed is stepped off', stepsOffMarker(onMarker, 'c1', 0));
  check('a marker with its layer still open is kept', !stepsOffMarker(onMarker, 'c1', 1));
  check("a channel's own entry is never stepped off", !stepsOffMarker(onChannel, 'c1', 0));
  check('a marker naming another channel is left alone', !stepsOffMarker(onMarker, 'c2', 0));

  check('back with something open closes it', popAction(onChannel, 'c1', true, -1, 1) === 'close');
  check('even onto an entry for another channel', popAction({ channelId: 'c2', index: 3, depth: 0 }, 'c1', true, -1, 1) === 'close');
  check('back onto a marker closes only what is above it', popAction(onMarker, 'c1', true, -1, 2) === 'close');
  check('back with only what the marker stands for open passes it by', popAction(onMarker, 'c1', true, -1, 1) === 'skip');
  check('forward never closes', popAction({ channelId: 'c2', index: 6, depth: 0 }, 'c1', true, 1, 1) === 'open');
  check(
    'a marker is passed over even when it names another channel',
    popAction({ channelId: 'c2', index: 5, depth: 1 }, 'c1', true, -1, 0) === 'skip',
  );
  check('a step from a marker over the open channel may leave the app', mayCarryOn(-1, 0, onMarker, 'c1'));
  check('but not from a marker over a channel since left', !mayCarryOn(-1, 0, onMarker, 'c2'));
  check("nor from a channel's own entry", !mayCarryOn(-1, 0, onChannel, 'c1'));

  check(
    'a close that landed on another channel returns to the entry it came from',
    returnAfterClose({ channelId: 'c0', index: 1, depth: 0 }, onChannel, 'c1') === onChannel.index - 1,
  );
  check('a close on the open channel stays', returnAfterClose(onChannel, onMarker, 'c1') === null);
  check(
    'a close with no entry to return to stays',
    returnAfterClose({ channelId: 'c0', index: 1, depth: 0 }, null, 'c1') === null,
  );

  // Something that opened by itself has no marker; back closes it and returns
  // to the open channel's entry without a push, and the next back goes on.
  const notes = historySession(['a', 'b']);
  notes.open('a');
  notes.open('b');
  const notesLength = notes.length;
  notes.appear();
  check('something that opens by itself pushes no marker', notes.length === notesLength);
  notes.go(-1);
  check('back closes it and stays in the channel', notes.active === 'b' && notes.depth === 0);
  check('and writes no entry without a click', notes.unclicked === 0 && notes.length === notesLength);
  notes.go(-1);
  check('the next back goes to the channel before', notes.active === 'a');
  notes.go(1);
  check('and forward comes back to it', notes.active === 'b');

  const panel = historySession(['a', 'b']);
  panel.open('a');
  panel.open('b');
  panel.show();
  panel.go(-1);
  check('back with a panel open closes it and stays in the channel', panel.active === 'b' && panel.depth === 0);
  panel.go(-1);
  check('and the next back changes channel', panel.active === 'a');

  const dismissed = historySession(['a', 'b']);
  dismissed.open('a');
  dismissed.open('b');
  dismissed.show();
  dismissed.dismiss();
  dismissed.go(-1);
  check('one back after closing a panel through its own controls goes to the channel before', dismissed.active === 'a');

  const often = historySession(['a', 'b']);
  often.open('a');
  often.open('b');
  for (let round = 0; round < 5; round++) {
    often.show();
    often.dismiss();
  }
  check('opening and closing over and over leaves one marker at most', often.length === 3);
  often.go(-1);
  check('so back still goes to the channel before in one press', often.active === 'a');

  const jumped = historySession(['a', 'b']);
  jumped.open('a');
  jumped.show();
  jumped.jump('b');
  jumped.go(-1);
  check('back from a channel opened inside a panel returns to the one it was opened from', jumped.active === 'a');
  jumped.go(-1);
  check('and back from there leaves the app, as from any first channel', jumped.left);

  const drawer = historySession(['a', 'b']);
  drawer.open('a');
  drawer.show();
  drawer.jump('b');
  drawer.show();
  drawer.go(-1);
  check('on a phone, back closes the drawer first', drawer.active === 'b' && drawer.depth === 0);
  drawer.go(-1);
  check('then returns to the channel the drawer was used to leave', drawer.active === 'a');
  drawer.go(-1);
  check('then leaves the app', drawer.left);

  const stacked = historySession(['a', 'b']);
  stacked.open('a');
  stacked.open('b');
  stacked.show();
  stacked.show();
  stacked.go(-1);
  check('back from a picture opened in the gallery closes only the picture', stacked.depth === 1 && stacked.active === 'b');
  stacked.go(-1);
  check('the next back closes the gallery', stacked.depth === 0 && stacked.active === 'b');
  stacked.go(-1);
  check('and the one after changes channel', stacked.active === 'a');

  const inner = historySession(['a', 'b']);
  inner.open('a');
  inner.open('b');
  inner.show();
  inner.show();
  inner.dismiss();
  inner.go(-1);
  check('with the picture closed by hand, one back closes the gallery', inner.depth === 0 && inner.active === 'b');

  const reloaded = historySession(['a', 'b']);
  reloaded.open('a');
  reloaded.open('b');
  reloaded.show();
  reloaded.reload();
  check('a reload with a panel open reopens the channel and nothing over it', reloaded.active === 'b' && reloaded.depth === 0);
  reloaded.go(-1);
  check('and one back then goes to the channel before', reloaded.active === 'a');

  const firstReload = historySession(['a']);
  firstReload.open('a');
  firstReload.show();
  firstReload.reload();
  firstReload.go(-1);
  check('a reload over the first channel still lets one back leave the app', firstReload.left);

  const firstClosed = historySession(['a']);
  firstClosed.open('a');
  firstClosed.show();
  firstClosed.dismiss();
  firstClosed.go(-1);
  check('closing a panel over the first channel by hand still lets one back leave the app', firstClosed.left);

  const app = historySession(['a'], { installed: true });
  app.open('a');
  app.show();
  app.go(-1);
  check('in the installed app, back on the first channel closes the drawer and not the app', !app.closed && app.depth === 0);
  app.go(-1);
  check('and the next back closes the app', app.closed);

  const appDismissed = historySession(['a'], { installed: true });
  appDismissed.open('a');
  appDismissed.show();
  appDismissed.dismiss();
  appDismissed.go(-1);
  check('with the drawer closed by hand, one back closes the installed app', appDismissed.closed);

  const appReloaded = historySession(['a'], { installed: true });
  appReloaded.open('a');
  appReloaded.show();
  appReloaded.reload();
  appReloaded.go(-1);
  check('and so does one back after a reload with the drawer open', appReloaded.closed);

  const forward = historySession(['a', 'b']);
  forward.open('a');
  forward.open('b');
  forward.show();
  forward.go(-1);
  forward.go(1);
  check('forward never reopens what back closed', forward.depth === 0 && forward.active === 'b');
  forward.go(-1);
  check('and back from there is the channel before', forward.active === 'a');

  const rested = historySession(['a']);
  rested.open('a');
  rested.show();
  rested.dismiss();
  rested.go(1);
  rested.go(-1);
  check('back from a marker forward came to rest on still leaves from the first channel', rested.left);

  const ahead = historySession(['a', 'b']);
  ahead.open('a');
  ahead.open('b');
  ahead.go(-1);
  ahead.show();
  ahead.go(-1);
  ahead.go(1);
  check('opening something after going back drops the channels ahead, as opening a channel does', ahead.active === 'a');

  // Chrome's back button passes over an entry whose next entry was pushed
  // without a click, which a marker for the setup wizard opening on load is.
  const skipped = historySession(['a', 'b']);
  skipped.open('a');
  skipped.open('b');
  skipped.show();
  skipped.go(-2);
  check('a back that skipped past the open channel only closes', skipped.active === 'b' && skipped.depth === 0);
  check('and returns to the open channel without a push', skipped.length === 3 && skipped.unclicked === 0);
  skipped.go(-1);
  check('from where the next back goes to the channel before', skipped.active === 'a');
  skipped.go(-1);
  check('so the next back is still the channel before', skipped.active === 'a');

  const goneUnder = historySession(['x', 'b']);
  goneUnder.open('x');
  goneUnder.show();
  goneUnder.jump('b');
  goneUnder.remove('x');
  goneUnder.go(-1);
  check('back past a marker onto a gone first channel stays in the app', goneUnder.active === 'b' && !goneUnder.left);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
