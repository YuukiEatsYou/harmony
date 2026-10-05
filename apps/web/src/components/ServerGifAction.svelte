<script lang="ts">
  import { Permission, hasPermission, isGifContentType, type Message } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { session } from '../lib/session.svelte';

  /**
   * "Add to server gifs" in a message's action menu, for members who manage
   * emoji (the permission that guards the curated list) and only on a message
   * that carries a gif. The server stores its own copy, so the gif outlives the
   * message; open pickers refresh from the SERVER_GIFS_UPDATE it fires.
   */
  let {
    message,
    ondone,
    onerror,
  }: { message: Message; ondone: () => void; onerror: (text: string) => void } = $props();

  const gif = $derived(message.attachments.find((attachment) => isGifContentType(attachment.contentType)));
  const allowed = $derived(hasPermission(BigInt(session.permissions || '0'), Permission.ManageEmojis));

  async function add(): Promise<void> {
    if (!gif) return;
    ondone();
    try {
      await api('/gifs/server', { method: 'POST', body: JSON.stringify({ attachmentId: gif.id }) });
    } catch (cause) {
      // Already curated is not a failure worth a red banner, but say so.
      onerror(cause instanceof ApiError ? cause.message : String(cause));
    }
  }
</script>

{#if allowed && gif}
  <button type="button" title="Add this gif to the server's gifs" onclick={add}>Add to server gifs</button>
{/if}
