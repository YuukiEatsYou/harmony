<script lang="ts">
  import { permissionsFromString, type Category, type Channel } from '@harmony/shared';
  import { api } from '../lib/api';
  import { avatarUrl, initial } from '../lib/avatar';
  import { channelSettings } from '../lib/channel-settings.svelte';
  import { chat } from '../lib/chat.svelte';
  import { meta } from '../lib/meta.svelte';
  import { session } from '../lib/session.svelte';
  import { ui } from '../lib/ui.svelte';
  import { canOpenAdminPanel } from '../lib/admin';
  import { nameColorGlow, nameColorStyle } from '../lib/format';
  import { muteLabel, pillCount } from '../lib/unread';
  import ChannelMenu from './ChannelMenu.svelte';
  import Icon from './Icon.svelte';
  import { voice } from '../lib/voice.svelte';

  const permissions = $derived(permissionsFromString(session.permissions || '0'));
  // The button appears for anyone who could use at least one tab, moderators
  // included; the panel itself hides the tabs they cannot reach.
  const canAdmin = $derived(canOpenAdminPanel(permissions));
  const myPicture = $derived(avatarUrl(session.user));
  const myId = $derived(session.user?.id ?? null);

  /** Categories that demand a role; every channel inside one is locked too. */
  const lockedCategories = $derived(
    new Set(chat.categories.filter((category) => category.requiredRoleId !== null).map((category) => category.id)),
  );

  function isLocked(channel: Channel): boolean {
    return (
      channel.requiredRoleId !== null ||
      (channel.categoryId !== null && lockedCategories.has(channel.categoryId))
    );
  }

  async function logout(): Promise<void> {
    await api('/auth/logout', { method: 'POST' });
    session.user = null;
    session.permissions = '0';
  }

  /** Picking a channel closes the drawer on narrow screens. */
  function selectChannel(id: string): void {
    chat.selectChannel(id);
    ui.closeDrawers();
  }

  /*
   * Collapsed categories, remembered per browser. It is only a matter of how
   * this one viewer likes their sidebar, so it never goes near the server, and
   * storage that refuses (a private window, blocked site data) just means the
   * sidebar starts expanded.
   */
  const collapsedKey = 'harmony.collapsedCategories';
  let collapsed = $state<Set<string>>(readCollapsed());

  function readCollapsed(): Set<string> {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(collapsedKey) ?? '[]');
      return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
    } catch {
      return new Set();
    }
  }

  function toggleCategory(id: string): void {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
    try {
      localStorage.setItem(collapsedKey, JSON.stringify([...next]));
    } catch {
      // Remembered for this visit only.
    }
  }

  /**
   * What a category shows of itself. A collapsed one still lists the open
   * channel and anything unread in it, as Discord's does, so news is never
   * folded away out of sight; whatever is folded away still adds its mentions
   * to the number on the category itself.
   */
  function categoryView(category: Category): { channels: Channel[]; hiddenMentions: number } {
    const channels = chat.channelsIn(category.id);
    if (!collapsed.has(category.id)) return { channels, hiddenMentions: 0 };
    const shown: Channel[] = [];
    let hiddenMentions = 0;
    for (const channel of channels) {
      if (channel.id === chat.activeChannelId || chat.unreadShown(channel)) shown.push(channel);
      else hiddenMentions += chat.mentionsShown(channel);
    }
    return { channels: shown, hiddenMentions };
  }

  /** The open context menu, and where it was asked for. */
  let menu = $state<{
    target: { kind: 'channel'; channel: Channel } | { kind: 'category'; category: Category };
    x: number;
    y: number;
  } | null>(null);

  function openChannelMenu(channel: Channel, x: number, y: number): void {
    menu = { target: { kind: 'channel', channel }, x, y };
  }

  function openCategoryMenu(category: Category, x: number, y: number): void {
    menu = { target: { kind: 'category', category }, x, y };
  }

  /** The "…" button opens the menu just below itself. */
  function fromButton(event: MouseEvent): [number, number] {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return [rect.left, rect.bottom + 4];
  }

  /*
   * A long press opens the menu on touch screens. Android reports one as a
   * context menu event anyway, which the handler above already takes; this is
   * for the browsers that do not (iOS Safari), and the click that ends a long
   * press is swallowed so it does not also open the channel.
   */
  const longPressMs = 500;
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressedLong = false;

  function startPress(event: PointerEvent, open: (x: number, y: number) => void): void {
    pressedLong = false;
    if (event.pointerType !== 'touch') return;
    const { clientX, clientY } = event;
    cancelPress();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      pressedLong = true;
      if (!menu) open(clientX, clientY);
    }, longPressMs);
  }

  function cancelPress(): void {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  }

  /** Whether a click is the tail end of a long press, and so should do nothing. */
  function swallowLongPress(event: MouseEvent): boolean {
    if (!pressedLong) return false;
    pressedLong = false;
    event.preventDefault();
    return true;
  }
