<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { Permission, hasPermission, isGifContentType, isGifLinkUrl, type Attachment, type LinkEmbed, type Message, type User } from '@harmony/shared';
  import { ApiError } from '../lib/api';
  import { chat } from '../lib/chat.svelte';
  import { focusComposer } from '../lib/composer-field';
  import { formatForKey, toggleFormat } from '../lib/composer-format';
  import { messageLink } from '../lib/launch-params';
  import { messageEdit } from '../lib/message-edit.svelte';
  import { avatarUrl, initial } from '../lib/avatar';
  import { inlineSegmentsOf, parseMessage } from '../lib/message-text';
  import { firstUnreadIndex, newMessageCount, newMessagesLabel } from '../lib/unread';
  import { groupedRows } from '../lib/message-grouping';
  import { dayDividerLabel, messageTimeLabel, messageTimeTitle, withDayStarts } from '../lib/message-time';
  import { emojis } from '../lib/emojis.svelte';
  import { gifs } from '../lib/gifs.svelte';
  import LinkedGif from './LinkedGif.svelte';
  import { lightbox } from '../lib/lightbox.svelte';
  import { members } from '../lib/members.svelte';
  import { nameColorGlow, nameColorStyle } from '../lib/format';
  import { meta } from '../lib/meta.svelte';
  import { profileCard, hoverCapable } from '../lib/profile-card.svelte';
  import { session } from '../lib/session.svelte';
  import { ui } from '../lib/ui.svelte';
  import EmojiPicker from './EmojiPicker.svelte';
  import EditHistory from './EditHistory.svelte';
  import EmbedVideo from './EmbedVideo.svelte';
  import Icon from './Icon.svelte';
  import MemberBadge from './MemberBadge.svelte';
  import BotBadge from './BotBadge.svelte';
  import MessageContent from './MessageContent.svelte';
  import PinAction from './PinAction.svelte';
  import RemoveEmbedsAction from './RemoveEmbedsAction.svelte';
  import PollView from './PollView.svelte';
  import SaveAction from './SaveAction.svelte';
  import ServerGifAction from './ServerGifAction.svelte';

  /** Opens the profile card for an author, when there is one to show. */
  function openCard(user: User | null | undefined, element: HTMLElement): void {
    if (user && hoverCapable()) profileCard.show(user, element);
  }

  /** Opens it after the pointer rests, for the hover triggers. */
  function restCard(user: User | null | undefined, element: HTMLElement): void {
    if (user && hoverCapable()) profileCard.scheduleShow(user, element);
  }

  /** Opens the full, fixed profile viewer: the click action on a member's name or picture. */
  function openViewer(user: User | null | undefined): void {
    if (!user) return;
    profileCard.hide();
    ui.openProfileViewer(user);
  }

  let scroller = $state<HTMLDivElement | null>(null);
  /** Whether the view is still pinned to the newest message. */
  let atBottom = $state(true);
  /** Ids of the first and last rendered messages, to tell appends from prepends. */
  let firstId: string | null = null;
  let lastId: string | null = null;
  let watchedChannelId: string | null = null;
  /** The message whose reaction picker is open, if any. */
  let pickerFor = $state<string | null>(null);
  /** The message whose "Copy link" just worked, for its moment of saying so. */
  let copiedId = $state<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  /** The message whose delete is awaiting confirmation. */
  let confirmingDeleteId = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  /** The message whose action menu is open on touch, or null. */
  let actionsFor = $state<string | null>(null);
  /** Which message was open before the last tap, so a repeat tap can toggle it. */
  let lastOpenId: string | null = null;

  const myId = $derived(session.user?.id);
  const permissions = $derived(BigInt(session.permissions || '0'));

  // Custom emoji that can actually be rendered; deleted ones fall back to text.
  const knownEmojiIds = $derived(new Set(emojis.list.map((emoji) => emoji.id)));

  /**
   * Messages paired with whether they continue the previous one, computed in one
   * place rather than per row so the flag cannot go stale as messages arrive.
   * The message the "new" line sits above starts a fresh group, header and all,
   * and so does the first message of each day, under its date line.
   */
  const rows = $derived.by(() => withDayStarts(groupedRows(chat.messages, newDividerId), !chat.hasMore));

  // ---- The "new" line and the bar that points up at it ----

  /** The message the red "new" line sits above, or null when there is none to draw. */
  const newDividerId = $derived.by(() => {
    const index = firstUnreadIndex(chat.messages, chat.newSince, myId, !chat.hasMore);
    return index === -1 ? null : (chat.messages[index]?.id ?? null);
  });
  const newCount = $derived(newMessageCount(chat.messages, chat.newSince, myId, !chat.hasMore));
  let newDivider = $state<HTMLDivElement | null>(null);
  /**
   * Whether the first new message has been scrolled into view since the channel
   * was opened. Once it has, the bar has done its job and stays gone, as
   * Discord's does, even if the reader scrolls back down past it.
   */
  let newSeen = $state(false);
  let newSeenFor: string | null = null;
  $effect(() => {
    const key = `${chat.activeChannelId}:${chat.newSince}`;
    if (key !== newSeenFor) {
      newSeenFor = key;
      newSeen = false;
    }
  });
  const showNewBar = $derived(chat.newSince !== null && newCount.count > 0 && !newSeen && !chat.loading);

  /** Notes when the "new" line has come into view, from the scroll position. */
  function checkNewSeen(): void {
    const element = scroller;
    // `newDividerId` is set whenever the divider is mounted, so gating on it keeps
    // a stale ref from a removed divider from being measured.
    if (newSeen || !element || !newDividerId || !newDivider) return;
    // In view, or anywhere below the top edge of the list, counts as seen.
    if (newDivider.getBoundingClientRect().top >= element.getBoundingClientRect().top) newSeen = true;
  }

  // A channel opened with its first new message already on screen needs no bar.
  $effect(() => {
    void newDividerId;
    void chat.messages.length;
    void tick().then(checkNewSeen);
  });

  /** Loads back to the first new message if need be, then brings it into view. */
  async function jumpToNew(): Promise<void> {
    await chat.loadToFirstUnread();
    await tick();
    // A load that stopped short leaves no divider to scroll to; only count it as
    // seen once the divider was actually reached and brought into view, so the
    // bar stays put for another try rather than vanishing without the view moving.
    if (!newDividerId || !newDivider) return;
    newDivider.scrollIntoView({ block: 'start' });
    newSeen = true;
  }

  function formatSince(iso: string): string {
    const time = new Date(iso);
    const clock = formatTime(iso);
    return time.toDateString() === new Date().toDateString()
      ? clock
      : `${time.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${clock}`;
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function authorName(message: Message): string {
    // A null author is a message whose account was deleted; it stays behind.
    return message.author?.displayName ?? message.author?.username ?? 'Deleted user';
  }

  function replyAuthorName(message: Message): string {
    const author = message.replyTo?.author;
    return author?.displayName ?? author?.username ?? 'Deleted user';
  }

  function replySnippet(message: Message): string {
    if (message.replyTo?.deleted) return 'original message was deleted';
    return message.replyTo?.content.replace(/\s+/g, ' ').trim() ?? '';
  }

  /**
   * Whether a linked gif is drawn: only for an address on the allowlist, whatever
   * the server sent. While the instance links it is loaded from the gif host (the
   * page's Content-Security-Policy allows those hosts only then); while it stores,
   * from this server's own copy, which the server makes on first request.
   */
  function linkedGifShown(embed: LinkEmbed): boolean {
    return embed.gif != null && meta.data?.gifStorage != null && isGifLinkUrl(embed.url);
  }

  /**
   * Whether a message is nothing but the link a picture was fetched from.
   *
   * Such a message shows the picture and the picture alone, the way Discord does:
   * the address is right there for anyone who wants it, behind the picture itself,
   * and printing it above would only be noise. A message with anything else in it
   * keeps its text, link and all.
   */
  function isOnlyTheLink(message: Message): boolean {
    if (message.embed && linkedGifShown(message.embed)) return message.content.trim() === message.embed.url;
    const source = message.attachments.find((attachment) => attachment.sourceUrl !== null)?.sourceUrl;
    return source != null && message.content.trim() === source;
  }

  /** The largest a picture is drawn, matching the rules for `.attachments` in app.css. */
  const PICTURE_MAX_WIDTH = 420;
  const PICTURE_MAX_HEIGHT = 360;

  /**
   * The size a picture will be drawn at, as inline custom properties.
   *
   * A box left to work its own width out from the picture inside it gets it wrong
   * whenever the picture is capped by its height: a browser measures the picture
   * at full size and then caps the box by width alone, so a tall gif ends up in a
   * box wider than it is and its heart lands beside the gif instead of on it.
   * Saying the size outright, from the dimensions the attachment already carries,
   * keeps the box and the picture the same shape whatever the proportions.
   */
  function pictureSize(attachment: Attachment): string | null {
    const width = attachment.width;
    const height = attachment.height;
    if (!width || !height) return null;
    const scale = Math.min(1, PICTURE_MAX_WIDTH / width, PICTURE_MAX_HEIGHT / height);
    return `--picture-width: ${Math.round(width * scale)}px; --picture-ratio: ${width} / ${height}`;
  }

  /**
   * Keeps or forgets a gif straight from the message it was posted in, the way
   * Discord's star does. Which way it goes depends on whether the gif is already
   * saved, looked up by content hash so every copy of it answers the same.
   */
  async function toggleGifFavorite(attachment: Attachment): Promise<void> {
    const saved = gifs.byHash.get(attachment.hash);
    try {
      if (saved) await gifs.forget(saved.id);
      else await gifs.save({ attachmentId: attachment.id });
    } catch {
      // A heart that cannot act says nothing rather than interrupting the chat.
    }
  }

  // Only the author may edit; the author or any message manager may delete.
  function canEdit(message: Message): boolean {
    return message.author?.id === myId && !message.poll;
  }
  function canDelete(message: Message): boolean {
    return message.author?.id === myId || hasPermission(permissions, Permission.ManageMessages);
  }

  function pickReaction(message: Message, emoji: string, emojiId: string | null): void {
    pickerFor = null;
    void chat.toggleReaction(message.id, emoji, emojiId);
  }

  function startEdit(message: Message): void {
    actionError = null;
    messageEdit.start(message);
  }

  /** Saves the edit box; a box emptied of everything is not saved, as Save is disabled then too. */
  async function saveEdit(message: Message): Promise<void> {
    const content = messageEdit.draft.trim();
    if (!content) return;
    actionError = null;
    try {
      await chat.editMessage(message.id, content);
      // Another edit may have been started meanwhile; only this one is over.
      if (messageEdit.id === message.id) finishEdit();
    } catch (cause) {
      actionError = cause instanceof ApiError ? cause.message : String(cause);
    }
  }

  /**
   * Closes the edit box and hands the caret back to the message box, where the
   * member was most likely typing before, and where the Up arrow started it.
   */
  function finishEdit(): void {
    messageEdit.stop();
    focusComposer();
  }

  /**
   * Enter saves and Shift+Enter starts a new line, as in the message box, and
   * Escape cancels. A key that finishes an IME composition is left to the IME, by
   * the same test the composer uses. Ctrl+B, Ctrl+I and Ctrl+U format the
   * selection here too.
   */
  async function onEditKeydown(event: KeyboardEvent, message: Message): Promise<void> {
    const box = event.currentTarget as HTMLTextAreaElement;
    const format = formatForKey(event);
    if (format && !event.isComposing) {
      event.preventDefault();
      const next = toggleFormat({ text: box.value, start: box.selectionStart, end: box.selectionEnd }, format);
      messageEdit.draft = next.text;
      await tick();
      box.setSelectionRange(next.start, next.end);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void saveEdit(message);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      finishEdit();
    }
  }

  /**
   * The edit box opens ready to type in: focused, with the caret after the last
   * word, and scrolled into view, which matters when the Up arrow opened it for
   * a message further up than the screen shows. One drawn again by a reload of
   * the list takes focus back only if nothing else has it.
   */
  function focusEditBox(box: HTMLTextAreaElement): void {
    const idle = document.activeElement === null || document.activeElement === document.body;
    if (!messageEdit.takeFresh() && !idle) return;
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
    box.scrollIntoView({ block: 'nearest' });
  }

  /** Discord's "Mark unread": the channel is unread again from this message on. */
  async function markUnread(message: Message): Promise<void> {
    actionError = null;
    try {
      await chat.markUnreadFrom(message);
    } catch (cause) {
      actionError = cause instanceof ApiError ? cause.message : String(cause);
    }
  }

  /** Copies the link that opens this message, the same one a notification tap follows. */
  async function copyLink(message: Message): Promise<void> {
    const link = messageLink(window.location.origin, message.channelId, message.id);
    actionError = null;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Clipboard access needs a secure origin and the browser's consent; when it
      // is refused, the link itself is still worth having.
      actionError = `Your browser did not allow copying. The link is ${link}`;
      return;
    }
    copiedId = message.id;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedId = null;
      copiedTimer = null;
    }, 1500);
  }

  async function remove(message: Message): Promise<void> {
    actionError = null;
    try {
      await chat.deleteMessage(message.id);
    } catch (cause) {
      actionError = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      confirmingDeleteId = null;
    }
  }

  function onScroll(): void {
    const element = scroller;
    if (!element) return;
    atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
    checkNewSeen();
    if (element.scrollTop < 80) void loadOlder();
    // An older stretch reads on towards the present as its end comes into view.
    if (chat.detached && element.scrollHeight - element.scrollTop - element.clientHeight < 80) void loadNewer();
  }

  /**
   * On a touch screen a tap opens a message's actions. Long press is left to the
   * browser so text can still be selected, and anything with its own tap
   * behavior (a link, a button, a spoiler, a name or avatar) is left alone.
   * On a device with hover the actions already appear on hover, so a click does
   * nothing here.
   */
  function onMessageClick(event: MouseEvent, message: Message): void {
    const target = event.target as Element | null;
    // The emoji picker is its own surface inside the row, with a search field and
    // stretches of padding between the emoji; a tap on any of it belongs to the
    // picker, not to the message. The same goes for the edit box.
    if (target?.closest('a, button, .spoiler, .profile-trigger, .emoji-picker, .edit-form')) return;

    // Alt+click marks the channel unread from this message, as on Discord.
    if (event.altKey) {
      event.preventDefault();
      void markUnread(message);
      return;
    }

    // A device with hover already shows the actions on hover.
    if (window.matchMedia('(hover: hover)').matches) return;

    // A tap while text is selected just clears the selection.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      selection.removeAllRanges();
      return;
    }

    actionsFor = lastOpenId === message.id ? null : message.id;
  }

  onMount(() => {
    // A tap anywhere but the menu itself closes it, and records which message it
    // was on so tapping that same message again toggles it shut.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (target?.closest('.message-actions')) return;
      lastOpenId = actionsFor;
      actionsFor = null;
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });

  // A channel change leaves any open menu, or edit box, pointing at the wrong list.
  $effect(() => {
    void chat.activeChannelId;
    actionsFor = null;
    untrack(() => messageEdit.stop());
  });

  // So does a jump within the channel, or a delete, that takes the message being
  // edited out of the list; left open, its box would come back with the message
  // later and catch what was being typed elsewhere.
  $effect(() => {
    const id = messageEdit.id;
    if (id && !chat.loading && !chat.messages.some((message) => message.id === id)) {
      untrack(() => messageEdit.stop());
    }
  });

  /** Loads an older page while holding the messages already on screen in place. */
  async function loadOlder(): Promise<void> {
    const element = scroller;
    if (!element) return;

    const previousHeight = element.scrollHeight;
    const previousTop = element.scrollTop;
    await chat.loadOlder();
    await tick();

    // The prepend made the list taller; keep the viewport over the same message.
    const grown = element.scrollHeight - previousHeight;
    if (grown > 0) element.scrollTop = previousTop + grown;
  }

  /**
   * Loads the page after an older stretch. It lands below the reader, so the
   * viewport stays over the same messages by itself; the view only has to stop
   * believing it is at the bottom, or the next row to settle would pin it to the
   * end of a page nobody has read yet.
   */
  async function loadNewer(): Promise<void> {
    const element = scroller;
    if (!element) return;
    await chat.loadNewer();
    await tick();
    atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
  }

  let sizeObserver: ResizeObserver | null = null;

  /**
   * Re-pins the view to the newest message when it is already at the bottom. Also
   * watches the scroller itself, because anything that takes height away from it -
   * the reply bar, the typing line, a growing composer - would otherwise push the
   * newest messages below the fold without changing a single row.
   */
  function onRowResize(): void {
    const element = scroller;
    if (!element || !atBottom) return;
    element.scrollTo({ top: element.scrollHeight });
  }

  /**
   * Keeps the view pinned to the newest message when a row grows for a reason
   * other than a new message: a link preview arriving a moment late, an image
   * finishing its load, or a reaction picker or edit form opening. Watching the
   * message list alone cannot see any of those, because the list is unchanged. The
   * scroller is tracked the same way, since it can be resized from outside the
   * list entirely.
   */
  function trackSize(element: HTMLElement): { destroy: () => void } {
    sizeObserver ??= new ResizeObserver(onRowResize);
    sizeObserver.observe(element);
    return {
      destroy(): void {
        sizeObserver?.unobserve(element);
      },
    };
  }

  /** Whether the list was an older stretch the last time it changed. */
  let wasDetached = false;

  // Follow the newest message, but never yank the view when older pages load.
  $effect(() => {
    const element = scroller;
    const channelId = chat.activeChannelId;
    const newest = chat.messages.at(-1)?.id ?? null;
    const oldest = chat.messages[0]?.id ?? null;
    const detached = chat.detached;

    if (channelId !== watchedChannelId) {
      watchedChannelId = channelId;
      firstId = null;
      lastId = null;
      wasDetached = false;
    }

    const prepended = firstId !== null && oldest !== firstId;
    const previousNewest = lastId;
    const previouslyDetached = wasDetached;
    firstId = oldest;
    lastId = newest;
    wasDetached = detached;

    // The end of an older stretch is not the present, and a page added to it,
    // even the one that rejoins the present, is read from where the reader is.
    if (!element || prepended || previouslyDetached) return;
    if (newest !== null && newest !== previousNewest && (previousNewest === null || atBottom)) {
      element.scrollTo({ top: element.scrollHeight });
    }
  });

  /*
   * A search result jumps to a message, which replaces the whole list and so looks
   * like a prepend to the effect above. The signal scrolls regardless of where the
   * reader was, since they asked to be taken to that message.
   */
  let seenScrollSignal = 0;
  $effect(() => {
    const signal = chat.scrollSignal;
    if (signal === seenScrollSignal) return;
    seenScrollSignal = signal;
    const element = scroller;
    if (!element) return;
    // A jump that landed among recent messages has newer ones below it, so the
    // end of the list is not where it is; find the flashed row itself.
    const target = chat.highlightedId
      ? element.querySelector(`[data-message-id="${CSS.escape(chat.highlightedId)}"]`)
      : null;
    if (target) target.scrollIntoView({ block: 'center' });
    else element.scrollTo({ top: element.scrollHeight });
  });
