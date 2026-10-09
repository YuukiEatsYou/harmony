<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    MUTE_DURATIONS,
    isMuteActive,
    NOTIFICATION_LEVEL_LABELS,
    NOTIFICATION_LEVELS,
    type Category,
    type Channel,
    type NotificationLevel,
    type UpdateChannelSettingsInput,
  } from '@harmony/shared';
  import { ApiError } from '../lib/api';
  import { channelSettings } from '../lib/channel-settings.svelte';
  import { chat } from '../lib/chat.svelte';
  import { muteLabel } from '../lib/unread';
  import { ui } from '../lib/ui.svelte';

  /**
   * The menu a channel or category opens on right-click, long-press or its "…"
   * button: mark it read, mute it for a while, and choose what it notifies
   * about, the same choices Discord offers in the same places.
   */
  let {
    target,
    x,
    y,
    onclose,
  }: {
    target: { kind: 'channel'; channel: Channel } | { kind: 'category'; category: Category };
    x: number;
    y: number;
    onclose: () => void;
  } = $props();

  let menu = $state<HTMLDivElement | null>(null);
  /** Which flyout is open, if any. */
  let open = $state<'mute' | 'notify' | null>(null);
  let error = $state<string | null>(null);
  /** Where the menu actually sits once it has been kept inside the window. */
  let left = $state(0);
  let top = $state(0);
  /** Whether the flyouts open to the left, for a menu near the right edge. */
  let flip = $state(false);

  const targetId = $derived(target.kind === 'channel' ? target.channel.id : target.category.id);
  const noun = $derived(target.kind === 'channel' ? 'channel' : 'category');
  /** The channels the target covers: itself, or everything in the category. */
  const channelIds = $derived(
    target.kind === 'channel' ? [target.channel.id] : chat.channelsIn(target.category.id).map((channel) => channel.id),
  );
  const hasUnread = $derived(channelIds.some((id) => chat.unread.has(id) || chat.mention.has(id)));

  /** The target's own stored settings, before anything is inherited. */
  const own = $derived(channelSettings.byTarget[targetId]);
  const ownMuted = $derived(isMuteActive(own, channelSettings.now));
  const resolved = $derived(
    target.kind === 'channel' ? channelSettings.resolve(target.channel) : channelSettings.resolveCategory(targetId),
  );
  const level = $derived<NotificationLevel>(own?.level ?? 'default');
  /** What "default" defers to here: the category for a channel in one, the server otherwise. */
  const defaultLabel = $derived(
    target.kind === 'channel' && target.channel.categoryId !== null
      ? NOTIFICATION_LEVEL_LABELS.default
      : 'Use server default',
  );

  function levelLabel(choice: NotificationLevel): string {
    return choice === 'default' ? defaultLabel : NOTIFICATION_LEVEL_LABELS[choice];
  }

  async function save(input: UpdateChannelSettingsInput): Promise<void> {
    error = null;
    try {
      await channelSettings.update(targetId, input);
      onclose();
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : 'That did not work. Try again.';
    }
  }

  function markRead(): void {
    chat.markChannelsRead(channelIds);
    onclose();
  }

  /** Opens this channel's media gallery, whether or not it is the one on screen. */
  function openMedia(): void {
    if (target.kind !== 'channel') return;
    ui.openGallery(target.channel);
    onclose();
  }

  /** Every item in the menu and its open flyout, in order, for the arrow keys. */
  function items(): HTMLElement[] {
    return menu ? [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')] : [];
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (open) open = null;
      else onclose();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    list[(index + step + list.length) % list.length]?.focus();
  }

  /**
   * Opens a flyout and moves focus into it, for keyboard and touch alike. It only
   * ever opens: with a mouse, hovering has already opened it by the time the
   * click lands, and a toggle would shut it again under the pointer.
   */
  async function openFlyout(which: 'mute' | 'notify'): Promise<void> {
    open = which;
    await tick();
    if (open) menu?.querySelector<HTMLElement>(`.flyout[data-for="${open}"] [role^="menuitem"]`)?.focus();
  }

  onMount(() => {
    // Keep the whole menu, flyouts included, on screen however near an edge the
    // click was.
    const width = menu?.offsetWidth ?? 220;
    const height = menu?.offsetHeight ?? 200;
    left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
    flip = left + width * 2 + 16 > window.innerWidth;
    items()[0]?.focus();

    const onPointerDown = (event: PointerEvent): void => {
      if (!menu?.contains(event.target as Node)) onclose();
    };
    // Captured, so a press on anything else closes the menu before it acts. A
    // resize is deliberately left alone: a phone fires one whenever its toolbar
    // slides away, which would shut the menu under the member's thumb.
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });
</script>

<div
  class="channel-menu"
  class:flip
  role="menu"
  tabindex="-1"
  aria-label={target.kind === 'channel' ? `#${target.channel.name}` : target.category.name}
  bind:this={menu}
  style:left="{left}px"
  style:top="{top}px"
  onkeydown={onKeydown}
  oncontextmenu={(event) => event.preventDefault()}
>
  <button
    type="button"
    role="menuitem"
    disabled={!hasUnread}
    onclick={markRead}
    onpointerenter={(event) => event.pointerType === 'mouse' && (open = null)}>Mark as read</button
  >

  {#if target.kind === 'channel' && target.channel.type === 'text'}
    <button type="button" role="menuitem" onclick={openMedia}>Media</button>
  {/if}

  <div class="separator" role="separator"></div>

  {#if ownMuted}
    <button type="button" role="menuitem" class="two-line" onclick={() => save({ muted: false })}>
      <span>Unmute {noun}</span>
      <span class="hint">{muteLabel(own?.muteEndsAt ?? null, channelSettings.now)}</span>
    </button>
  {:else}
    <div class="has-flyout" role="none" onpointerenter={(event) => event.pointerType === 'mouse' && (open = 'mute')}>
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open === 'mute'}
        class:two-line={resolved.mutedByCategory}
        onclick={() => openFlyout('mute')}
      >
        <span>Mute {noun}</span>
        {#if resolved.mutedByCategory}
          <span class="hint">Muted with its category</span>
        {/if}
        <span class="arrow" aria-hidden="true">›</span>
      </button>
      {#if open === 'mute'}
        <div class="flyout" data-for="mute" role="menu" aria-label={`Mute ${noun}`}>
          {#each MUTE_DURATIONS as duration (duration.label)}
            <button type="button" role="menuitem" onclick={() => save({ muted: true, muteSeconds: duration.seconds })}>
              {duration.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <div class="has-flyout" role="none" onpointerenter={(event) => event.pointerType === 'mouse' && (open = 'notify')}>
    <button
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={open === 'notify'}
      class="two-line"
      onclick={() => openFlyout('notify')}
    >
      <span>Notification settings</span>
      <span class="hint">{levelLabel(level)}</span>
      <span class="arrow" aria-hidden="true">›</span>
    </button>
    {#if open === 'notify'}
      <div class="flyout" data-for="notify" role="menu" aria-label="Notification settings">
        {#each NOTIFICATION_LEVELS as choice (choice)}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={level === choice}
            onclick={() => save({ level: choice })}
          >
            <span class="radio" class:on={level === choice} aria-hidden="true"></span>
            {levelLabel(choice)}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  {#if error}
    <p class="menu-error" role="alert">{error}</p>
  {/if}
</div>

<style>
  .channel-menu {
    position: fixed;
    z-index: 200;
    width: 220px;
    padding: 0.35rem;
    border-radius: var(--h-radius);
    background: var(--h-bg-elevated);
    border: 1px solid var(--h-border);
    box-shadow: var(--h-shadow-lg);
    font-size: 0.85rem;
  }

  .channel-menu:focus {
    outline: none;
  }

  button {
    display: flex;
    position: relative;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.45rem 0.6rem;
    border-radius: var(--h-radius-xs);
    background: none;
    color: var(--h-text-muted);
    font-size: 0.85rem;
    font-weight: 500;
    text-align: left;
  }

  button:hover:not(:disabled),
  button:focus-visible,
  button[aria-expanded='true'] {
    background: var(--h-accent);
    color: var(--h-on-accent);
    box-shadow: none;
    outline: none;
  }

  button:active:not(:disabled) {
    transform: none;
  }

  button.two-line {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    padding-right: 1.6rem;
  }

  .hint {
    font-size: 0.75rem;
    opacity: 0.75;
  }

  .arrow {
    position: absolute;
    top: 50%;
    right: 0.6rem;
    font-size: 1.1rem;
    line-height: 1;
    transform: translateY(-50%);
  }

  .separator {
    height: 1px;
    margin: 0.3rem 0.4rem;
    background: var(--h-border);
  }

  .has-flyout {
    position: relative;
  }

  .flyout {
    position: absolute;
    top: -0.35rem;
    left: calc(100% + 0.35rem);
    width: 210px;
    padding: 0.35rem;
    border-radius: var(--h-radius);
    background: var(--h-bg-elevated);
    border: 1px solid var(--h-border);
    box-shadow: var(--h-shadow-lg);
  }

  .flip .flyout {
    left: auto;
    right: calc(100% + 0.35rem);
  }

  .radio {
    flex: none;
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-radius: var(--h-radius-full);
  }

  .radio.on {
    background: radial-gradient(circle, currentColor 0 3px, transparent 3.5px);
  }

  .menu-error {
    margin: 0.35rem 0.4rem 0.15rem;
    color: var(--h-error);
    font-size: 0.78rem;
  }

  /* A phone has no room beside the menu, so a flyout opens in place beneath its item. */
  @media (max-width: 520px) {
    .channel-menu {
      max-height: calc(100vh - 16px);
      overflow-y: auto;
    }

    .flyout,
    .flip .flyout {
      position: static;
      width: auto;
      margin: 0.2rem 0 0.2rem 0.6rem;
      box-shadow: none;
    }
  }
</style>
