<script lang="ts">
  import { tick, untrack } from 'svelte';
  import {
    ALLOWED_ATTACHMENT_TYPES,
    LIMITS,
    bypassesSlowmode,
    formatSlowmode,
    isTimedOut,
    type Attachment,
    type User,
  } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { avatarUrl, initial } from '../lib/avatar';
  import { chat } from '../lib/chat.svelte';
  import { drafts, type Draft } from '../lib/drafts.svelte';
  import { emojis } from '../lib/emojis.svelte';
  import { emojiUsage } from '../lib/emoji-usage.svelte';
  import { mediaFilesFrom } from '../lib/files';
  import { members } from '../lib/members.svelte';
  import { meta } from '../lib/meta.svelte';
  import type { IconName } from '../lib/icons';
  import { session } from '../lib/session.svelte';
  import { applySlashCommand, matchSlashCommands, slashQuery } from '../lib/slash-commands';
  import { parseTimeExpression, timestampChoices, type ParsedMoment } from '../lib/time-input';
  import { loadUnicodeEmoji, type UnicodeEmoji } from '../lib/unicode-emoji';
  import { uploads } from '../lib/upload-queue.svelte';
  import EmojiPicker from './EmojiPicker.svelte';
  import GifPicker from './GifPicker.svelte';
  import SchedulePicker from './SchedulePicker.svelte';
  import Icon from './Icon.svelte';
  import PollComposer from './PollComposer.svelte';
  import TimestampPicker from './TimestampPicker.svelte';

  const acceptAttribute = ALLOWED_ATTACHMENT_TYPES.join(',');
  const maxAttachments = LIMITS.attachmentsPerMessage;
  /** How many matches any autocomplete offers at once. */
  const maxSuggestions = 8;
  /** What may follow an `@` and still be the start of a member's name. */
  const mentionQuery = /^[a-zA-Z0-9._-]{0,32}$/;
  /** How stale the member directory may be before a mention refreshes it. */
  const directoryMaxAgeMs = 30_000;
  /**
   * Safari honors `autocorrect` on a textarea too, but Svelte's element types
   * only list it for inputs, so it is spread in rather than written inline.
   */
  const noAutocorrect: Record<string, string> = { autocorrect: 'off' };

  /**
   * The composer is mounted once and stays put while channels change, so what is
   * being written is kept per channel rather than in the component: otherwise a
   * draft started in one channel would be sent into whichever is open next.
   */
  const draftKey = $derived(
    session.user && chat.activeChannelId ? `${session.user.id}:${chat.activeChannelId}` : null,
  );
  const value = $derived(drafts.get(draftKey).text);
  const pending = $derived(drafts.get(draftKey).attachments);

  let busy = $state(false);
  /** Upload batches queued or running; each waits for the one before it. */
  let uploadBatches = $state(0);
  const uploading = $derived(uploadBatches > 0);
  let uploadChain: Promise<void> = Promise.resolve();
  let error = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let textInput = $state<HTMLTextAreaElement | null>(null);
  let showPicker = $state(false);
  let showGifs = $state(false);
  let showTimes = $state(false);
  let showSchedule = $state(false);
  let showPoll = $state(false);
  /** The phone-only + menu that gathers the four picker buttons. */
  let showActions = $state(false);

  /** The `:emoji` or `@mention` fragment being typed at the caret, if any. */
  let activeTrigger = $state<Trigger | null>(null);
  let highlight = $state(0);
  let suggestionList = $state<HTMLUListElement | null>(null);

  /**
   * The unicode set, loaded on first use rather than shipped with the app, the
   * same way the emoji picker loads it. `:` autocomplete is the only place the
   * composer needs it, so a session that never types one never pays for it.
   */
  let unicodeEmoji = $state<UnicodeEmoji[]>([]);
  let unicodeRequested = false;

  function ensureUnicodeEmoji(): void {
    if (unicodeRequested) return;
    unicodeRequested = true;
    void loadUnicodeEmoji()
      .then((groups) => {
        unicodeEmoji = groups.flatMap((group) => group.emojis);
      })
      .catch(() => {
        // Leave it empty and let the next `:` try again.
        unicodeRequested = false;
      });
  }

  /**
   * An `@` starts both a mention and a timestamp, so a mention trigger also
   * carries the moment its text reads as, when it reads as one.
   */
  type Trigger =
    | { kind: 'emoji'; start: number; query: string }
    | { kind: 'mention'; start: number; query: string; moment: ParsedMoment | null }
    | { kind: 'channel'; start: number; query: string }
    | { kind: 'slash'; start: number; query: string };

  /** One row in the autocomplete popup, whichever kind it is. */
  interface Suggestion {
    key: string;
    label: string;
    detail: string | null;
    imageUrl: string | null;
    initial: string | null;
    /** A unicode emoji shown as its own glyph, rather than an image or an initial. */
    emoji?: string | null;
    icon: IconName | null;
    /** The text inserted when the row is accepted. */
    insert: string;
  }

  /** A client-side size check, so an oversized file is refused before uploading. */
  function tooLarge(file: File): string | null {
    const isVideo = file.type.startsWith('video/');
    const limit = isVideo ? meta.data?.maxVideoBytes : meta.data?.maxImageBytes;
    if (!limit || file.size <= limit) return null;
    const kind = isVideo ? 'videos' : 'images';
    return `${file.name} is too large — ${kind} are at most ${Math.round(limit / (1024 * 1024))} MB.`;
  }

  /**
   * Uploads each file and queues it on the draft of the channel it was added in.
   *
   * A paste, a drop and the file picker can each start a batch while another is
   * still going, so batches run one after another: that keeps the attachment
   * limit check honest and keeps Send disabled until the last one is done.
   */
  function uploadFiles(files: File[]): Promise<void> {
    if (files.length === 0) return Promise.resolve();
    const key = draftKey;
    error = null;
    uploadBatches += 1;
    uploadChain = uploadChain
      .then(() => uploadBatch(key, files))
      .finally(() => {
        uploadBatches -= 1;
      })
      .catch(() => {
        // `uploadBatch` reports its own problems, but a rejection must still not
        // be allowed to poison the chain: every later batch would be skipped and
        // its files silently dropped.
      });
    return uploadChain;
  }

  /**
   * One file failing does not stop the rest of the batch; whatever could not be
   * attached is listed together once the batch is done.
   */
  async function uploadBatch(key: string | null, files: File[]): Promise<void> {
    const problems: string[] = [];
    for (const file of files) {
      if (drafts.get(key).attachments.length >= maxAttachments) {
        problems.push(`You can attach at most ${maxAttachments} files per message.`);
        break;
      }
      const rejection = tooLarge(file);
      if (rejection) {
        problems.push(rejection);
        continue;
      }
      try {
        const form = new FormData();
        form.append('file', file);
        const attachment = await api<Attachment>('/attachments', { method: 'POST', body: form });
        drafts.setAttachments(key, [...drafts.get(key).attachments, attachment]);
      } catch (cause) {
        const reason = cause instanceof ApiError ? cause.message : String(cause);
        problems.push(`${file.name} could not be uploaded: ${reason}`);
      }
    }
    if (problems.length > 0) error = problems.join(' ');
  }

  async function onFiles(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = ''; // allow picking the same file again later
    await uploadFiles(files);
  }

  /** Pasted screenshots become attachments, the way Discord does it. */
  function onPaste(event: ClipboardEvent): void {
    if (timeoutUntil !== null) return;
    const files = mediaFilesFrom(event.clipboardData);
    if (files.length === 0) return;
    // Only swallow the paste when there are images to take from it.
    event.preventDefault();
    void uploadFiles(files);
  }

  /** Uploads whatever was dropped on the chat pane, handed over by the queue. */
  $effect(() => {
    if (uploads.count === 0) return;
    const files = uploads.take();
    // Only the queue should rerun this, not the draft or upload state it touches.
    untrack(() => void uploadFiles(files));
  });

  function removePending(id: string): void {
    drafts.setAttachments(
      draftKey,
      pending.filter((attachment) => attachment.id !== id),
    );
  }

  /**
   * Queues whatever the gif picker chose. Picking already stored the gif as an
   * unattached attachment of this member's, so from here it is no different from
   * an upload that has just finished.
   */
  function addGif(attachment: Attachment): void {
    showGifs = false;
    if (pending.length >= maxAttachments) {
      error = `You can attach at most ${maxAttachments} files per message.`;
      return;
    }
    error = null;
    drafts.setAttachments(draftKey, [...pending, attachment]);
  }

  /**
   * Inserts whatever a picker chose where the caret was, replacing any
   * selection, then puts the caret back after it so typing carries on. A server
   * emoji arrives as its `:name:` shortcode, a unicode one as the character
   * itself and a timestamp as its `<t:…>` tag, so either way the text is what
   * goes in the field.
   *
   * A textarea keeps its selection while the picker has focus, which is what
   * makes the caret still readable here.
   */
  async function insertAtCaret(text: string): Promise<void> {
    const input = textInput;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
    drafts.setText(draftKey, `${before}${lead}${text}${trail}${after}`);
    showPicker = false;
    showTimes = false;

    await tick();
    const position = start + lead.length + text.length + trail.length;
    input?.focus();
    input?.setSelectionRange(position, position);
  }

  /** Escape hands the caret back to the message; a click elsewhere keeps its own focus. */
  function closeTimes(refocus: boolean): void {
    showTimes = false;
    if (refocus) textInput?.focus();
  }

  /*
   * The four pickers, opened either from the desktop buttons or from the phone's
   * + menu. Each closes the others so two panels are never open at once, and
   * closes the menu itself, which is what makes tapping an item feel like it did
   * something rather than leaving a menu sitting over the picker.
   */
  function toggleEmoji(): void {
    showPoll = false;
    showPicker = !showPicker;
    showGifs = false;
    showTimes = false;
    showSchedule = false;
    showActions = false;
  }

  function toggleGifs(): void {
    showPoll = false;
    showGifs = !showGifs;
    showPicker = false;
    showTimes = false;
    showSchedule = false;
    showActions = false;
  }

  function toggleTimes(): void {
    showPoll = false;
    showTimes = !showTimes;
    showPicker = false;
    showGifs = false;
    showSchedule = false;
    showActions = false;
  }

  /** Opens the "send later" popover, from the + menu, the button by Send or Ctrl+Shift+Enter. */
  function toggleSchedule(): void {
    showSchedule = !showSchedule;
    showPoll = false;
    showPicker = false;
    showGifs = false;
    showTimes = false;
    showActions = false;
    activeTrigger = null;
  }

  /** The server has the draft now, so the box is emptied the way a send empties it. */
  function onScheduled(): void {
    const key = draftKey;
    if (key !== null) drafts.clear(key);
    chat.replyTarget = null;
    showSchedule = false;
    activeTrigger = null;
    void tick().then(() => textInput?.focus());
  }

  function togglePoll(): void {
    showPoll = !showPoll;
    showSchedule = false;
    showPicker = false;
    showGifs = false;
    showTimes = false;
    showActions = false;
  }

  function closePoll(refocus: boolean): void {
    showPoll = false;
    if (refocus) textInput?.focus();
  }

  function pickFiles(): void {
    showActions = false;
    fileInput?.click();
  }

  const replyName = $derived(
    chat.replyTarget?.author?.displayName ?? chat.replyTarget?.author?.username ?? 'Deleted user',
  );

  /** When the current user is timed out, the composer is locked with a note. */
  const timeoutUntil = $derived(
    session.user && isTimedOut(session.user) && session.user.timedOutUntil
      ? new Date(session.user.timedOutUntil).toLocaleString()
      : null,
  );

  const permissions = $derived(BigInt(session.permissions || '0'));
  const slowmodeSeconds = $derived(chat.activeChannel?.slowmodeSeconds ?? 0);
  /** Slowmode that applies to this member here; moderators skip it. */
  const slowmodeApplies = $derived(slowmodeSeconds > 0 && !bypassesSlowmode(permissions));

  /*
   * A local countdown started after a successful post so the wait is visible
   * without another round trip. The server is still the authority, and its own
   * refusal starts the same countdown, so a second tab stays honest.
   */
  let cooldownChannelId = $state<string | null>(null);
  let cooldownEndsAt = $state(0);
  let clock = $state(Date.now());

  $effect(() => {
    if (cooldownEndsAt <= 0) return;
    const timer = setInterval(() => {
      clock = Date.now();
      if (clock >= cooldownEndsAt) {
        clearInterval(timer);
        cooldownEndsAt = 0;
      }
    }, 250);
    return () => clearInterval(timer);
  });

  /** Seconds left before this member may post here again; 0 when they may. */
  const slowmodeRemaining = $derived(
    cooldownChannelId === chat.activeChannelId && cooldownEndsAt > clock
      ? Math.ceil((cooldownEndsAt - clock) / 1000)
      : 0,
  );

  /** Takes the channel and its wait as they were when the post was sent. */
  function startSlowmodeCooldown(channelId: string | null, seconds: number): void {
    if (seconds <= 0) return;
    cooldownChannelId = channelId;
    cooldownEndsAt = Date.now() + seconds * 1000;
    clock = Date.now();
  }

  /** At most one typing ping per burst window while the box has text. */
  const typingThrottleMs = 5000;
  let lastTypingAt = 0;

  /**
   * Announces typing to the server, throttled so a fast typist does not trip the
   * limiter. Clearing the box resets the throttle so the next burst is immediate.
   */
  function maybeSendTyping(text: string): void {
    if (!session.user?.showTyping || timeoutUntil !== null || !chat.activeChannelId) return;
    if (text.trim().length === 0) {
      lastTypingAt = 0;
      return;
    }
    const now = Date.now();
    if (now - lastTypingAt < typingThrottleMs) return;
    lastTypingAt = now;
    void chat.sendTyping();
  }

  function onInput(): void {
    updateAutocomplete();
    // Read the element rather than `value`, so we never depend on binding order.
    maybeSendTyping(textInput?.value ?? '');
  }

  /**
   * Finds the `:name`, `@name`, `@time` or `#channel` fragment ending at the
   * caret, delimited by the start of the line or whitespace, the way Discord
   * triggers autocomplete.
   */
  function detectTrigger(text: string, caret: number): Trigger | null {
    const before = text.slice(0, caret);

    // A slash helper only exists as the first word of the message.
    const slash = slashQuery(before);
    if (slash !== null && matchSlashCommands(slash).length > 0) return { kind: 'slash', start: 0, query: slash };

    const emoji = /(?:^|\s):([a-zA-Z0-9_]{0,32})$/.exec(before);
    if (emoji) {
      const query = emoji[1] ?? '';
      return { kind: 'emoji', start: caret - query.length - 1, query };
    }

    // A time may hold spaces ("tomorrow 18:00") where a name cannot, so the
    // fragment runs to the caret and is then asked whether it is either. When it
    // is neither, it is ordinary text that happens to follow an `@`.
    const mention = /(?:^|\s)@([^@\n]{0,40})$/.exec(before);
    if (mention) {
      const query = mention[1] ?? '';
      const moment = parseTimeExpression(query, { now: Date.now() });
      if (moment || mentionQuery.test(query)) {
        return { kind: 'mention', start: caret - query.length - 1, query, moment };
      }
    }

    // A channel name may contain a space, but the query stops at one: typing
    // `#off` offers `Off Topic` rather than trying to pass the space through.
    const channel = /(?:^|\s)#([^\s#]{0,63})$/.exec(before);
    if (channel) {
      const query = channel[1] ?? '';
      return { kind: 'channel', start: caret - query.length - 1, query };
    }

    return null;
  }

  function updateAutocomplete(): void {
    const input = textInput;
    if (!input) {
      activeTrigger = null;
      return;
    }

    const caret = input.selectionStart ?? input.value.length;
    const next = detectTrigger(input.value, caret);
    // Reset the selection whenever the fragment being typed changes.
    if (
      next?.kind !== activeTrigger?.kind ||
      next?.start !== activeTrigger?.start ||
      next?.query !== activeTrigger?.query
    ) {
      highlight = 0;
    }
    // Refresh the directory as we open a mention, in case someone just joined.
    if (next?.kind === 'mention' && activeTrigger?.kind !== 'mention') {
      void members.refreshIfStale(directoryMaxAgeMs);
    }
    if (next?.kind === 'emoji') ensureUnicodeEmoji();
    activeTrigger = next;
  }

  /** Ranks a member: 0 for a prefix match, 1 for a substring, 2 for no match. */
  function rankMember(user: User, needle: string): number {
    const username = user.username.toLowerCase();
    const display = (user.displayName ?? '').toLowerCase();
    if (username.startsWith(needle) || display.startsWith(needle)) return 0;
    if (username.includes(needle) || display.includes(needle)) return 1;
    return 2;
  }

  /**
   * Who can actually be mentioned here. Discord stand-in accounts only exist to
   * represent people on the other side of a bridged channel, so they are hidden
   * in every other channel: a mention there could never reach them.
   */
  const mentionableUsers = $derived.by((): User[] => {
    if (chat.activeChannel?.discordChannelId != null) return members.list;
    return members.list.filter((user) => !user.isBot);
  });

  const suggestions = $derived.by((): Suggestion[] => {
    const trigger = activeTrigger;
    if (!trigger) return [];
    const needle = trigger.query.toLowerCase();

    if (trigger.kind === 'emoji') {
      const byName = [...emojis.picker].sort((a, b) => a.name.localeCompare(b.name));
      const prefix = byName.filter((emoji) => emoji.name.toLowerCase().startsWith(needle));
      const rest = needle
        ? byName.filter(
            (emoji) => !emoji.name.toLowerCase().startsWith(needle) && emoji.name.toLowerCase().includes(needle),
          )
        : [];
      const server: Suggestion[] = [...prefix, ...rest].map((emoji) => ({
        key: `emoji:${emoji.id}`,
        label: `:${emoji.name}:`,
        detail: null,
        imageUrl: `/api/v1/emojis/${emoji.id}`,
        initial: null,
        icon: null,
        insert: `:${emoji.name}: `,
      }));

      // Unicode emoji share the trigger. The instance's own come first, so a
      // custom `:smile:` wins over the unicode one, and only a typed name brings
      // them in: an empty query would otherwise drown the server emoji.
      const unicode: Suggestion[] = needle
        ? unicodeEmoji
            .filter((emoji) => emoji.name.toLowerCase().includes(needle))
            .sort((a, b) => {
              const aPrefix = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
              const bPrefix = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
              return aPrefix - bPrefix || a.name.localeCompare(b.name);
            })
            .map((emoji) => ({
              key: `unicode:${emoji.emoji}`,
              label: emoji.name,
              detail: null,
              imageUrl: null,
              initial: null,
              emoji: emoji.emoji,
              icon: null,
              insert: `${emoji.emoji} `,
            }))
        : [];

      // Emoji this member uses a lot rise: a bare `:` offers their top few, and
      // a typed query keeps its order except that used matches go first (the
      // sort is stable, so equal scores keep custom ahead of unicode).
      const scores = emojiUsage.scores;
      const scoreOf = (suggestion: Suggestion): number => scores.get(suggestion.key.replace(/^(?:emoji|unicode):/, '')) ?? 0;
      const used: Suggestion[] = needle
        ? []
        : emojiUsage.ranked.slice(0, 6).map((entry) =>
            entry.emojiId
              ? {
                  key: `emoji:${entry.emojiId}`,
                  label: entry.emoji,
                  detail: null,
                  imageUrl: `/api/v1/emojis/${entry.emojiId}`,
                  initial: null,
                  icon: null,
                  insert: `${entry.emoji} `,
                }
              : {
                  key: `unicode:${entry.emoji}`,
                  label: unicodeEmoji.find((e) => e.emoji === entry.emoji)?.name ?? entry.emoji,
                  detail: null,
                  imageUrl: null,
                  initial: null,
                  emoji: entry.emoji,
                  icon: null,
                  insert: `${entry.emoji} `,
                },
          );
      const seen = new Set(used.map((suggestion) => suggestion.key));
      const merged = [...used, ...[...server, ...unicode].filter((suggestion) => !seen.has(suggestion.key))];
      return (needle ? merged.sort((a, b) => scoreOf(b) - scoreOf(a)) : merged).slice(0, maxSuggestions);
    }

    if (trigger.kind === 'slash') {
      return matchSlashCommands(needle).map((command) => ({
        key: `slash:${command.name}`,
        label: command.usage,
        detail: command.description,
        imageUrl: null,
        initial: null,
        icon: null,
        insert: `/${command.name} `,
      }));
    }

    if (trigger.kind === 'channel') {
      const matches = chat.channels
        .filter((channel) => channel.name.toLowerCase().includes(needle))
        .sort((a, b) => {
          const aPrefix = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
          const bPrefix = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
          return aPrefix - bPrefix || a.name.localeCompare(b.name);
        })
        .slice(0, maxSuggestions);
      return matches.map((channel) => ({
        key: `channel:${channel.id}`,
        label: `#${channel.name}`,
        detail: null,
        imageUrl: null,
        initial: null,
        icon: null,
        insert: `#${channel.name} `,
      }));
    }

    const people: Suggestion[] = mentionQuery.test(trigger.query)
      ? mentionableUsers
          .map((user) => ({ user, rank: rankMember(user, needle) }))
          .filter((entry) => entry.rank < 2)
          .sort((a, b) => a.rank - b.rank || a.user.username.localeCompare(b.user.username))
          .slice(0, maxSuggestions)
          .map(({ user }) => ({
            key: `mention:${user.id}`,
            label: user.displayName ?? user.username,
            detail: `@${user.username}`,
            imageUrl: avatarUrl(user),
            initial: initial(user),
            icon: null,
            insert: `@${user.username} `,
          }))
      : [];

    // Members come first: whoever types `@fri` is more likely after Frida than
    // Friday, and a time is never more than a few arrow presses below. When
    // nobody matches, the times are all there is and lead on their own.
    const times: Suggestion[] = trigger.moment
      ? timestampChoices(trigger.moment, { now: Date.now() }).map((choice) => ({
          key: `time:${choice.style}`,
          label: choice.preview,
          detail: choice.name,
          imageUrl: null,
          initial: null,
          icon: 'clock',
          insert: `${choice.token} `,
        }))
      : [];
    return [...people, ...times];
  });

  /** Arrowing through a list longer than its box keeps the highlighted row in view. */
  $effect(() => {
    const row = suggestionList?.querySelectorAll('[role="option"]')[highlight];
    row?.scrollIntoView({ block: 'nearest' });
  });

  async function acceptSuggestion(suggestion: Suggestion): Promise<void> {
    const input = textInput;
    const trigger = activeTrigger;
    if (!input || !trigger) return;

    const caret = input.selectionStart ?? input.value.length;
    drafts.setText(draftKey, `${input.value.slice(0, trigger.start)}${suggestion.insert}${input.value.slice(caret)}`);
    activeTrigger = null;

    await tick();
    const position = trigger.start + suggestion.insert.length;
    input.focus();
    input.setSelectionRange(position, position);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (suggestions.length > 0) {
      // Alt+Up/Down is the app's channel-jump shortcut. Leave those arrows alone
      // so an open list does not swallow them and suppress the jump.
      if (event.key === 'ArrowDown' && !event.altKey) {
        event.preventDefault();
        highlight = (highlight + 1) % suggestions.length;
        return;
      }
      if (event.key === 'ArrowUp' && !event.altKey) {
        event.preventDefault();
        highlight = (highlight - 1 + suggestions.length) % suggestions.length;
        return;
      }
      // Tab accepts the highlighted suggestion, the way Discord does. Enter is
      // deliberately left alone so that it sends the message: otherwise somebody
      // typing an emoticon like :D or :3 gets an emoji they did not ask for
      // instead of their message, since a : starts the same list either way.
      if (event.key === 'Tab') {
        event.preventDefault();
        const chosen = suggestions[highlight];
        if (chosen) void acceptSuggestion(chosen);
        return;
      }
    }

    // Ctrl+Shift+Enter (Cmd on a Mac) schedules the draft instead of sending it.
    if (event.key === 'Enter' && event.shiftKey && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      if (timeoutUntil === null) toggleSchedule();
      return;
    }

    // Enter sends and Shift+Enter starts a new line, as in Discord. A key that
    // finishes an IME composition is left to the IME, or picking a Japanese
    // candidate would send the message. Some browsers report `isComposing`
    // false for that confirming Enter and set the legacy keyCode 229 instead,
    // so both are checked. On touch keyboards there is no Shift, so the send key
    // keeps sending; multi-line text there comes from pasting.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void send();
      return;
    }

    // Escape only ever backs out of something; the draft itself is never cleared.
    if (event.key === 'Escape') {
      if (showTimes) {
        event.preventDefault();
        showTimes = false;
        return;
      }
      if (activeTrigger) {
        event.preventDefault();
        activeTrigger = null;
        return;
      }
      if (chat.replyTarget) {
        event.preventDefault();
        chat.replyTarget = null;
      }
    }
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void send();
  }

  /**
   * Sends the draft. The composer is emptied as soon as the message is on its
   * way, so anything typed while the request is in flight belongs to the next
   * message; if the send fails, the failed text is put back in front of it
   * rather than either one being lost.
   */
  async function send(): Promise<void> {
    const key = draftKey;
    const content = applySlashCommand(value.trim());
    if (key === null || busy || uploading || timeoutUntil !== null || slowmodeRemaining > 0) return;
    if (!content && pending.length === 0) return;

    const sent = drafts.get(key);
    const replyTarget = chat.replyTarget;
    const channelId = chat.activeChannelId;
    const cooldownSeconds = slowmodeApplies ? slowmodeSeconds : 0;

    busy = true;
    error = null;
    // sendMessage reads the open channel before it awaits anything, so it posts
    // where the draft was written even if the channel changes right after.
    const request = chat.sendMessage(
      content,
      sent.attachments.map((attachment) => attachment.id),
      replyTarget?.id ?? null,
    );
    drafts.clear(key);
    chat.replyTarget = null;
    activeTrigger = null;

    try {
      await request;
      startSlowmodeCooldown(channelId, cooldownSeconds);
    } catch (cause) {
      // The server refused for slowmode: honor it even if this tab had not
      // started its own countdown, e.g. the first post after a reload.
      if (cause instanceof ApiError && cause.code === 'slowmode') startSlowmodeCooldown(channelId, cooldownSeconds);
      error = cause instanceof ApiError ? cause.message : String(cause);
      await restoreDraft(key, sent, replyTarget, channelId);
    } finally {
      busy = false;
    }
  }

  /**
   * Puts a failed message back in its channel's draft. Text typed since goes on
   * a new line after it, with the caret kept where it was in that newer text.
   */
  async function restoreDraft(
    key: string,
    sent: Draft,
    replyTarget: typeof chat.replyTarget,
    channelId: string | null,
  ): Promise<void> {
    const current = drafts.get(key);
    const prefix = current.text.length > 0 ? `${sent.text}\n` : sent.text;
    const known = new Set(sent.attachments.map((attachment) => attachment.id));
    drafts.set(key, {
      text: `${prefix}${current.text}`,
      attachments: [...sent.attachments, ...current.attachments.filter((attachment) => !known.has(attachment.id))],
    });
    if (chat.activeChannelId === channelId && chat.replyTarget === null) chat.replyTarget = replyTarget;

    const input = textInput;
    if (key !== draftKey || !input || document.activeElement !== input) return;
    const caretStart = input.selectionStart + prefix.length;
    const caretEnd = input.selectionEnd + prefix.length;
    await tick();
    input.setSelectionRange(caretStart, caretEnd);
  }

  /**
   * Grows the field with its content. CSS caps the height, after which it
   * scrolls; measuring from `auto` lets it shrink again as lines are removed.
   */
  function fitToContent(): void {
    const input = textInput;
    if (!input) return;
    input.style.height = 'auto';
    // scrollHeight leaves out the border, which the border-box height includes.
    const style = getComputedStyle(input);
    const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    input.style.height = `${input.scrollHeight + borders}px`;
  }

  $effect(() => {
    void value;
    fitToContent();
  });

  /*
   * A change of width rewraps the draft onto a different number of lines: a
   * resized window, a sidebar opening, or the page coming back from being hidden,
   * where it measured nothing. Height changes are this composer's own doing, so
   * they are ignored rather than fed back in.
   */
  $effect(() => {
    const input = textInput;
    if (!input) return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      fitToContent();
    });
    observer.observe(input);
    return () => observer.disconnect();
  });

  /** A suggestion list or error from another channel's draft does not apply here. */
  $effect(() => {
    void draftKey;
    activeTrigger = null;
    error = null;
  });
