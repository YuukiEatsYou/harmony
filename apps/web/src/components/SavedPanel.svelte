<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    Message,
    MessageDeletePayload,
    SavedMessage,
    SavedMessageListResponse,
    SavedMessageUpdatePayload,
  } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { avatarUrl, initial } from '../lib/avatar';
  import { chat } from '../lib/chat.svelte';
  import { gateway } from '../lib/gateway';
  import { emojis } from '../lib/emojis.svelte';
  import { members } from '../lib/members.svelte';
  import { parseMessage } from '../lib/message-text';
  import { saved } from '../lib/saved.svelte';
  import MessageContent from './MessageContent.svelte';

  let { onclose }: { onclose: () => void } = $props();

  const pageSize = 25;

  let entries = $state<SavedMessage[]>([]);
  let busy = $state(false);
  let loaded = $state(false);
  /** Whether the last page came back full, so there may be more behind it. */
  let hasMore = $state(false);
  let error = $state<string | null>(null);

  function fail(cause: unknown): void {
    error = cause instanceof ApiError ? cause.message : String(cause);
  }

  function channelName(channelId: string): string {
    return chat.channels.find((channel) => channel.id === channelId)?.name ?? 'a channel';
  }

  function authorName(message: Message): string {
    return message.author?.displayName ?? message.author?.username ?? 'Deleted user';
  }

  /** The same parse the message list uses, so a save reads exactly like the message. */
  function blocksOf(message: Message) {
    return parseMessage(
      message.content,
      emojis.lookup,
      (name) => members.byUsername.get(name.toLowerCase()),
      chat.channels,
    );
  }

  /** What to say for a save with nothing to render: a picture, a sticker. */
  function attachmentNote(message: Message): string | null {
    const count = message.attachments.length + message.stickers.length;
    if (count === 0) return null;
    return count === 1 ? '1 attachment' : `${count} attachments`;
  }

  /** Newest save first, the order the server hands them out in. */
  function bySaveTime(a: SavedMessage, b: SavedMessage): number {
    return b.savedAt.localeCompare(a.savedAt) || b.message.id.localeCompare(a.message.id);
  }

  function buildQuery(after?: SavedMessage): string {
    const query = new URLSearchParams({ limit: String(pageSize) });
    if (after) {
      query.set('before', after.savedAt);
      query.set('beforeId', after.message.id);
    }
    return query.toString();
  }

  async function load(): Promise<void> {
    busy = true;
    error = null;
    try {
      const page = (await api<SavedMessageListResponse>(`/users/@me/saved?${buildQuery()}`)).saved;
      entries = page;
      hasMore = page.length >= pageSize;
      loaded = true;
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  /** Loads the page of saves older than the oldest one already shown. */
  async function loadMore(): Promise<void> {
    const oldest = entries[entries.length - 1];
    if (!oldest) return;

    busy = true;
    error = null;
    try {
      const page = (await api<SavedMessageListResponse>(`/users/@me/saved?${buildQuery(oldest)}`)).saved;
      const known = new Set(entries.map((entry) => entry.message.id));
      entries = [...entries, ...page.filter((entry) => !known.has(entry.message.id))];
      hasMore = page.length >= pageSize;
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  async function open(entry: SavedMessage): Promise<void> {
    await chat.jumpToMessage(entry.message.channelId, entry.message);
    onclose();
  }

  async function remove(entry: SavedMessage): Promise<void> {
    error = null;
    try {
      await saved.unsave(entry.message);
      entries = entries.filter((other) => other.message.id !== entry.message.id);
    } catch (cause) {
      fail(cause);
    }
  }

  async function finishReminder(entry: SavedMessage): Promise<void> {
    error = null;
    try {
      // Apply the change here as well as through the gateway echo, so a delayed or
      // lost echo cannot leave the old reminder time showing on the row.
      const updated = await saved.clearReminder(entry);
      entries = entries.map((other) =>
        other.message.id === entry.message.id ? { ...other, remindAt: updated.remindAt } : other,
      );
    } catch (cause) {
      fail(cause);
    }
  }

  onMount(() => {
    void load();
    // Opening the panel is the member looking at their reminders, so the notice
    // for one that just came due has done its job.
    saved.notice = null;

    // Follow the member's own saves made elsewhere, and edits or deletions of the
    // messages listed, without a reload.
    return gateway.onEvent((frame) => {
      if (frame.t === 'SAVED_MESSAGE_UPDATE') {
        const payload = frame.d as SavedMessageUpdatePayload;
        const rest = entries.filter((entry) => entry.message.id !== payload.messageId);
        entries = payload.saved ? [...rest, payload.saved].sort(bySaveTime) : rest;
      } else if (frame.t === 'MESSAGE_UPDATE') {
        const message = frame.d as Message;
        // An update's reactions and saved flag are not this viewer's, so keep ours.
        entries = entries.map((entry) =>
          entry.message.id === message.id
            ? { ...entry, message: { ...message, reactions: entry.message.reactions, saved: true } }
            : entry,
        );
      } else if (frame.t === 'MESSAGE_DELETE') {
        const payload = frame.d as MessageDeletePayload;
        entries = entries.filter((entry) => entry.message.id !== payload.id);
      } else if (frame.t === 'READY') {
        // A reconnect may have missed saves made while the socket was down.
        void load();
      }
    });
  });
</script>

{#snippet savedEntry(entry: SavedMessage)}
  {@const note = attachmentNote(entry.message)}
  <!--
    Not one big button like a search result: the rendered content can hold its
    own links, spoilers and copy buttons, which cannot sit inside a button. The
    jump gets a button of its own instead.
  -->
  <li class="saved-entry" class:due={saved.isDue(entry)}>
    <div class="search-result-head">
      {#if avatarUrl(entry.message.author)}
        <img class="avatar small" src={avatarUrl(entry.message.author)} alt="" loading="lazy" />
      {:else}
        <span class="avatar small fallback">{initial(entry.message.author)}</span>
      {/if}
      <strong>{authorName(entry.message)}</strong>
      <span class="muted">in #{channelName(entry.message.channelId)}</span>
      <time class="muted">{new Date(entry.message.createdAt).toLocaleString()}</time>
    </div>
    {#if entry.message.content}
      <div class="content saved-content"><MessageContent blocks={blocksOf(entry.message)} /></div>
    {/if}
    {#if note}<p class="muted saved-note">{note}</p>{/if}
    {#if entry.remindAt}
      <p class="saved-reminder">
        {saved.isDue(entry) ? 'Reminder due' : 'Reminder'} · {new Date(entry.remindAt).toLocaleString()}
      </p>
    {/if}
    <div class="saved-actions">
      <button type="button" class="ghost" onclick={() => open(entry)}>Jump</button>
      {#if entry.remindAt}
        <button type="button" class="ghost" title="Stop reminding, keep it saved" onclick={() => finishReminder(entry)}>
          {saved.isDue(entry) ? 'Done' : 'Cancel reminder'}
        </button>
      {/if}
      <button type="button" class="ghost" title="Remove from saved" onclick={() => remove(entry)}>Remove</button>
    </div>
  </li>
{/snippet}

<div class="admin-overlay">
  <div class="admin inbox-panel saved-panel">
    <div class="admin-body">
      <div class="search-head">
        <h3>Saved messages</h3>
        <button type="button" onclick={onclose}>Close</button>
      </div>

      {#if error}<p class="form-error">{error}</p>{/if}

      {#if saved.due.length > 0}
        <h4 class="saved-heading">Reminders due</h4>
        <ul class="search-results">
          {#each saved.due as entry (entry.message.id)}
            {@render savedEntry(entry)}
          {/each}
        </ul>
        <h4 class="saved-heading">All saved</h4>
      {/if}

      {#if busy && entries.length === 0}
        <p class="muted">Loading…</p>
      {:else if loaded && entries.length === 0}
        <p class="muted">Nothing saved yet. Save a message from its menu to find it here later.</p>
      {:else}
        <ul class="search-results">
          {#each entries as entry (entry.message.id)}
            {@render savedEntry(entry)}
          {/each}
        </ul>

        {#if hasMore}
          <div class="editor-actions">
            <button type="button" onclick={loadMore} disabled={busy}>
              {busy ? 'Loading…' : 'Load older saves'}
            </button>
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>
