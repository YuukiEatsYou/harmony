<script lang="ts">
  import { onMount } from 'svelte';
  import type { ScheduledMessage } from '@harmony/shared';
  import { ApiError } from '../lib/api';
  import { describeSendTime } from '../lib/schedule-time';
  import { scheduled } from '../lib/scheduled.svelte';
  import ScheduleTimeField from './ScheduleTimeField.svelte';

  /**
   * The composer's "Schedule send" popover: what is being written, a time, and a
   * button that hands it to the server to post later. It does not clear the draft
   * itself; `onscheduled` tells the composer the draft has been taken.
   *
   * `onclose` says whether focus should go back to the message box, as the
   * timestamp picker's does.
   */
  let {
    channelId,
    channelName,
    content,
    attachmentIds,
    replyToId,
    onscheduled,
    onclose,
  }: {
    channelId: string;
    channelName: string;
    content: string;
    attachmentIds: string[];
    replyToId: string | null;
    onscheduled: (entry: ScheduledMessage) => void;
    onclose: (refocus: boolean) => void;
  } = $props();

  let when = $state<number | null>(null);
  let problem = $state<string | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const empty = $derived(content.trim().length === 0 && attachmentIds.length === 0);
  const snippet = $derived(
    content.trim().length === 0
      ? `${attachmentIds.length} attachment${attachmentIds.length === 1 ? '' : 's'}`
      : content.replace(/\s+/g, ' ').trim().slice(0, 80) + (content.trim().length > 80 ? '…' : ''),
  );

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy || empty || when === null || problem) return;
    busy = true;
    error = null;
    try {
      const entry = await scheduled.create(channelId, {
        content: content.trim(),
        attachmentIds,
        replyToId,
        sendAt: new Date(when).toISOString(),
      });
      scheduled.announce({
        kind: 'scheduled',
        text: `Scheduled for ${describeSendTime(when, { now: Date.now() })} in #${channelName}.`,
      });
      onscheduled(entry);
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    // The composer would otherwise take the same Escape to cancel a reply.
    event.preventDefault();
    event.stopPropagation();
    onclose(true);
  }

  onMount(() => {
    // A click anywhere else dismisses the popover, except on the button that
    // toggles it, which would otherwise close it only to open it again.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (target?.closest('.schedule-picker') || target?.closest('.schedule-trigger')) return;
      onclose(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });
</script>

<div class="timestamp-picker schedule-picker" role="dialog" aria-label="Schedule send" tabindex="-1" onkeydown={onKeydown}>
  <form class="timestamp-form" onsubmit={submit}>
    <p class="schedule-summary">
      <strong>Send later</strong>
      <span class="muted">to #{channelName}</span>
    </p>
    {#if empty}
      <p class="muted schedule-note">Write a message first, then choose when to send it.</p>
    {:else}
      <p class="muted schedule-snippet">{snippet}</p>
    {/if}

    <ScheduleTimeField bind:value={when} bind:problem autofocus />

    {#if error}<p class="form-error schedule-note">{error}</p>{/if}
    <p class="muted timestamp-note">Sent by the server, even if you close Harmony. Find it under Scheduled.</p>
    <button type="submit" disabled={busy || empty || when === null || problem !== null}>
      {busy ? 'Scheduling…' : 'Schedule'}
    </button>
  </form>
</div>
