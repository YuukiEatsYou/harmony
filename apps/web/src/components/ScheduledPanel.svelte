<script lang="ts">
  import { onMount } from 'svelte';
  import { LIMITS, type ScheduledMessage } from '@harmony/shared';
  import { ApiError } from '../lib/api';
  import { describeSendTime } from '../lib/schedule-time';
  import { scheduled } from '../lib/scheduled.svelte';
  import ScheduleTimeField from './ScheduleTimeField.svelte';

  let { onclose }: { onclose: () => void } = $props();

  let error = $state<string | null>(null);
  /** The entry being edited, with its working copy of the text and time. */
  let editing = $state<string | null>(null);
  let draftText = $state('');
  let draftWhen = $state<number | null>(null);
  let draftProblem = $state<string | null>(null);
  /** The entry with a request in flight, so its buttons cannot be pressed twice. */
  let working = $state<string | null>(null);

  const failed = $derived(scheduled.items.filter((entry) => entry.status === 'failed'));
  const waiting = $derived(scheduled.items.filter((entry) => entry.status !== 'failed'));

  function fail(cause: unknown): void {
    error = cause instanceof ApiError ? cause.message : String(cause);
  }

  function reading(entry: ScheduledMessage): string {
    return describeSendTime(Date.parse(entry.sendAt), { now: Date.now() });
  }

  function startEdit(entry: ScheduledMessage): void {
    error = null;
    editing = entry.id;
    draftText = entry.content;
    draftWhen = Date.parse(entry.sendAt);
    draftProblem = null;
  }

  async function saveEdit(entry: ScheduledMessage): Promise<void> {
    error = null;
    const changes: { content?: string; sendAt?: string } = {};
    if (draftText.trim() !== entry.content) changes.content = draftText.trim();
    // A failed entry's old time is in the past, so its time is always sent: the
    // new time is what puts it back in the queue.
    if (draftWhen !== null && (entry.status === 'failed' || draftWhen !== Date.parse(entry.sendAt))) {
      if (draftProblem) {
        error = draftProblem;
        return;
      }
      changes.sendAt = new Date(draftWhen).toISOString();
    }
    if (changes.content === undefined && changes.sendAt === undefined) {
      editing = null;
      return;
    }
    working = entry.id;
    try {
      await scheduled.update(entry.id, changes);
      editing = null;
    } catch (cause) {
      fail(cause);
    } finally {
      working = null;
    }
  }

  async function sendNow(entry: ScheduledMessage): Promise<void> {
    error = null;
    working = entry.id;
    try {
      await scheduled.sendNow(entry.id);
    } catch (cause) {
      fail(cause);
    } finally {
      working = null;
    }
  }

  async function cancel(entry: ScheduledMessage): Promise<void> {
    error = null;
    working = entry.id;
    try {
      await scheduled.cancel(entry.id);
      if (editing === entry.id) editing = null;
    } catch (cause) {
      fail(cause);
    } finally {
      working = null;
    }
  }

  onMount(() => {
    // Opening the panel is the member looking at their queue, so the notice for
    // a failure has done its job; the entry itself stays listed.
    if (scheduled.notice?.kind === 'failed') scheduled.notice = null;
    void scheduled.load();
  });
</script>

{#snippet entryCard(entry: ScheduledMessage)}
  <li class="saved-entry scheduled-entry" class:failed={entry.status === 'failed'}>
    <div class="search-result-head">
      <strong>#{scheduled.channelName(entry.channelId)}</strong>
      <span class="muted">{reading(entry)}</span>
      {#if entry.replyToId}<span class="muted">· reply</span>{/if}
    </div>

    {#if entry.status === 'failed'}
      <p class="form-error scheduled-error">Not sent: {entry.error ?? 'something went wrong.'}</p>
    {/if}

    {#if editing === entry.id}
      <textarea
        class="scheduled-text-edit"
        rows="3"
        maxlength={LIMITS.messageLength}
        aria-label="Message text"
        bind:value={draftText}
      ></textarea>
      <ScheduleTimeField bind:value={draftWhen} bind:problem={draftProblem} initial={Date.parse(entry.sendAt)} />
      {#if entry.status === 'failed'}
        <p class="muted scheduled-note">Picking a new time queues it again.</p>
      {/if}
      <div class="saved-actions">
        <button type="button" disabled={working === entry.id} onclick={() => saveEdit(entry)}>Save</button>
        <button type="button" class="ghost" onclick={() => (editing = null)}>Discard changes</button>
      </div>
    {:else}
      {#if entry.content}<p class="scheduled-text">{entry.content}</p>{/if}
      {#if entry.attachments.length > 0}
        <ul class="scheduled-files">
          {#each entry.attachments as attachment (attachment.id)}
            <li class="muted">{attachment.filename}</li>
          {/each}
        </ul>
      {/if}
      <div class="saved-actions">
        <button type="button" class="ghost" disabled={working === entry.id} onclick={() => startEdit(entry)}>
          {entry.status === 'failed' ? 'Reschedule' : 'Edit'}
        </button>
        <button type="button" class="ghost" disabled={working === entry.id} onclick={() => sendNow(entry)}>
          Send now
        </button>
        <button
          type="button"
          class="ghost"
          title="Delete this scheduled message"
          disabled={working === entry.id}
          onclick={() => cancel(entry)}
        >
          Delete
        </button>
      </div>
    {/if}
  </li>
{/snippet}

<div class="admin-overlay">
  <div class="admin inbox-panel saved-panel scheduled-panel">
    <div class="admin-body">
      <div class="search-head">
        <h3>Scheduled messages</h3>
        <button type="button" onclick={onclose}>Close</button>
      </div>
      <p class="muted scheduled-intro">
        Only you can see these. The server sends them at the time shown, even if Harmony is closed.
      </p>

      {#if error}<p class="form-error">{error}</p>{/if}

      {#if failed.length > 0}
        <h4 class="saved-heading">Not sent</h4>
        <ul class="search-results">
          {#each failed as entry (entry.id)}
            {@render entryCard(entry)}
          {/each}
        </ul>
        {#if waiting.length > 0}<h4 class="saved-heading">Waiting</h4>{/if}
      {/if}

      {#if !scheduled.loaded}
        <p class="muted">Loading…</p>
      {:else if scheduled.items.length === 0}
        <p class="muted">
          Nothing scheduled. Write a message and choose "Schedule send" next to the send button to send it later.
        </p>
      {:else}
        <ul class="search-results">
          {#each waiting as entry (entry.id)}
            {@render entryCard(entry)}
          {/each}
        </ul>
      {/if}
    </div>
  </div>
</div>
