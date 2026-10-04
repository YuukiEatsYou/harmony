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
  import { mediaFilesFrom } from '../lib/files';
  import { members } from '../lib/members.svelte';
  import { meta } from '../lib/meta.svelte';
  import { session } from '../lib/session.svelte';
  import { uploads } from '../lib/upload-queue.svelte';
  import EmojiPicker from './EmojiPicker.svelte';
  import GifPicker from './GifPicker.svelte';
  import Icon from './Icon.svelte';

  const acceptAttribute = ALLOWED_ATTACHMENT_TYPES.join(',');
  const maxAttachments = LIMITS.attachmentsPerMessage;
  /** How many matches any autocomplete offers at once. */
  const maxSuggestions = 8;
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

  /** The `:emoji` or `@mention` fragment being typed at the caret, if any. */
  let activeTrigger = $state<Trigger | null>(null);
  let highlight = $state(0);

  type Trigger =
    | { kind: 'emoji'; start: number; query: string }
    | { kind: 'mention'; start: number; query: string }
    | { kind: 'channel'; start: number; query: string };

  /** One row in the autocomplete popup, whichever kind it is. */
  interface Suggestion {
    key: string;
    label: string;
    detail: string | null;
    imageUrl: string | null;
    initial: string | null;
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
   * Inserts whatever the picker chose where the caret was, replacing any
   * selection, then puts the caret back after it so typing carries on. A server
   * emoji arrives as its `:name:` shortcode and a unicode one as the character
   * itself, so either way the text is what goes in the field.
   *
   * A textarea keeps its selection while the picker has focus, which is what
   * makes the caret still readable here.
   */
  async function insertEmoji(emoji: string): Promise<void> {
    const input = textInput;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
    drafts.setText(draftKey, `${before}${lead}${emoji}${trail}${after}`);
    showPicker = false;

    await tick();
    const position = start + lead.length + emoji.length + trail.length;
    input?.focus();
    input?.setSelectionRange(position, position);
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
   * Finds the `:name` or `@name` fragment ending at the caret, delimited by the
   * start of the line or whitespace, the way Discord triggers autocomplete.
   */
  function detectTrigger(text: string, caret: number): Trigger | null {
    const before = text.slice(0, caret);

    const emoji = /(?:^|\s):([a-zA-Z0-9_]{0,32})$/.exec(before);
    if (emoji) {
      const query = emoji[1] ?? '';
      return { kind: 'emoji', start: caret - query.length - 1, query };
    }

    const mention = /(?:^|\s)@([a-zA-Z0-9._-]{0,32})$/.exec(before);
    if (mention) {
      const query = mention[1] ?? '';
      return { kind: 'mention', start: caret - query.length - 1, query };
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
      return [...prefix, ...rest].slice(0, maxSuggestions).map((emoji) => ({
        key: `emoji:${emoji.id}`,
        label: `:${emoji.name}:`,
        detail: null,
        imageUrl: `/api/v1/emojis/${emoji.id}`,
        initial: null,
        insert: `:${emoji.name}: `,
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
        insert: `#${channel.name} `,
      }));
    }

    return mentionableUsers
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
        insert: `@${user.username} `,
      }));
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
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        highlight = (highlight + 1) % suggestions.length;
        return;
      }
      if (event.key === 'ArrowUp') {
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

    // Enter sends and Shift+Enter starts a new line, as in Discord. A key that
    // finishes an IME composition is left to the IME, or picking a Japanese
    // candidate would send the message. On touch keyboards there is no Shift, so
    // the send key keeps sending; multi-line text there comes from pasting.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
      return;
    }

    // Escape only ever backs out of something; the draft itself is never cleared.
    if (event.key === 'Escape') {
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
    const content = value.trim();
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
    <EmojiPicker onpick={(emoji) => insertEmoji(emoji)} />
  {/if}

  {#if showGifs}
    <GifPicker onpick={addGif} />
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
    <ul class="autocomplete" role="listbox" aria-label="Suggestions">
      {#each suggestions as suggestion, index (suggestion.key)}
        <li>
          <button
            type="button"
            role="option"
            aria-selected={index === highlight}
            class="autocomplete-item"
            class:active={index === highlight}
            onpointerdown={(event) => event.preventDefault()}
            onclick={() => acceptSuggestion(suggestion)}
            onmouseenter={() => (highlight = index)}
          >
            {#if suggestion.imageUrl}
              <img class="autocomplete-image" src={suggestion.imageUrl} alt="" />
            {:else if suggestion.initial}
              <span class="autocomplete-initial">{suggestion.initial}</span>
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
      class="attach"
      title="Add emoji"
      aria-label="Add emoji"
      onclick={() => {
        showPicker = !showPicker;
        showGifs = false;
      }}><Icon name="smile" size={20} /></button
    >
    <button
      type="button"
      class="attach attach-gif"
      title="Add gif"
      aria-label="Add gif"
      onclick={() => {
        showGifs = !showGifs;
        showPicker = false;
      }}>GIF</button>
    <button
      type="button"
      class="attach"
      title="Attach image"
      aria-label="Attach image"
      disabled={uploading || timeoutUntil !== null}
      onclick={() => fileInput?.click()}
    >
      {#if uploading}…{:else}<Icon name="paperclip" size={20} />{/if}
    </button>
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
    <button type="submit" disabled={busy || uploading || timeoutUntil !== null || slowmodeRemaining > 0}>Send</button>
  </form>
</div>