</script>

{#snippet channelRow(channel: Channel)}
  {@const settings = channelSettings.resolve(channel)}
  {@const mentions = chat.mentionsShown(channel)}
  {#if channel.type === 'voice'}
    <div class="channel-item" class:active={voice.channelId === channel.id}>
      <button
        class="channel"
        class:active={voice.channelId === channel.id}
        type="button"
        title={voice.channelId === channel.id ? `Disconnect from ${channel.name}` : `Join ${channel.name}`}
        onclick={() => (voice.channelId === channel.id ? voice.leave() : voice.join(channel.id))}
        oncontextmenu={(event) => {
          event.preventDefault();
          cancelPress();
          openChannelMenu(channel, event.clientX, event.clientY);
        }}
        onpointerdown={(event) => startPress(event, (x, y) => openChannelMenu(channel, x, y))}
        onpointerup={cancelPress}
        onpointercancel={cancelPress}
        onpointerleave={cancelPress}
      >
        <span class="hash"><Icon name="volume" size={16} /></span><span class="channel-label">{channel.name}</span>
        <span class="tail">
          {#if isLocked(channel)}
            <span class="lock" title="Only members with a certain role can see this">
              <Icon name="lock" size={13} />
            </span>
          {/if}
        </span>
      </button>
      <button
        class="channel-more"
        type="button"
        aria-label={`Options for ${channel.name}`}
        title="More options"
        onclick={(event) => openChannelMenu(channel, ...fromButton(event))}
      >
        <Icon name="more" size={16} />
      </button>
    </div>
    {#each voice.rosters[channel.id] ?? [] as entry (entry.user.id)}
      <div class="voice-member" class:speaking={voice.speaking[entry.user.id]}>
        {#if avatarUrl(entry.user)}
          <img class="avatar small" src={avatarUrl(entry.user)} alt="" />
        {:else}
          <span class="avatar small fallback">{initial(entry.user)}</span>
        {/if}
        <span class="voice-member-name">{entry.user.displayName ?? entry.user.username}</span>
        {#if entry.muted}<span class="voice-member-muted"><Icon name="mic-off" size={12} /></span>{/if}
      </div>
    {/each}
  {:else}
    <div class="channel-item" class:active={channel.id === chat.activeChannelId}>
      <button
        class="channel"
        class:active={channel.id === chat.activeChannelId}
        class:unread={chat.unreadShown(channel)}
        class:muted={settings.muted}
        type="button"
        title={settings.muted ? muteLabel(settings.muteEndsAt, channelSettings.now) : undefined}
        onclick={(event) => swallowLongPress(event) || selectChannel(channel.id)}
        oncontextmenu={(event) => {
          event.preventDefault();
          cancelPress();
          openChannelMenu(channel, event.clientX, event.clientY);
        }}
        onpointerdown={(event) => startPress(event, (x, y) => openChannelMenu(channel, x, y))}
        onpointerup={cancelPress}
        onpointercancel={cancelPress}
        onpointerleave={cancelPress}
      >
        <span class="hash">
          {#if channel.discordChannelId}<Icon name="link" size={15} />{:else}#{/if}
        </span><span class="channel-label">{channel.name}</span>
        <span class="tail">
          {#if mentions > 0}
            <span class="mention-pill" title={mentions === 1 ? '1 unread mention' : `${mentions} unread mentions`}>
              {pillCount(mentions)}
            </span>
          {/if}
          {#if isLocked(channel)}
            <span class="lock" title="Only members with a certain role can see this">
              <Icon name="lock" size={13} />
            </span>
          {/if}
        </span>
      </button>
      <button
        class="channel-more"
        type="button"
        aria-label={`Options for #${channel.name}`}
        title="More options"
        onclick={(event) => openChannelMenu(channel, ...fromButton(event))}
      >
        <Icon name="more" size={16} />
      </button>
    </div>
  {/if}
{/snippet}

<aside class="sidebar" class:open={ui.sidebarOpen}>
  <button class="server-name" type="button" title="About this instance" onclick={() => ui.openAbout()}>
    <img class="server-icon" src={meta.iconUrl} alt="" />
    <span class="server-name-text">{meta.serverName}</span>
  </button>

  <nav class="channels">
    {#each chat.categories as category (category.id)}
      {@const view = categoryView(category)}
      {@const categoryMute = channelSettings.resolveCategory(category.id)}
      <div class="category" class:collapsed={collapsed.has(category.id)}>
        <div class="category-header" class:muted={categoryMute.muted}>
          <button
            class="category-name"
            type="button"
            aria-expanded={!collapsed.has(category.id)}
            title={categoryMute.muted ? muteLabel(categoryMute.muteEndsAt, channelSettings.now) : undefined}
            onclick={(event) => swallowLongPress(event) || toggleCategory(category.id)}
            oncontextmenu={(event) => {
              event.preventDefault();
              cancelPress();
              openCategoryMenu(category, event.clientX, event.clientY);
            }}
            onpointerdown={(event) => startPress(event, (x, y) => openCategoryMenu(category, x, y))}
            onpointerup={cancelPress}
            onpointercancel={cancelPress}
            onpointerleave={cancelPress}
          >
            <span class="chevron"><Icon name="chevron-down" size={12} /></span>
            <span class="category-label">{category.name}</span>
            {#if view.hiddenMentions > 0}
              <span class="mention-pill">{pillCount(view.hiddenMentions)}</span>
            {/if}
          </button>
          <button
            class="channel-more"
            type="button"
            aria-label={`Options for ${category.name}`}
            title="More options"
            onclick={(event) => openCategoryMenu(category, ...fromButton(event))}
          >
            <Icon name="more" size={16} />
          </button>
        </div>
        {#each view.channels as channel (channel.id)}
          {@render channelRow(channel)}
        {/each}
      </div>
    {/each}

    {#each chat.channelsIn(null) as channel (channel.id)}
      {@render channelRow(channel)}
    {/each}
  </nav>

  {#if voice.channelId}
    {@const voiceName = chat.channels.find((entry) => entry.id === voice.channelId)?.name ?? 'Voice'}
    <div class="voice-bar">
      <div class="voice-bar-info">
        <span class="voice-bar-title">{voiceName}</span>
        <span class="voice-bar-status">
          {#if voice.connecting}Connecting…{:else}Voice connected{/if}
        </span>
        {#if voice.error}<span class="voice-bar-error">{voice.error}</span>{/if}
      </div>
      <button
        type="button"
        class="voice-bar-button"
        class:on={voice.muted}
        class:speaking={myId !== null && voice.speaking[myId] === true}
        title={voice.muted ? 'Unmute' : 'Mute'}
        aria-label={voice.muted ? 'Unmute' : 'Mute'}
        onclick={() => voice.setMuted(!voice.muted)}
      >
        <Icon name={voice.muted ? 'mic-off' : 'mic'} size={18} />
      </button>
      <button
        type="button"
        class="voice-bar-button"
        class:on={voice.deafened}
        title={voice.deafened ? 'Undeafen' : 'Deafen'}
        aria-label={voice.deafened ? 'Undeafen' : 'Deafen'}
        onclick={() => voice.setDeafened(!voice.deafened)}
      >
        <Icon name="headphones" size={18} />
      </button>
      <button
        type="button"
        class="voice-bar-button danger"
        title="Disconnect"
        aria-label="Disconnect from voice"
        onclick={() => voice.leave()}
      >
        <Icon name="phone-off" size={18} />
      </button>
    </div>
  {/if}

  <footer class="user-bar">
    <button class="user-button" type="button" title="Edit your profile" onclick={() => ui.openProfile()}>
      {#if myPicture}
        <img class="avatar small" src={myPicture} alt="" />
      {:else}
        <span class="avatar small fallback">{initial(session.user)}</span>
      {/if}
      <span class="username" class:name-glow={nameColorGlow(session.user)} style={nameColorStyle(session.user)}>
        {session.user?.displayName ?? session.user?.username}
      </span>
    </button>

    <div class="user-actions">
      {#if canAdmin}
        <button class="link" type="button" onclick={() => ui.openAdmin()}>Admin</button>
      {/if}
      <button class="link" type="button" onclick={logout}>Log out</button>
    </div>
  </footer>
</aside>

<!--
  Outside the sidebar on purpose: on a phone the sidebar is a sliding drawer,
  and its transform would otherwise become what the menu is positioned against.
-->
{#if menu}
  <ChannelMenu target={menu.target} x={menu.x} y={menu.y} onclose={() => (menu = null)} />
{/if}
