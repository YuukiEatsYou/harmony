<script lang="ts">
  import { onMount } from 'svelte';
  import type { GifArchiveResponse, GifFreeResponse, GifSourceStats } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';

  /** The mode currently saved on the server; freeing copies only makes sense while linking. */
  let { storedMode }: { storedMode: 'store' | 'link' } = $props();

  let stats = $state<GifSourceStats | null>(null);
  let working = $state<'archive' | 'free' | null>(null);
  let note = $state<string | null>(null);
  let error = $state<string | null>(null);
  let progress = $state<string | null>(null);
  let confirmingFree = $state(false);

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 KB';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function load(): Promise<void> {
    try {
      stats = await api<GifSourceStats>('/gifs/sources');
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : 'Could not load the gif counts.';
    }
  }

  onMount(() => void load());

  /** Copies recorded gifs in bounded batches until none are left, showing progress. */
  async function archive(): Promise<void> {
    working = 'archive';
    error = null;
    note = null;
    let copied = 0;
    let failed = 0;
    let dead = 0;
    try {
      for (;;) {
        const batch = await api<GifArchiveResponse>('/gifs/sources/archive', { method: 'POST' });
        stats = batch.stats;
        copied += batch.copied;
        failed += batch.failed;
        dead += batch.markedDead;
        progress = `Copied ${copied}, ${failed} failed so far…`;
        if (!batch.more || batch.attempted === 0) break;
      }
      note = `Copied ${copied} gif${copied === 1 ? '' : 's'}${failed > 0 ? `, ${failed} could not be fetched` : ''}${dead > 0 ? `, ${dead} given up on` : ''}.`;
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : 'Archiving stopped unexpectedly.';
    } finally {
      working = null;
      progress = null;
    }
  }

  async function free(): Promise<void> {
    working = 'free';
    error = null;
    note = null;
    confirmingFree = false;
    try {
      const result = await api<GifFreeResponse>('/gifs/sources/free', { method: 'POST' });
      stats = result.stats;
      note = `Released ${result.released} cop${result.released === 1 ? 'y' : 'ies'} (${formatBytes(result.freedBytes)} freed).`;
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : 'Could not release the copies.';
    } finally {
      working = null;
    }
  }
</script>

<div class="gif-sources">
  <h4>Linked gifs</h4>
  {#if stats}
    <p class="muted">
      <strong>{stats.linked}</strong> linked only, <strong>{stats.archived}</strong> with a copy on this server
      ({formatBytes(stats.archivedBytes)}), <strong>{stats.dead}</strong> no longer reachable.
    </p>
  {:else if !error}
    <p class="muted">Loading…</p>
  {/if}

  <div class="editor-actions">
    <button type="button" onclick={archive} disabled={working !== null || stats?.linked === 0}>
      {working === 'archive' ? 'Copying…' : 'Archive linked gifs'}
    </button>
    {#if confirmingFree}
      <button type="button" class="danger" onclick={free} disabled={working !== null}>Yes, release them</button>
      <button type="button" class="secondary" onclick={() => (confirmingFree = false)}>Cancel</button>
    {:else}
      <button
        type="button"
        class="danger"
        onclick={() => (confirmingFree = true)}
        disabled={working !== null || storedMode !== 'link' || stats?.archived === 0}
      >
        Free copies of gifs that are still linked
      </button>
    {/if}
  </div>
  {#if progress}<p class="muted">{progress}</p>{/if}
  {#if error}<p class="form-error">{error}</p>{/if}
  {#if note}<p class="ok-text">{note}</p>{/if}
  <p class="muted">
    <strong>Archive</strong> copies every gif that was only linked onto this server (a few at a time, from the
    known gif hosts only, within your upload limits), so it survives the service removing it and shows even
    if you switch to storing. <strong>Free copies</strong> removes the copies of gifs that are still linked and
    that nothing else keeps; gifs members saved, gifs on a message as an attachment and curated server gifs are
    never touched. The addresses stay recorded, so a gif can be copied again later. Freeing is only available
    while storage is set to Link (save the setting first). Clips (MP4 or WebM) cannot be copied and stay linked.
  </p>
</div>
