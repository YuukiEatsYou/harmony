<script lang="ts">
  import { events } from '../lib/events.svelte';
  import { ui } from '../lib/ui.svelte';
  import Icon from './Icon.svelte';

  /**
   * The header button that opens the events panel. A dot marks an event that is
   * happening now, and the line that appears when a reminder arrives (an event
   * the member is interested in is about to start) sits beside the button it
   * points to, the way the saved and scheduled buttons carry theirs.
   */

  const label = $derived(
    events.liveCount > 0
      ? `Events, ${events.liveCount} happening now`
      : 'Events',
  );

  function openPanel(): void {
    events.notice = null;
    ui.openEvents();
  }
</script>

<button
  type="button"
  class="events-open"
  class:has-live={events.liveCount > 0}
  aria-label={label}
  title="Events"
  onclick={openPanel}
>
  <Icon name="calendar" size={20} />
</button>

{#if events.notice}
  <div class="reminder-notice events-notice" role="status">
    <p>
      <strong>Event reminder</strong>
      {events.notice.text}
    </p>
    <div class="reminder-notice-actions">
      <button type="button" onclick={openPanel}>View</button>
      <button type="button" class="ghost" onclick={() => (events.notice = null)}>Dismiss</button>
    </div>
  </div>
{/if}