</script>

{#snippet embedText(embed: LinkEmbed)}
  {#if embed.siteName}<span class="embed-site">{embed.siteName}</span>{/if}
  {#if embed.title}<span class="embed-title">{embed.title}</span>{/if}
  {#if embed.description}
    <span class="embed-description">{embed.description}</span>
  {/if}
{/snippet}

<div class="messages" bind:this={scroller} use:trackSize onscroll={onScroll}>
  <!--
    New messages above the view: how many and since when, a way up to the first
    of them, and a way to say they have been seen. It sits at the top so it never
    meets the "Jump to present" bar at the bottom.
  -->
  {#if showNewBar && chat.newSince}
    <div class="new-bar" role="status">
      <button type="button" class="new-bar-jump" onclick={() => void jumpToNew()}>
        {newMessagesLabel(newCount.count, newCount.more, chat.newSince, formatSince)}
      </button>
      <button type="button" class="new-bar-read" onclick={() => chat.dismissNew()}>Mark as read</button>
    </div>
  {/if}

  {#if actionError}
    <p class="form-error pad">{actionError}</p>
  {/if}

  {#if chat.loadingOlder}
    <p class="muted pad">Loading older messages…</p>
  {/if}

  {#if chat.loading}
    <p class="muted pad">Loading…</p>
  {:else if chat.messages.length === 0}
    <p class="muted pad">No messages yet. Say hello!</p>
  {:else}
    {#each rows as row (row.message.id)}
      {@const message = row.message}
      {@const grouped = row.grouped}
      {@const blocks = parseMessage(
        message.content,
        emojis.lookup,
        (name) => members.byUsername.get(name.toLowerCase()),
        chat.channels,
      )}
      {@const mentionsMe = inlineSegmentsOf(blocks).some(
        (segment) => segment.type === 'mention' && segment.user.id === myId,
      )}
      {@const picture = avatarUrl(message.author)}
      {@const sentAt = Date.parse(message.createdAt)}
      {#if row.dayStart}
        <div class="day-divider" role="separator" aria-label={dayDividerLabel(sentAt)}>
          <span>{dayDividerLabel(sentAt)}</span>
        </div>
      {/if}
      {#if message.id === newDividerId}
        <div class="new-divider" role="separator" aria-label="New messages" bind:this={newDivider}>
          <span>New</span>
        </div>
      {/if}
      <!--
        The tap handler is a touch-only shortcut for opening the actions; it is
        inert wherever hover exists, and keyboard users reveal the same actions
        by focusing a control inside the message.
      -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <article
        class="message"
        class:grouped
        class:mentions-me={mentionsMe}
        class:selected={chat.replyTarget?.id === message.id}
        class:actions-open={actionsFor === message.id}
        class:highlighted={chat.highlightedId === message.id}
        data-message-id={message.id}
        use:trackSize
        onclick={(event) => onMessageClick(event, message)}
      >
        {#if grouped}
          <div class="avatar-spacer" aria-hidden="true">
            <span class="gutter-time" title={messageTimeTitle(sentAt)}>{formatTime(message.createdAt)}</span>
          </div>
        {:else if picture}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -->
          <img
            class="avatar profile-trigger"
            src={picture}
            alt=""
            loading="lazy"
            onmouseenter={(event) => restCard(message.author, event.currentTarget)}
            onmouseleave={() => profileCard.scheduleHide()}
            onclick={() => openViewer(message.author)}
          />
        {:else}
          <button
            type="button"
            class="avatar fallback profile-trigger"
            aria-label={authorName(message)}
            onmouseenter={(event) => restCard(message.author, event.currentTarget)}
            onmouseleave={() => profileCard.scheduleHide()}
            onfocus={(event) => openCard(message.author, event.currentTarget)}
            onblur={() => profileCard.scheduleHide()}
            onclick={() => openViewer(message.author)}
          >
            {initial(message.author)}
          </button>
        {/if}
        <div class="body">
          {#if message.replyTo}
            {@const replyTo = message.replyTo}
            {#if replyTo.deleted}
              <div class="reply-ref deleted">
                <span class="reply-author">{replyAuthorName(message)}</span>
                <span class="reply-text">{replySnippet(message)}</span>
              </div>
            {:else}
              <!-- The quote is the way to the message it answers, wherever in history that is. -->
              <button
                type="button"
                class="reply-ref"
                aria-label={`Jump to the replied message from ${replyAuthorName(message)}`}
                title="Jump to the replied message"
                onclick={() => void chat.revealMessage(replyTo.id)}
              >
                <span class="reply-author">{replyAuthorName(message)}</span>
                {#if replySnippet(message)}
                  <span class="reply-text">{replySnippet(message)}</span>
                {/if}
              </button>
            {/if}
          {/if}

          {#if !grouped}
            <div class="meta">
              <button
                type="button"
                class="author profile-trigger"
                class:name-glow={nameColorGlow(message.author)}
                style={nameColorStyle(message.author)}
                onmouseenter={(event) => restCard(message.author, event.currentTarget)}
                onmouseleave={() => profileCard.scheduleHide()}
                onfocus={(event) => openCard(message.author, event.currentTarget)}
                onblur={() => profileCard.scheduleHide()}
                onclick={() => openViewer(message.author)}
              >
                {authorName(message)}
              </button>
              {#if message.author?.badge}
                <MemberBadge badge={message.author.badge} />
              {/if}
              {#if message.author?.accountType === 'bot'}
                <BotBadge size={13} />
              {/if}
              <time datetime={message.createdAt} title={messageTimeTitle(sentAt)}>{messageTimeLabel(sentAt)}</time>
              {#if message.editedAt}<EditHistory {message} />{/if}
              {#if message.pinnedAt}<span class="pin-marker" title="Pinned"><Icon name="pin" size={13} /></span>{/if}
            </div>
          {:else if message.editedAt}
            <EditHistory {message} />
          {/if}
          {#if grouped && message.pinnedAt}<span class="pin-marker grouped" title="Pinned"><Icon name="pin" size={13} /></span>{/if}

          {#if messageEdit.id === message.id}
            <form
              class="edit-form"
              onsubmit={(event) => {
                event.preventDefault();
                void saveEdit(message);
              }}
            >
              <textarea
                class="edit-box"
                bind:value={messageEdit.draft}
                rows="3"
                aria-label="Edit message"
                aria-describedby="edit-hint-{message.id}"
                use:focusEditBox
                onkeydown={(event) => onEditKeydown(event, message)}
              ></textarea>
              <p id="edit-hint-{message.id}" class="edit-hint">Enter to save, Shift+Enter for a new line, Escape to cancel</p>
              <div class="edit-actions">
                <button type="submit" disabled={!messageEdit.draft.trim()}>Save</button>
                <button type="button" class="ghost" onclick={finishEdit}>Cancel</button>
              </div>
            </form>
          {:else}
            {#if message.content && !isOnlyTheLink(message) && !message.poll}
              <div class="content"><MessageContent {blocks} allowJumbo={message.attachments.length === 0} /></div>
            {/if}

            {#if message.stickers.length > 0}
              <div class="stickers">
                {#each message.stickers as sticker (sticker.id)}
                  <a
                    class="sticker"
                    href={`/api/v1/stickers/${sticker.id}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    onclick={(event) => {
                      event.preventDefault();
                      lightbox.open(`/api/v1/stickers/${sticker.id}`, sticker.name);
                    }}
                  >
                    <img src={`/api/v1/stickers/${sticker.id}`} alt={sticker.name} title={sticker.name} loading="lazy" />
                  </a>
                {/each}
              </div>
            {/if}

            {#if message.attachments.length > 0}
              <div class="attachments">
                {#each message.attachments as attachment (attachment.id)}
                  {#if attachment.contentType.startsWith('video/')}
                    <!-- Clips are stored as they arrive, with no caption track to offer. -->
                    <!-- svelte-ignore a11y_media_has_caption -->
                    <video
                      class="attachment-video"
                      src={`/api/v1/attachments/${attachment.id}`}
                      controls
                      preload="metadata"
                    ></video>
                  {:else}
                    <!--
                      A picture fetched from a link points back at where it came
                      from, the way an embed does, so the original is one click or
                      one right-click away. An upload has nowhere else to point.
                    -->
                    <div
                      class="attachment-picture"
                      class:sized={pictureSize(attachment) !== null}
                      style={pictureSize(attachment)}
                    >
                      <a
                        href={attachment.sourceUrl ?? `/api/v1/attachments/${attachment.id}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        onclick={(event) => {
                          // Show it large in the app. The href stays for
                          // open-in-new-tab and the no-script case, but Electron
                          // has no tab to open. The lightbox shows our own copy,
                          // not a source link that may have gone dead.
                          event.preventDefault();
                          lightbox.open(`/api/v1/attachments/${attachment.id}`, attachment.filename);
                        }}
                      >
                        <img
                          src={`/api/v1/attachments/${attachment.id}`}
                          alt={attachment.filename}
                          width={attachment.width ?? undefined}
                          height={attachment.height ?? undefined}
                          loading="lazy"
                        />
                      </a>
                      {#if isGifContentType(attachment.contentType)}
                        <button
                          type="button"
                          class="gif-heart"
                          class:on={gifs.byHash.has(attachment.hash)}
                          aria-pressed={gifs.byHash.has(attachment.hash)}
                          title={gifs.byHash.has(attachment.hash)
                            ? 'Remove from favorites'
                            : 'Add to favorites'}
                          onclick={() => toggleGifFavorite(attachment)}
                        >
                          {#if gifs.byHash.has(attachment.hash)}
                            <Icon name="heart-filled" size={16} />
                          {:else}
                            <Icon name="heart" size={16} />
                          {/if}
                        </button>
                      {/if}
                    </div>
                  {/if}
                {/each}
              </div>
            {/if}

            {#if message.reactions.length > 0}
              <div class="reactions">
                {#each message.reactions as reaction (reaction.emoji)}
                  <button
                    type="button"
                    class="reaction"
                    class:me={reaction.me}
                    title={reaction.me ? 'Remove your reaction' : 'Add your reaction'}
                    onclick={() => pickReaction(message, reaction.emoji, reaction.emojiId)}
                  >
                    {#if reaction.emojiId && knownEmojiIds.has(reaction.emojiId)}
                      <img class="emoji" src={`/api/v1/emojis/${reaction.emojiId}`} alt={reaction.emoji} />
                    {:else}
                      <span class="reaction-emoji">{reaction.emoji}</span>
                    {/if}
                    <span class="reaction-count">{reaction.count}</span>
                  </button>
                {/each}
              </div>
            {/if}

            {#if message.poll}
              <PollView {message} poll={message.poll} />
            {/if}

            {#if message.embed}
              {#if message.embed.gif}
                <!--
                  A gif the instance links to instead of storing. It is drawn straight
                  from the gif host, which sees the viewer's address, so it only shows
                  while the instance is in link mode, and only for an allowlisted host.
                -->
                {#if linkedGifShown(message.embed)}
                  <LinkedGif url={message.embed.url} contentType={message.embed.gif.contentType} mode={meta.data?.gifStorage} />
                {/if}
              {:else if message.embed.player}
                <div class="embed">
                  <EmbedVideo
                    player={message.embed.player}
                    title={message.embed.title}
                    imageUrl={message.embed.imageUrl}
                  />
                  <a class="embed-body" href={message.embed.url} target="_blank" rel="noreferrer noopener">
                    {@render embedText(message.embed)}
                  </a>
                </div>
              {:else}
                <a class="embed" href={message.embed.url} target="_blank" rel="noreferrer noopener">
                  {#if message.embed.imageUrl}
                    <!-- Fetched through the server, not straight from the third party. -->
                    <img
                      class="embed-image"
                      src={`/api/v1/embeds/media?url=${encodeURIComponent(message.embed.imageUrl)}`}
                      alt=""
                      loading="lazy"
                    />
                  {/if}
                  {@render embedText(message.embed)}
                </a>
              {/if}
            {/if}
          {/if}

          {#if pickerFor === message.id}
            <div class="reaction-picker">
              <EmojiPicker onpick={(emoji, emojiId) => pickReaction(message, emoji, emojiId)} />
            </div>
          {/if}
        </div>

        <div class="message-actions" class:open={actionsFor === message.id}>
          <button
            type="button"
            title="Reply"
            onclick={() => {
              chat.replyTarget = message;
              actionsFor = null;
              // Straight from the click, so a phone raises the keyboard.
              focusComposer();
            }}>Reply</button
          >
          <button
            type="button"
            title="Add reaction"
            onclick={() => {
              pickerFor = pickerFor === message.id ? null : message.id;
              actionsFor = null;
            }}
          >
            React
          </button>
          <button
            type="button"
            title="Copy a link that opens this message"
            onclick={() => {
              void copyLink(message);
              actionsFor = null;
            }}>{copiedId === message.id ? 'Copied' : 'Copy link'}</button
          >
          <button
            type="button"
            title="Mark the channel unread from this message (Alt+click a message)"
            onclick={() => {
              void markUnread(message);
              actionsFor = null;
            }}>Mark unread</button
          >
          <PinAction {message} ondone={() => (actionsFor = null)} onerror={(text) => (actionError = text)} />
          <SaveAction {message} ondone={() => (actionsFor = null)} onerror={(text) => (actionError = text)} />
          <ServerGifAction {message} ondone={() => (actionsFor = null)} onerror={(text) => (actionError = text)} />
          <RemoveEmbedsAction {message} ondone={() => (actionsFor = null)} onerror={(text) => (actionError = text)} />
          {#if canEdit(message)}
            <button
              type="button"
              title="Edit"
              onclick={() => {
                startEdit(message);
                actionsFor = null;
              }}>Edit</button
            >
          {/if}
          {#if canDelete(message)}
            {#if confirmingDeleteId === message.id}
              <button
                type="button"
                class="danger"
                onclick={() => {
                  void remove(message);
                  actionsFor = null;
                }}>Confirm</button
              >
              <button type="button" onclick={() => (confirmingDeleteId = null)}>Cancel</button>
            {:else}
              <!-- Shift skips the confirming step, as on Discord. -->
              <button
                type="button"
                title="Delete (Shift+click to delete without confirming)"
                onclick={(event) => {
                  if (event.shiftKey) {
                    void remove(message);
                    actionsFor = null;
                  } else {
                    confirmingDeleteId = message.id;
                  }
                }}>Delete</button
              >
            {/if}
          {/if}
        </div>
      </article>
    {/each}
  {/if}

  {#if chat.loadingNewer}
    <p class="muted pad">Loading newer messages…</p>
  {/if}

  <!--
    After a jump to a search or inbox result, or a link to an old message, the
    list can be an older stretch of history with newer messages held back. It
    reads on towards the present as the reader scrolls down, and the leap there
    is always in reach.
  -->
  {#if chat.detached && !chat.loading}
    <div class="present-bar" role="status">
      <span>You are viewing older messages.</span>
      <button type="button" onclick={() => void chat.jumpToPresent()}>Jump to present</button>
    </div>
  {/if}
</div>

<style>
  .present-bar {
    position: sticky;
    bottom: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin: 0.75rem -0.6rem 0;
    padding: 0.5rem 0.75rem;
    border-radius: var(--h-radius-sm);
    /* It rides over scrolled messages, so it takes the floating-layer glass
       treatment rather than a solid well. */
    background: var(--h-glass-bg);
    -webkit-backdrop-filter: blur(var(--h-glass-blur));
    backdrop-filter: blur(var(--h-glass-blur));
    border: 1px solid var(--h-glass-border);
    box-shadow: var(--h-shadow-lg);
    color: var(--h-text-muted);
    font-size: 0.85rem;
  }

  .present-bar button {
    flex-shrink: 0;
  }

  .new-bar {
    /* Flush with the top edge of the list, over its padding, as Discord's is. */
    position: sticky;
    top: -1rem;
    z-index: 2;
    display: flex;
    align-items: stretch;
    margin: -1rem -0.6rem 0.5rem;
    border-radius: 0 0 var(--h-radius-sm) var(--h-radius-sm);
    background: var(--h-accent);
    color: var(--h-on-accent);
    font-size: 0.8rem;
    font-weight: 600;
    box-shadow: var(--h-shadow-sm);
  }

  .new-bar button {
    padding: 0.35rem 0.75rem;
    border-radius: 0;
    background: none;
    color: inherit;
    font-size: inherit;
  }

  .new-bar button:hover:not(:disabled) {
    background: rgb(0 0 0 / 12%);
    box-shadow: none;
  }

  .new-bar button:active:not(:disabled) {
    transform: none;
  }

  .new-bar-jump {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .new-bar-read {
    flex: none;
  }

  /* The line where a new day starts, with its date in the middle. */
  .day-divider {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 1rem 0 0.3rem;
    color: var(--h-text-faint);
    font-size: 0.72rem;
    font-weight: 700;
  }

  .day-divider::before,
  .day-divider::after {
    content: '';
    flex: 1;
    border-top: 1px solid var(--h-border);
  }

  .new-divider {
    display: flex;
    align-items: center;
    margin: 0.6rem 0 0.2rem;
    border-top: 1px solid var(--h-error);
    height: 0;
  }

  .new-divider span {
    margin-left: auto;
    padding: 0 0.3rem;
    border-radius: var(--h-radius-xs);
    background: var(--h-error);
    color: #fff;
    font-size: 0.62rem;
    font-weight: 800;
    letter-spacing: 0.04em;
    line-height: 1rem;
    text-transform: uppercase;
    transform: translateY(-50%);
  }
</style>
