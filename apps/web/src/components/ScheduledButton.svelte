<script lang="ts">
  import { scheduled } from '../lib/scheduled.svelte';
  import { ui } from '../lib/ui.svelte';
  import Icon from './Icon.svelte';

  /**
   * The header button that opens the scheduled panel. It carries the count of
   * what is waiting (red when something failed to send), and the line that
   * appears when a schedule was just made or a delivery failed, so the news sits
   * beside the panel it points to.
   */

  const label = $derived(
    scheduled.badge.failed > 0
      ? `Scheduled messages, ${scheduled.badge.failed} not sent`
      : scheduled.badge.count > 0
        ? `Scheduled messages, ${scheduled.badge.count} waiting`
        : 'Scheduled messages',
  );

  function openPanel(): void {
    scheduled.notice = null;
    ui.openScheduled();
  }
</script>

<button
  type="button"
  class="scheduled-open"
  class:has-failed={scheduled.badge.failed > 0}
  aria-label={label}
  title="Scheduled messages"
  onclick={openPanel}
>
  <Icon name="clock" size={20} />
  {#if scheduled.badge.count > 0}
    <span class="scheduled-count" aria-hidden="true">{scheduled.badge.count > 9 ? '9+' : scheduled.badge.count}</span>
  {/if}
</button>

{#if scheduled.notice}
  <div class="reminder-notice scheduled-notice" class:failed={scheduled.notice.kind === 'failed'} role="status">
    <p>{scheduled.notice.text}</p>
    <div class="reminder-notice-actions">
      <button type="button" onclick={openPanel}>{scheduled.notice.kind === 'failed' ? 'Review' : 'View'}</button>
      <button type="button" class="ghost" onclick={() => (scheduled.notice = null)}>Dismiss</button>
    </div>
  </div>
{/if}
