<script lang="ts">
  import { onMount } from 'svelte';
  import type { Channel, ChannelMediaItem, ChannelMediaResponse } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { chat } from '../lib/chat.svelte';
  import { formatBytes } from '../lib/format';
  import { lightbox } from '../lib/lightbox.svelte';

  /**
   * One channel's media gallery: every image and video posted in it, newest
   * first. It is opened from the channel menu, so it belongs to the channel it was
   * opened for rather than the one on screen, and jumping to a tile's message
   * brings that channel up.
   */
  let { channel, onclose }: { channel: Channel; onclose: () => void } = $props();

  const pageSize = 50;

  let media = $state<ChannelMediaItem[]>([]);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let loaded = $state(false);
  let reachedEnd = $state(false);

  function fail(cause: unknown): void {
    error = cause instanceof ApiError ? cause.message : String(cause);
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      media = (await api<ChannelMediaResponse>(`/channels/${channel.id}/media?limit=${pageSize}`)).media;
      reachedEnd = media.length < pageSize;
      loaded = true;
    } catch (cause) {
      fail(cause);
    } finally {
      loading = false;
    }
  }

  async function loadMore(): Promise<void> {
    const oldest = media.at(-1)?.attachment;
    if (!oldest || loading) return;

    loading = true;
    error = null;
    try {
      const query = new URLSearchParams({
        limit: String(pageSize),
        before: oldest.createdAt,
        beforeId: oldest.id,
      });
      const page = (await api<ChannelMediaResponse>(`/channels/${channel.id}/media?${query}`)).media;
      media = [...media, ...page];
      reachedEnd = page.length < pageSize;
    } catch (cause) {
      fail(cause);
    } finally {
      loading = false;
    }
  }

  /** Opens the message a tile came from, in the channel it was posted in. */
  async function open(item: ChannelMediaItem): Promise<void> {
    await chat.jumpToMessage(item.message.channelId, item.message);
    onclose();
  }

  function uploader(item: ChannelMediaItem): string {
    return item.message.author?.displayName ?? item.message.author?.username ?? 'Deleted user';
  }

  onMount(() => {
    void load();
  });
</script>

<div class="admin-overlay">
  <div class="admin inbox-panel gallery-panel">
    <div class="admin-body">
      <div class="search-head">
        <h3>Media in #{channel.name}</h3>
        <button type="button" onclick={onclose}>Close</button>
      </div>

      {#if error}<p class="form-error">{error}</p>{/if}

      {#if !loaded && !error}
        <p class="muted">Loading…</p>
      {:else if loaded && media.length === 0}
        <p class="muted">No images or videos posted in this channel yet.</p>
      {:else}
        <ul class="media-grid">
          {#each media as item (item.attachment.id)}
            <li class="media-card">
              {#if item.attachment.contentType.startsWith('video/')}
                <!-- Clips are stored as they arrive, with no caption track to offer. -->
                <!-- svelte-ignore a11y_media_has_caption -->
                <video src={`/api/v1/attachments/${item.attachment.id}`} controls preload="metadata"></video>
              {:else}
                <a
                  href={`/api/v1/attachments/${item.attachment.id}`}
                  target="_blank"
                  rel="noreferrer"
                  onclick={(event) => {
                    event.preventDefault();
                    lightbox.open(`/api/v1/attachments/${item.attachment.id}`, item.attachment.filename);
                  }}
                >
                  <img src={`/api/v1/attachments/${item.attachment.id}`} alt={item.attachment.filename} loading="lazy" />
                </a>
              {/if}
              <div class="media-meta">
                <span class="media-name" title={item.attachment.filename}>{item.attachment.filename}</span>
                <span class="muted">
                  {uploader(item)} · {formatBytes(item.attachment.size)}
                </span>
                <span class="muted">{new Date(item.message.createdAt).toLocaleString()}</span>
              </div>
              <button type="button" class="ghost" onclick={() => open(item)}>Jump to message</button>
            </li>
          {/each}
        </ul>

        {#if !reachedEnd}
          <div class="editor-actions">
            <button type="button" onclick={loadMore} disabled={loading}>
              {loading ? 'Loading…' : 'Load more'}
            </button>
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  /* A grid of tiles wants more room than the reading-width panels. */
  .gallery-panel {
    width: min(900px, 96vw);
  }
</style>
