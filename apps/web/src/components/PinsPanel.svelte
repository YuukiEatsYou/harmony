<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Permission,
    hasPermission,
    type Message,
    type MessageDeletePayload,
    type PinListResponse,
  } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { avatarUrl, initial } from '../lib/avatar';
  import { chat } from '../lib/chat.svelte';
  import { gateway } from '../lib/gateway';
  import { session } from '../lib/session.svelte';

  let { onclose }: { onclose: () => void } = $props();

  /*
   * The panel belongs to the channel it was opened from. It is a modal, so the
   * channel cannot change underneath it, and jumping away closes it anyway.
   */
  const channelId = chat.activeChannelId;
  const channelName = chat.activeChannel?.name ?? 'this channel';

  let pins = $state<Message[]>([]);
  let loaded = $state(false);
  let error = $state<string | null>(null);

  const canUnpin = $derived(hasPermission(BigInt(session.permissions || '0'), Permission.ManageMessages));

  function fail(cause: unknown): void {
    error = cause instanceof ApiError ? cause.message : String(cause);
  }

  function authorName(message: Message): string {
    return message.author?.displayName ?? message.author?.username ?? 'Deleted user';
  }

  /** Not every pin carries text: a pinned picture has none. */
  function preview(message: Message): string {
    if (message.content.length > 0) return message.content;
    return message.attachments.length > 0 || message.stickers.length > 0 ? '(attachment)' : '';
  }

  /** Newest pin first, the order the server hands them out in. */
  function byPinTime(a: Message, b: Message): number {
    return (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? '');
  }

  async function load(): Promise<void> {
    if (!channelId) return;
    error = null;
    try {
      pins = (await api<PinListResponse>(`/channels/${channelId}/pins`)).messages;
      loaded = true;
    } catch (cause) {
      fail(cause);
    }
  }

  async function open(message: Message): Promise<void> {
    await chat.jumpToMessage(message.channelId, message);
    onclose();
  }

  async function unpin(message: Message): Promise<void> {
    error = null;
    try {
      await api(`/channels/${message.channelId}/pins/${message.id}`, { method: 'DELETE' });
      pins = pins.filter((pin) => pin.id !== message.id);
    } catch (cause) {
      fail(cause);
    }
  }

  onMount(() => {
    void load();

    // Pins come and go as ordinary message updates, so follow those while open:
    // someone else pinning, unpinning or deleting shows up without a reload.
    return gateway.onEvent((frame) => {
      if (frame.t === 'MESSAGE_UPDATE') {
        const message = frame.d as Message;
        if (message.channelId !== channelId) return;
        const existing = pins.find((pin) => pin.id === message.id);
        if (!message.pinnedAt) {
          if (existing) pins = pins.filter((pin) => pin.id !== message.id);
          return;
        }
        // An update's reactions and saved flag are not this viewer's, so keep the ones we have.
        const next = existing ? { ...message, reactions: existing.reactions, saved: existing.saved } : message;
        pins = [...pins.filter((pin) => pin.id !== message.id), next].sort(byPinTime);
      } else if (frame.t === 'MESSAGE_DELETE') {
        const payload = frame.d as MessageDeletePayload;
        pins = pins.filter((pin) => pin.id !== payload.id);
      } else if (frame.t === 'READY') {
        // A reconnect may have missed pins added or removed while the socket was down.
        void load();
      }
    });
  });
</script>

<div class="admin-overlay">
  <div class="admin inbox-panel pins-panel">
    <div class="admin-body">
      <div class="search-head">
        <h3>Pinned in #{channelName}</h3>
        <button type="button" onclick={onclose}>Close</button>
      </div>

      {#if error}<p class="form-error">{error}</p>{/if}

      {#if !loaded && !error}
        <p class="muted">Loading…</p>
      {:else if loaded && pins.length === 0}
        <p class="muted">No pinned messages yet. Pin one from its message menu to keep it here.</p>
      {:else}
        <ul class="search-results">
          {#each pins as message (message.id)}
            <li>
              <button type="button" class="search-result" onclick={() => open(message)}>
                <span class="search-result-head">
                  {#if avatarUrl(message.author)}
                    <img class="avatar small" src={avatarUrl(message.author)} alt="" loading="lazy" />
                  {:else}
                    <span class="avatar small fallback">{initial(message.author)}</span>
                  {/if}
                  <strong>{authorName(message)}</strong>
                  <time class="muted">{new Date(message.createdAt).toLocaleString()}</time>
                </span>
                <span class="search-result-text">{preview(message)}</span>
              </button>
              {#if canUnpin}
                <button type="button" class="ghost pin-remove" title="Unpin" onclick={() => unpin(message)}>Unpin</button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
</div>