</script>

<div class="composer" onpaste={onPaste}>
  {#if error}
    <p class="form-error">{error}</p>
  {/if}

  {#if timeoutUntil}
    <p class="form-error">You are timed out until {timeoutUntil}. You can still read along.</p>
  {/if}

  {#if slowmodeRemaining > 0}
    <p class="muted">Slowmode: you can post again in {slowmodeRemaining}s.</p>
  {:else if slowmodeApplies}
    <p class="muted">Slowmode is on: one message every {formatSlowmode(slowmodeSeconds)}.</p>
  {/if}

  {#if showPicker}
    <EmojiPicker onpick={(emoji) => insertAtCaret(emoji)} />
  {/if}

  {#if showGifs}
    <GifPicker onpick={addGif} onlink={(url) => {
        showGifs = false;
        void insertAtCaret(url);
      }} />
  {/if}

  {#if showPoll}
    <PollComposer onclose={closePoll} />
  {/if}

  {#if showTimes}
    <TimestampPicker onpick={(token) => insertAtCaret(token)} onclose={closeTimes} />
  {/if}

  {#if showSchedule && chat.activeChannel}
    <!-- Scheduled text goes through the slash helpers too, as sending it now would. -->
    <SchedulePicker
      channelId={chat.activeChannel.id}
      channelName={chat.activeChannel.name}
      content={applySlashCommand(value.trim())}
      attachmentIds={pending.map((attachment) => attachment.id)}
      replyToId={chat.replyTarget?.id ?? null}
      onscheduled={onScheduled}
      onclose={(refocus) => {
        showSchedule = false;
        if (refocus) textInput?.focus();
      }}
    />
  {/if}

  {#if pending.length > 0}
    <div class="pending">
      {#each pending as attachment (attachment.id)}
        <div class="pending-item">
          {#if attachment.contentType.startsWith('video/')}
            <!-- A short silent preview; there is no caption track to attach. -->
            <!-- svelte-ignore a11y_media_has_caption -->
            <video src={`/api/v1/attachments/${attachment.id}`} muted preload="metadata"></video>
          {:else}
            <img src={`/api/v1/attachments/${attachment.id}`} alt={attachment.filename} />
          {/if}
          <button type="button" class="remove" title="Remove" onclick={() => removePending(attachment.id)}>×</button>
        </div>
      {/each}
    </div>
  {/if}

  {#if chat.replyTarget}
    <div class="replying">
      <span class="muted">Replying to <strong>{replyName}</strong></span>
      <button type="button" class="remove-reply" title="Cancel reply" onclick={() => (chat.replyTarget = null)}>×</button>
    </div>
  {/if}

  {#if suggestions.length > 0}
    <ul class="autocomplete" role="listbox" aria-label="Suggestions" bind:this={suggestionList}>
      {#each suggestions as suggestion, index (suggestion.key)}
        <li>
          <button
            type="button"
            role="option"
            aria-selected={index === highlight}
            class="autocomplete-item"
            class:active={index === highlight}
            onpointerdown={(event) => event.preventDefault()}
            onmousedown={(event) => event.preventDefault()}
            onclick={() => acceptSuggestion(suggestion)}
          >
            {#if suggestion.imageUrl}
              <img class="autocomplete-image" src={suggestion.imageUrl} alt="" />
            {:else if suggestion.emoji}
              <span class="autocomplete-emoji">{suggestion.emoji}</span>
            {:else if suggestion.initial}
              <span class="autocomplete-initial">{suggestion.initial}</span>
            {:else if suggestion.icon}
              <span class="autocomplete-icon"><Icon name={suggestion.icon} size={18} /></span>
            {/if}
            <span class="autocomplete-name">{suggestion.label}</span>
            {#if suggestion.detail}<span class="autocomplete-detail">{suggestion.detail}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <form onsubmit={onSubmit}>
    <button
      type="button"
      class="attach attach-more"
      title="More actions"
      aria-label="More actions"
      aria-expanded={showActions}
      aria-haspopup="menu"
      onclick={() => (showActions = !showActions)}
    ><Icon name="plus" size={20} /></button>
    {#if showActions}
      <button
        type="button"
        class="composer-actions-backdrop"
        aria-label="Close menu"
        onclick={() => (showActions = false)}
      ></button>
      <div class="composer-actions" role="menu">
        <button type="button" role="menuitem" class="menu-mobile-only" onclick={toggleEmoji}>
          <span class="composer-actions-icon"><Icon name="smile" size={18} /></span> Emoji
        </button>
        <button type="button" role="menuitem" class="menu-mobile-only" onclick={toggleGifs}>
          <span class="composer-actions-icon"><Icon name="gif" size={18} /></span> Gif
        </button>
        <button type="button" role="menuitem" disabled={timeoutUntil !== null} onclick={toggleTimes}>
          <span class="composer-actions-icon"><Icon name="clock" size={18} /></span> Timestamp
        </button>
        <button type="button" role="menuitem" class="menu-mobile-only" disabled={timeoutUntil !== null} onclick={toggleSchedule}>
          <span class="composer-actions-icon"><Icon name="clock" size={18} /></span> Schedule send
        </button>
        <button type="button" role="menuitem" disabled={uploading || timeoutUntil !== null} onclick={pickFiles}>
          <span class="composer-actions-icon"><Icon name="paperclip" size={18} /></span> Attach image
        </button>
        <button type="button" role="menuitem" disabled={timeoutUntil !== null} onclick={togglePoll}>
          <span class="composer-actions-icon"><Icon name="poll" size={18} /></span> Poll
        </button>
      </div>
    {/if}
    <button
      type="button"
      class="attach"
      title="Add emoji"
      aria-label="Add emoji"
      onclick={toggleEmoji}><Icon name="smile" size={20} /></button
    >
    <button type="button" class="attach attach-gif" title="Add gif" aria-label="Add gif" onclick={toggleGifs}>GIF</button>
    <input class="file-input" type="file" accept={acceptAttribute} multiple bind:this={fileInput} onchange={onFiles} />
    <!--
      Slowmode only holds back sending (see `send`): the field stays enabled so
      the next message can be written during the wait, and a phone keyboard is
      not dismissed after every post.
    -->
    <textarea
      class="text-input"
      rows="1"
      bind:value={() => value, (text) => drafts.setText(draftKey, text)}
      bind:this={textInput}
      placeholder={`Message #${chat.activeChannel?.name ?? ''}`}
      autocomplete="off"
      {...noAutocorrect}
      enterkeyhint="send"
      aria-label="Message"
      aria-autocomplete="list"
      disabled={timeoutUntil !== null}
      oninput={onInput}
      onkeydown={onKeydown}
      onclick={updateAutocomplete}
      onkeyup={(event) => {
        // Escape has just dismissed the list; looking again would reopen it.
        if (event.key !== 'Escape') updateAutocomplete();
      }}
      onfocus={updateAutocomplete}
      onblur={() => (activeTrigger = null)}
    ></textarea>
    <button
      type="button"
      class="schedule-trigger"
      title="Schedule send (Ctrl+Shift+Enter)"
      aria-label="Schedule send"
      aria-expanded={showSchedule}
      aria-haspopup="dialog"
      disabled={uploading || timeoutUntil !== null}
      onpointerdown={(event) => event.preventDefault()}
      onmousedown={(event) => event.preventDefault()}
      onclick={toggleSchedule}><Icon name="chevron-down" size={16} /></button
    >
    <button
      type="submit"
      class="send"
      aria-label="Send"
      onpointerdown={(event) => event.preventDefault()}
      onmousedown={(event) => event.preventDefault()}
      disabled={busy || uploading || timeoutUntil !== null || slowmodeRemaining > 0}
    >
      <span class="send-icon"><Icon name="send" size={20} /></span>
    </button>
  </form>
</div>
