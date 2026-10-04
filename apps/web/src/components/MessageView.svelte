<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Permission, hasPermission, isGifContentType, type Attachment, type LinkEmbed, type Message, type User } from '@harmony/shared';
  import { ApiError } from '../lib/api';
  import { chat } from '../lib/chat.svelte';
  import { avatarUrl, initial } from '../lib/avatar';
  import { parseMessage, type InlineSegment } from '../lib/message-text';
  import { emojis } from '../lib/emojis.svelte';
  import { gifs } from '../lib/gifs.svelte';
  import { members } from '../lib/members.svelte';
  import { profileCard } from '../lib/profile-card.svelte';
  import { session } from '../lib/session.svelte';
  import EmojiPicker from './EmojiPicker.svelte';
  import EmbedVideo from './EmbedVideo.svelte';
  import Icon from './Icon.svelte';
  import MemberBadge from './MemberBadge.svelte';

  /** Opens the profile card for an author, when there is one to show. */
  function openCard(user: User | null | undefined, element: HTMLElement): void {
    if (user) profileCard.show(user, element);
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
  /** The message currently being edited, and its draft text. */
  let editingId = $state<string | null>(null);
  let editValue = $state('');
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

  /** Consecutive messages from one author within this window are grouped. */
  const groupingWindowMs = 7 * 60 * 1000;

  /**
   * Whether a message continues the previous one: same author, close in time,
   * and not a reply (a reply always shows its own header, like Discord).
   */
  function isGrouped(previous: Message | undefined, message: Message): boolean {
    if (!previous?.author || !message.author) return false;
    if (message.replyTo) return false;
    if (previous.author.id !== message.author.id) return false;
    const gap = new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime();
    return gap >= 0 && gap <= groupingWindowMs;
  }

  /**
   * Messages paired with whether they continue the previous one. Computed in one
   * place rather than per row, so the flag is always evaluated against the whole
   * list and cannot go stale as messages arrive.
   */
  const rows = $derived.by(() =>
    chat.messages.map((message, index) => ({
      message,
      grouped: isGrouped(index > 0 ? chat.messages[index - 1] : undefined, message),
    })),
  );

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
   * Whether a message is nothing but the link a picture was fetched from.
   *
   * Such a message shows the picture and the picture alone, the way Discord does:
   * the address is right there for anyone who wants it, behind the picture itself,
   * and printing it above would only be noise. A message with anything else in it
   * keeps its text, link and all.
   */
  function isOnlyTheLink(message: Message): boolean {
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
    return message.author?.id === myId;
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
    editingId = message.id;
    editValue = message.content;
  }

  async function saveEdit(event: SubmitEvent, message: Message): Promise<void> {
    event.preventDefault();
    const content = editValue.trim();
    if (!content) return;
    actionError = null;
    try {
      await chat.editMessage(message.id, content);
      editingId = null;
    } catch (cause) {
      actionError = cause instanceof ApiError ? cause.message : String(cause);
    }
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
    if (element.scrollTop < 80) void loadOlder();
  }

  /**
   * On a touch screen a tap opens a message's actions. Long press is left to the
   * browser so text can still be selected, and anything with its own tap
   * behavior (a link, a button, a spoiler, a name or avatar) is left alone.
   * On a device with hover the actions already appear on hover, so a click does
   * nothing here.
   */
  function onMessageClick(event: MouseEvent, message: Message): void {
    // A device with hover already shows the actions on hover.
    if (window.matchMedia('(hover: hover)').matches) return;

    const target = event.target as Element | null;
    // The emoji picker is its own surface inside the row, with a search field and
    // stretches of padding between the emoji; a tap on any of it belongs to the
    // picker, not to the message.
    if (target?.closest('a, button, .spoiler, .profile-trigger, .emoji-picker')) return;

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

  // A channel change leaves any open menu pointing at the wrong list.
  $effect(() => {
    void chat.activeChannelId;
    actionsFor = null;
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

  // Follow the newest message, but never yank the view when older pages load.
  $effect(() => {
    const element = scroller;
    const channelId = chat.activeChannelId;
    const newest = chat.messages.at(-1)?.id ?? null;
    const oldest = chat.messages[0]?.id ?? null;

    if (channelId !== watchedChannelId) {
      watchedChannelId = channelId;
      firstId = null;
      lastId = null;
    }

    const prepended = firstId !== null && oldest !== firstId;
    const previousNewest = lastId;
    firstId = oldest;
    lastId = newest;

    if (!element || prepended) return;
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

{#snippet inlineSegments(segments: InlineSegment[])}
  {#each segments as segment, index (index)}
    <span
      class="seg"
      class:bold={segment.styles?.bold}
      class:italic={segment.styles?.italic}
      class:underline={segment.styles?.underline}
      class:strike={segment.styles?.strike}
      class:spoiler={segment.styles?.spoiler}
    >
      {#if segment.type === 'emoji'}
        <img
          class="emoji"
          src={`/api/v1/emojis/${segment.emoji.id}`}
          alt={`:${segment.emoji.name}:`}
          title={`:${segment.emoji.name}:`}
        />
      {:else if segment.type === 'mention'}
        <button
          type="button"
          class="mention profile-trigger"
          title={`@${segment.user.username}`}
          onmouseenter={(event) => openCard(segment.user, event.currentTarget)}
          onmouseleave={() => profileCard.scheduleHide()}
          onfocus={(event) => openCard(segment.user, event.currentTarget)}
          onblur={() => profileCard.scheduleHide()}
        >
          @{segment.user.displayName ?? segment.user.username}
        </button>
      {:else if segment.type === 'channel'}
        <button
          type="button"
          class="channel-mention"
          title={`#${segment.channel.name}`}
          onclick={() => chat.selectChannel(segment.channel.id)}
        >
          #{segment.channel.name}
        </button>
      {:else if segment.type === 'link'}
        <a class="link" href={segment.href} target="_blank" rel="noreferrer noopener">{segment.value}</a>
      {:else if segment.type === 'code'}
        <code class="inline-code">{segment.value}</code>
      {:else}
        {segment.value}
      {/if}
    </span>
  {/each}
{/snippet}

{#snippet embedText(embed: LinkEmbed)}
  {#if embed.siteName}<span class="embed-site">{embed.siteName}</span>{/if}
  {#if embed.title}<span class="embed-title">{embed.title}</span>{/if}
  {#if embed.description}
    <span class="embed-description">{embed.description}</span>
  {/if}
{/snippet}

<div class="messages" bind:this={scroller} use:trackSize onscroll={onScroll}>
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
      {@const authorColor =
        message.author?.roleColor == null
          ? null
          : `#${message.author.roleColor.toString(16).padStart(6, '0')}`}
      {@const blocks = parseMessage(
        message.content,
        emojis.lookup,
        (name) => members.byUsername.get(name.toLowerCase()),
        chat.channels,
      )}
      {@const mentionsMe = blocks.some(
        (block) =>
          block.type !== 'code' &&
          block.segments.some((segment) => segment.type === 'mention' && segment.user.id === myId),
      )}
      {@const picture = avatarUrl(message.author)}
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
          <div class="avatar-spacer" aria-hidden="true"><span class="gutter-time">{formatTime(message.createdAt)}</span></div>
        {:else if picture}
          <img
            class="avatar profile-trigger"
            src={picture}
            alt=""
            loading="lazy"
            onmouseenter={(event) => openCard(message.author, event.currentTarget)}
            onmouseleave={() => profileCard.scheduleHide()}
          />
        {:else}
          <button
            type="button"
            class="avatar fallback profile-trigger"
            aria-label={authorName(message)}
            onmouseenter={(event) => openCard(message.author, event.currentTarget)}
            onmouseleave={() => profileCard.scheduleHide()}
            onfocus={(event) => openCard(message.author, event.currentTarget)}
            onblur={() => profileCard.scheduleHide()}
            onclick={(event) => openCard(message.author, event.currentTarget)}
          >
            {initial(message.author)}
          </button>
        {/if}
        <div class="body">
          {#if message.replyTo}
            <div class="reply-ref" class:deleted={message.replyTo.deleted}>
              <span class="reply-author">{replyAuthorName(message)}</span>
              {#if replySnippet(message)}
                <span class="reply-text">{replySnippet(message)}</span>
              {/if}
            </div>
          {/if}

          {#if !grouped}
            <div class="meta">
              <button
                type="button"
                class="author profile-trigger"
                style={authorColor ? `color: ${authorColor}` : ''}
                onmouseenter={(event) => openCard(message.author, event.currentTarget)}
                onmouseleave={() => profileCard.scheduleHide()}
                onfocus={(event) => openCard(message.author, event.currentTarget)}
                onblur={() => profileCard.scheduleHide()}
              >
                {authorName(message)}
              </button>
              {#if message.author?.badge}
                <MemberBadge badge={message.author.badge} />
              {/if}
              <time>{formatTime(message.createdAt)}</time>
              {#if message.editedAt}<span class="edited">(edited)</span>{/if}
            </div>
          {:else if message.editedAt}
            <span class="edited">(edited)</span>
          {/if}

          {#if editingId === message.id}
            <form class="edit-form" onsubmit={(event) => saveEdit(event, message)}>
              <textarea class="edit-box" bind:value={editValue} rows="3" aria-label="Edit message"></textarea>
              <div class="edit-actions">
                <button type="submit" disabled={!editValue.trim()}>Save</button>
                <button type="button" class="ghost" onclick={() => (editingId = null)}>Cancel</button>
              </div>
            </form>
          {:else}
            {#if message.content && !isOnlyTheLink(message)}
              <div class="content">
                {#each blocks as block, blockIndex (blockIndex)}
                  {#if block.type === 'code'}
                    <pre class="code-block"><code>{block.text}</code></pre>
                  {:else if block.type === 'quote'}
                    <blockquote class="quote">{@render inlineSegments(block.segments)}</blockquote>
                  {:else if block.type === 'header'}
                    <p class="md-header" class:md-h1={block.level === 1} class:md-h2={block.level === 2}>
                      {@render inlineSegments(block.segments)}
                    </p>
                  {:else}
                    <p class="paragraph">{@render inlineSegments(block.segments)}</p>
                  {/if}
                {/each}
              </div>
            {/if}

            {#if message.stickers.length > 0}
              <div class="stickers">
                {#each message.stickers as sticker (sticker.id)}
                  <a
                    class="sticker"
                    href={`/api/v1/stickers/${sticker.id}`}
                    target="_blank"
                    rel="noreferrer noopener"
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

            {#if message.embed}
              {#if message.embed.player}
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
              <button type="button" title="Delete" onclick={() => (confirmingDeleteId = message.id)}>Delete</button>
            {/if}
          {/if}
        </div>
      </article>
    {/each}
  {/if}

  <!--
    After a jump to a search or inbox result the list can be an older stretch of
    history with newer messages held back, so the way back is always in reach.
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
    background: var(--h-bg-deep);
    border: 1px solid var(--h-border);
    color: var(--h-text-muted);
    font-size: 0.85rem;
  }

  .present-bar button {
    flex-shrink: 0;
  }
</style>
