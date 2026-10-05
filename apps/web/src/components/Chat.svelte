<script lang="ts">
  import { onMount } from 'svelte';
  import type { Message } from '@harmony/shared';
  import { chat } from '../lib/chat.svelte';
  import { dragHasFiles, mediaFilesFrom } from '../lib/files';
  import { events } from '../lib/events.svelte';
  import { saved } from '../lib/saved.svelte';
  import { scheduled } from '../lib/scheduled.svelte';
  import { session } from '../lib/session.svelte';
  import { ui } from '../lib/ui.svelte';
  import { update } from '../lib/update.svelte';
  import { uploads } from '../lib/upload-queue.svelte';
  import ChannelSidebar from './ChannelSidebar.svelte';
  import Composer from './Composer.svelte';
  import EventsPanel from './EventsPanel.svelte';
  import HeaderActions from './HeaderActions.svelte';
  import Icon from './Icon.svelte';
  import KeyboardShortcuts from './KeyboardShortcuts.svelte';
  import MemberList from './MemberList.svelte';
  import MessageView from './MessageView.svelte';
  import PinsPanel from './PinsPanel.svelte';
  import SavedPanel from './SavedPanel.svelte';
  import ScheduledPanel from './ScheduledPanel.svelte';
  import UnreadBadge from './UnreadBadge.svelte';

  onMount(() => {
    void chat.start();
    // Reminders have to come due whether or not the saved panel is open.
    saved.start();
    // Scheduled messages are sent by the server; this only mirrors the queue.
    scheduled.start();
    // Events are mirrored the same way; the server starts, ends and reminds.
    events.start();
    // The owner's update check: the server runs it, this only shows the notice.
    update.start();

    // A phone that backgrounds the app gets no events at all: the socket dies and
    // nothing scrolls past. Coming back to the foreground is the cue to reconnect
    // and catch up, which is what makes a reopened installed app show the newest
    // messages instead of whatever was on screen when it went away.
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void chat.resync();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      saved.stop();
      scheduled.stop();
      events.stop();
      update.stop();
      chat.stop();
    };
  });

  /** The "is typing…" line above the composer, or null when nobody is typing. */
  const typingLabel = $derived.by((): string | null => {
    if (!session.user?.showTyping) return null;
    const names = chat.typingUsers.map((entry) => entry.user.displayName ?? entry.user.username);
    if (names.length === 0) return null;
    if (names.length === 1) return `${names[0]} is typing…`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
    return 'Several people are typing…';
  });

  /** The author shown in the notice, matching the one HeaderActions draws beside a channel. */
  function reminderAuthor(message: Message): string {
    return message.author?.displayName ?? message.author?.username ?? 'Deleted user';
  }

  /** A line of the message for the notice; the panel is where it is read in full. */
  function reminderSnippet(message: Message): string {
    const text = message.content.replace(/\s+/g, ' ').trim();
    if (text.length === 0) return message.attachments.length > 0 ? '(attachment)' : '';
    return text.length > 90 ? `${text.slice(0, 90)}…` : text;
  }

  function openSavedNotice(): void {
    saved.notice = null;
    ui.openSaved();
  }

  /** Opens the admin panel straight on the Update tab. */
  function openUpdate(): void {
    ui.openAdmin('update');
  }

  /**
   * Dragging a file over the chat offers a drop zone. Enter and leave fire for
   * every element the pointer crosses, so they are counted rather than toggled.
   */
  let dragDepth = $state(0);
  const dragging = $derived(dragDepth > 0);

  function onDragEnter(event: DragEvent): void {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
  }

  function onDragOver(event: DragEvent): void {
    if (!dragHasFiles(event)) return;
    // Without this the browser refuses the drop entirely.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(event: DragEvent): void {
    if (!dragHasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
  }

  function onDrop(event: DragEvent): void {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    // The composer owns uploading; it picks these up from the queue.
    uploads.drop(mediaFilesFrom(event.dataTransfer));
  }
</script>

<div class="layout">
  <ChannelSidebar />

  {#if chat.activeChannel}
    <section
      class="chat"
      aria-label={`#${chat.activeChannel.name}`}
      ondragenter={onDragEnter}
      ondragover={onDragOver}
      ondragleave={onDragLeave}
      ondrop={onDrop}
    >
      <header class="chat-header">
        <button
          class="drawer-toggle"
          type="button"
          aria-label="Show channels"
          aria-expanded={ui.sidebarOpen}
          onclick={() => ui.toggleSidebar()}
        >
          <Icon name="menu" size={20} />
        </button>
        <span class="chat-title">
          {#if chat.activeChannel.discordChannelId}<Icon name="link" size={15} />{:else}#{/if}
          {chat.activeChannel.name}
        </span>
        <button
          type="button"
          class="inbox-open"
          class:has-mentions={chat.mentionChannelIds.length > 0}
          aria-label="Mentions and replies"
          title="Mentions and replies"
          onclick={() => ui.openInbox()}
        >
          <Icon name="inbox" size={20} />
        </button>
        <HeaderActions />
        <button
          type="button"
          class="search-open"
          aria-label="Search messages"
          title="Search messages"
          onclick={() => ui.openSearch()}
        >
          <Icon name="search" size={20} />
        </button>
        <button
          class="drawer-toggle"
          type="button"
          aria-label="Show members"
          aria-expanded={ui.rosterOpen}
          onclick={() => ui.toggleRoster()}
        >
          <Icon name="users" size={20} />
        </button>
      </header>
      <MessageView />
      {#if typingLabel}
        <p class="typing">{typingLabel}</p>
      {/if}
      <Composer />

      {#if dragging}
        <div class="drop-zone"><span>Drop images to attach them</span></div>
      {/if}
    </section>
  {:else}
    <section class="chat empty">
      <button
        class="drawer-toggle"
        type="button"
        aria-label="Show channels"
        aria-expanded={ui.sidebarOpen}
        onclick={() => ui.toggleSidebar()}
      >
        <Icon name="menu" size={20} />
      </button>
      <p class="muted">No channels yet.</p>
    </section>
  {/if}

  <!--
    With no channel open the header, and the notice beside its saved button, are
    not on screen. The same due-reminder notice is shown here for that case; the
    button draws it whenever a channel is open, so this does not double up.
  -->
  {#if !chat.activeChannel && saved.notice}
    <div class="reminder-notice" role="status">
      <p>
        <strong>Reminder</strong>
        <span class="muted">{reminderAuthor(saved.notice.message)}:</span>
        {reminderSnippet(saved.notice.message)}
      </p>
      <div class="reminder-notice-actions">
        <button type="button" onclick={openSavedNotice}>View</button>
        <button type="button" class="ghost" onclick={() => (saved.notice = null)}>Dismiss</button>
      </div>
    </div>
  {/if}

  {#if update.notice}
    <div class="reminder-notice" role="status">
      <p>
        <strong>Update available</strong>
        Harmony {update.latest} is out; this instance runs {update.running}.
      </p>
      <div class="reminder-notice-actions">
        <button type="button" onclick={openUpdate}>View</button>
        <button type="button" class="ghost" onclick={() => update.dismiss()}>Dismiss</button>
      </div>
    </div>
  {/if}

  <MemberList />
  <KeyboardShortcuts />
  <UnreadBadge />

  {#if ui.pinsOpen}
    <PinsPanel onclose={() => ui.closePins()} />
  {/if}
  {#if ui.savedOpen}
    <SavedPanel onclose={() => ui.closeSaved()} />
  {/if}
  {#if ui.scheduledOpen}
    <ScheduledPanel onclose={() => ui.closeScheduled()} />
  {/if}
  {#if ui.eventsOpen}
    <EventsPanel onclose={() => ui.closeEvents()} />
  {/if}

  {#if ui.sidebarOpen || ui.rosterOpen}
    <button class="drawer-backdrop" type="button" aria-label="Close menu" onclick={() => ui.closeDrawers()}></button>
  {/if}
</div>
