<script lang="ts">
  import { permissionsFromString, type Category, type Channel, type VoiceState } from '@harmony/shared';
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
  import VoiceMemberMenu from './VoiceMemberMenu.svelte';
  import { voice } from '../lib/voice.svelte';
  import { hostVoice } from '../lib/host-voice.svelte';
  import { members } from '../lib/members.svelte';
  import { askHostToJoin, askHostToLeave, voiceHost, webVoiceDisabled } from '../lib/voice-mode';

  const permissions = $derived(permissionsFromString(session.permissions || '0'));
  // The button appears for anyone who could use at least one tab, moderators
  // included; the panel itself hides the tabs they cannot reach.
  const canAdmin = $derived(canOpenAdminPanel(permissions));
  const myPicture = $derived(avatarUrl(session.user));
  const myId = $derived(session.user?.id ?? null);
  /** The host app runs voice natively; the sidebar keeps the rosters but cannot join. */
  const voiceOff = webVoiceDisabled();
  /** The shell's native-voice bridge, when it injected one. */
  const host = voiceHost();

  /** What a voice channel's tap does, for the tooltip. */
  function voiceTitle(channel: Channel): string {
    if (hostVoice.channelId === channel.id) return `Leave ${channel.name}`;
    if (voice.channelId === channel.id) return `Disconnect from ${channel.name}`;
    if (voiceOff && !host) return 'Voice is handled by the app';
    return `Join ${channel.name}`;
  }

  /** What the native call's connected indicator says, for the tooltip. */
  function hostStatusLabel(channel: Channel): string {
    if (hostVoice.self.deafened) return `Deafened — connected to ${channel.name}`;
    if (hostVoice.self.muted) return `Muted — connected to ${channel.name}`;
    return `Connected to ${channel.name}`;
  }

  /**
   * The letter to draw for a host-call member the directory does not know. The
   * shell only sends an id and a name, so there is no avatar to point at; the
   * name's initial matches the fallback the rest of the sidebar uses.
   */
  function hostInitial(name: string): string {
    return name.charAt(0).toUpperCase() || '?';
  }

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

  /**
   * Picking a channel closes the drawer on narrow screens. Picking the one
   * already open, which is the natural way to put the drawer away on a phone,
   * must not reload it: that would drop the reply being written and the
   * reader's place. It only comes back to the present from an older stretch.
   */
  function selectChannel(id: string): void {
    if (id !== chat.activeChannelId) void chat.selectChannel(id);
    else if (chat.detached) void chat.jumpToPresent();
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
    target:
      | { kind: 'channel'; channel: Channel }
      | { kind: 'category'; category: Category }
      | { kind: 'voice-member'; entry: VoiceState };
    x: number;
    y: number;
  } | null>(null);

  function openChannelMenu(channel: Channel, x: number, y: number): void {
    menu = { target: { kind: 'channel', channel }, x, y };
  }

  function openCategoryMenu(category: Category, x: number, y: number): void {
    menu = { target: { kind: 'category', category }, x, y };
  }

  /**
   * The control that opened the menu, when one did, so focus can return to it
   * when the menu closes. A bare pointer gesture (right-click, long-press)
   * leaves it null: there is nothing to hand focus back to.
   */
  let menuTrigger: HTMLElement | null = null;

  /** A voice member's own menu: their playback volume, local to this client. */
  function openVoiceMemberMenu(entry: VoiceState, x: number, y: number, trigger: HTMLElement | null = null): void {
    menuTrigger = trigger;
    menu = { target: { kind: 'voice-member', entry }, x, y };
  }

  /** Close the open menu, returning focus to the control that opened it. */
  function closeMenu(): void {
    const trigger = menuTrigger;
    menu = null;
    menuTrigger = null;
    if (trigger?.isConnected) trigger.focus();
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
  {@const hostConnected = hostVoice.channelId === channel.id}
  {@const connected = hostConnected || voice.channelId === channel.id}
  {#if channel.type === 'voice'}
    <div class="channel-item" class:active={connected}>
      <button
        class="channel"
        class:active={connected}
        class:connecting={voice.joining === channel.id}
        type="button"
        disabled={voiceOff && !host}
        title={voiceTitle(channel)}
        onclick={() => {
          // The shell owns a native call, so the row's own tap ends it through
          // the same bridge that started it.
          if (hostConnected) {
            askHostToLeave();
            return;
          }
          // With voice off and a host present, the tap starts the native call
          // rather than the web client's own, which the host has taken over.
          if (voiceOff && askHostToJoin(channel.id, channel.name)) return;
          if (voice.channelId === channel.id) void voice.leave();
          else void voice.join(channel.id);
        }}
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
          {#if voice.joining === channel.id}
            <span class="voice-joining" title="Connecting…" aria-label="Connecting"></span>
          {:else if hostConnected}
            <!--
              The native call has no web voice bar underneath, so its row carries
              the state itself: a steady dot while connected, the muted mark when
              the shell says this member is muted or deafened.
            -->
            <span
              class="voice-live"
              class:muted={hostVoice.self.muted || hostVoice.self.deafened}
              role="img"
              title={hostStatusLabel(channel)}
              aria-label={hostStatusLabel(channel)}
            >
              {#if hostVoice.self.deafened}
                <Icon name="headphones" size={13} />
              {:else if hostVoice.self.muted}
                <Icon name="mic-off" size={13} />
              {:else}
                <span class="voice-live-dot"></span>
              {/if}
            </span>
          {:else if isLocked(channel)}
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
    {#if hostConnected}
      <!-- The host is the only party with a roster for its native call. -->
      {#each hostVoice.members as member (member.id)}
        {@const user = members.byId.get(member.id) ?? null}
        <div class="voice-member" class:speaking={member.speaking}>
          {#if avatarUrl(user)}
            <img class="avatar small" src={avatarUrl(user)} alt="" />
          {:else if user}
            <span class="avatar small fallback">{initial(user)}</span>
          {:else}
            <span class="avatar small fallback">{hostInitial(member.name)}</span>
          {/if}
          <span class="voice-member-name">{member.name}</span>
          <span class="voice-member-tail">
            {#if member.sharing}
              <span class="voice-member-sharing" title="Sharing their screen"><Icon name="screen" size={12} /></span>
            {/if}
            {#if member.muted}
              <span class="voice-member-muted"><Icon name="mic-off" size={12} /></span>
            {/if}
          </span>
        </div>
      {/each}
    {:else}
      {#each voice.rosters[channel.id] ?? [] as entry (entry.user.id)}
        <!-- A row whose one interaction is the volume menu: right-click or
             long-press on the row itself, or the focusable "…" that mirrors the
             channel row and gives the keyboard and assistive tech a way in. -->
        <div class="voice-member-item">
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="voice-member"
            class:speaking={voice.speaking[entry.user.id]}
            oncontextmenu={(event) => {
              event.preventDefault();
              cancelPress();
              openVoiceMemberMenu(entry, event.clientX, event.clientY);
            }}
            onpointerdown={(event) => startPress(event, (x, y) => openVoiceMemberMenu(entry, x, y))}
            onpointerup={cancelPress}
            onpointercancel={cancelPress}
            onpointerleave={cancelPress}
          >
            {#if avatarUrl(entry.user)}
              <img class="avatar small" src={avatarUrl(entry.user)} alt="" />
            {:else}
              <span class="avatar small fallback">{initial(entry.user)}</span>
            {/if}
            <span class="voice-member-name">{entry.user.displayName ?? entry.user.username}</span>
            <span class="voice-member-tail">
              {#if entry.sharing}
                <span class="voice-member-sharing" title="Sharing their screen"><Icon name="screen" size={12} /></span>
              {/if}
              {#if entry.muted}
                <span class="voice-member-muted"><Icon name="mic-off" size={12} /></span>
              {/if}
            </span>
          </div>
          <button
            class="channel-more"
            type="button"
            aria-label={`Volume options for ${entry.user.displayName ?? entry.user.username}`}
            title="Volume options"
            onclick={(event) => openVoiceMemberMenu(entry, ...fromButton(event), event.currentTarget)}
          >
            <Icon name="more" size={16} />
          </button>
        </div>
      {/each}
    {/if}
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
    {@const sharer = voice.screenSharerName}
    <div class="voice-bar">
      <div class="voice-bar-main">
        <div class="voice-bar-info">
          <span class="voice-bar-title">{voiceName}</span>
          <span class="voice-bar-status">
            {#if voice.connecting}Connecting…
            {:else if voice.connectionState === 'failed'}Connection failed
            {:else if voice.connectionState === 'disconnected'}Reconnecting…
            {:else}Voice connected{/if}
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
          class="voice-bar-button"
          class:sharing={voice.sharing}
          aria-disabled={!voice.sharing && sharer !== null}
          title={voice.sharing
            ? 'Stop sharing'
            : sharer
              ? `${sharer} is already sharing their screen`
              : 'Share screen'}
          aria-label={voice.sharing
            ? 'Stop sharing your screen'
            : sharer
              ? `${sharer} is already sharing their screen in this channel. Sharing is unavailable until they stop.`
              : 'Share your screen'}
          onclick={() => (voice.sharing ? voice.stopScreen() : voice.shareScreen())}
        >
          <Icon name="screen" size={18} />
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
      {#if voice.sharing || sharer || (!voice.connecting && voice.connectionState !== 'failed')}
        <!--
          The connection indicators share one full-width line under the title:
          the live-audio readout and the screen-share note. The note belongs
          here because a shared screen is a connection like the microphone and
          the incoming audio, and because the ~79px info column at the 250px
          sidebar was too narrow for even a short name beside the word screen.
          The complete sentence still lives on the share button's aria-label and
          in the error the share guard raises, both reachable.
        -->
        <div class="voice-bar-connections">
          {#if !voice.connecting && voice.connectionState !== 'failed'}
            <span class="voice-signal" title="Live audio: microphone sending, incoming audio">
              <span class="voice-signal-icon" class:on={voice.sending}>
                <Icon name={voice.muted ? 'mic-off' : 'mic'} size={12} />
              </span>
              <span class="voice-signal-icon" class:on={voice.receiving}>
                <Icon name="volume" size={12} />
              </span>
            </span>
          {/if}
          {#if voice.sharing}
            <span class="voice-bar-sharing">
              <Icon name="screen" size={12} />
              <span class="voice-bar-sharing-text">Sharing your screen</span>
            </span>
          {:else if sharer}
            <span class="voice-bar-sharing other">
              <Icon name="screen" size={12} />
              <span class="voice-bar-sharing-name">{sharer}</span><span class="voice-bar-sharing-suffix">’s screen</span>
            </span>
          {/if}
        </div>
      {/if}
    </div>
  {:else if voice.error}
    <!--
      A join that failed before it ever reached a channel has no connected bar
      to report itself in, and a tap that silently does nothing is the one
      outcome nobody can act on. Stand the error on its own until it is read.
    -->
    <div class="voice-bar error" role="alert">
      <div class="voice-bar-main">
        <div class="voice-bar-info">
          <span class="voice-bar-error">{voice.error}</span>
        </div>
        <button
          type="button"
          class="voice-bar-button"
          title="Dismiss"
          aria-label="Dismiss voice error"
          onclick={() => voice.clearError()}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
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
  {#if menu.target.kind === 'voice-member'}
    <VoiceMemberMenu entry={menu.target.entry} x={menu.x} y={menu.y} onclose={closeMenu} />
  {:else}
    <ChannelMenu target={menu.target} x={menu.x} y={menu.y} onclose={() => (menu = null)} />
  {/if}
{/if}
