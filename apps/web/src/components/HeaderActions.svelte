<script lang="ts">
  import type { Message } from '@harmony/shared';
  import { events } from '../lib/events.svelte';
  import { saved } from '../lib/saved.svelte';
  import { scheduled } from '../lib/scheduled.svelte';
  import { ui } from '../lib/ui.svelte';
  import Icon from './Icon.svelte';

  /**
   * The channel's overflow menu. Pinned, saved, scheduled and events all live
   * behind one button so the header stays uncluttered. The button carries a dot
   * when any of them needs attention, and each reminder notice is drawn here,
   * fixed to the corner, whether or not the menu is open — so a reminder still
   * appears when the menu is closed.
   */

  type Panel = 'pins' | 'saved' | 'scheduled' | 'events';

  let open = $state(false);
  let root = $state<HTMLElement | null>(null);

  const needsAttention = $derived(
    saved.due.length > 0 || scheduled.badge.count > 0 || events.liveCount > 0,
  );
  /** A failed scheduled send is the one of the three that reads as an error. */
  const attentionIsError = $derived(scheduled.badge.failed > 0);

  function authorName(message: Message): string {
    return message.author?.displayName ?? message.author?.username ?? 'Deleted user';
  }

  /** A line of the message for the notice; the panel is where it is read in full. */
  function snippet(message: Message): string {
    const text = message.content.replace(/\s+/g, ' ').trim();
    if (text.length === 0) return message.attachments.length > 0 ? '(attachment)' : '';
    return text.length > 90 ? `${text.slice(0, 90)}…` : text;
  }

  function openPanel(panel: Panel): void {
    open = false;
    if (panel === 'pins') ui.openPins();
    else if (panel === 'saved') {
      saved.notice = null;
      ui.openSaved();
    } else if (panel === 'scheduled') {
      scheduled.notice = null;
      ui.openScheduled();
    } else {
      events.notice = null;
      ui.openEvents();
    }
  }

  function onWindowPointer(event: PointerEvent): void {
    if (open && root && !root.contains(event.target as Node)) open = false;
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (open && event.key === 'Escape') open = false;
  }
</script>

<svelte:window onpointerdown={onWindowPointer} onkeydown={onWindowKeydown} />

<div class="header-actions" bind:this={root}>
  <button
    type="button"
    class="header-menu-toggle"
    class:has-waiting={needsAttention}
    class:has-failed={attentionIsError}
    aria-label="Channel actions"
    title="Channel actions"
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <Icon name="more" size={20} />
  </button>

  {#if open}
    <div class="header-menu" role="menu">
      <button type="button" role="menuitem" onclick={() => openPanel('pins')}>
        <span class="header-menu-icon"><Icon name="pin" size={18} /></span> Pinned messages
      </button>
      <button type="button" role="menuitem" onclick={() => openPanel('saved')}>
        <span class="header-menu-icon"><Icon name="bookmark" size={18} /></span> Saved messages
        {#if saved.due.length > 0}<span class="menu-dot" aria-hidden="true"></span>{/if}
      </button>
      <button type="button" role="menuitem" onclick={() => openPanel('scheduled')}>
        <span class="header-menu-icon"><Icon name="clock" size={18} /></span> Scheduled messages
        {#if scheduled.badge.count > 0}
          <span class="menu-count" class:failed={scheduled.badge.failed > 0} aria-hidden="true">
            {scheduled.badge.count > 9 ? '9+' : scheduled.badge.count}
          </span>
        {/if}
      </button>
      <button type="button" role="menuitem" onclick={() => openPanel('events')}>
        <span class="header-menu-icon"><Icon name="calendar" size={18} /></span> Events
        {#if events.liveCount > 0}<span class="menu-dot" aria-hidden="true"></span>{/if}
      </button>
    </div>
  {/if}

  {#if saved.notice}
    <div class="reminder-notice" role="status">
      <p>
        <strong>Reminder</strong>
        <span class="muted">{authorName(saved.notice.message)}:</span>
        {snippet(saved.notice.message)}
      </p>
      <div class="reminder-notice-actions">
        <button type="button" onclick={() => openPanel('saved')}>View</button>
        <button type="button" class="ghost" onclick={() => (saved.notice = null)}>Dismiss</button>
      </div>
    </div>
  {/if}

  {#if scheduled.notice}
    <div class="reminder-notice scheduled-notice" class:failed={scheduled.notice.kind === 'failed'} role="status">
      <p>{scheduled.notice.text}</p>
      <div class="reminder-notice-actions">
        <button type="button" onclick={() => openPanel('scheduled')}>
          {scheduled.notice.kind === 'failed' ? 'Review' : 'View'}
        </button>
        <button type="button" class="ghost" onclick={() => (scheduled.notice = null)}>Dismiss</button>
      </div>
    </div>
  {/if}

  {#if events.notice}
    <div class="reminder-notice events-notice" role="status">
      <p>
        <strong>Event reminder</strong>
        {events.notice.text}
      </p>
      <div class="reminder-notice-actions">
        <button type="button" onclick={() => openPanel('events')}>View</button>
        <button type="button" class="ghost" onclick={() => (events.notice = null)}>Dismiss</button>
      </div>
    </div>
  {/if}
</div>
