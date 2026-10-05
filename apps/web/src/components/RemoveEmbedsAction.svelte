<script lang="ts">
  import { Permission, hasPermission, type Message } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { session } from '../lib/session.svelte';

  /**
   * The Remove embeds entry in a message's action menu. It is offered to the
   * message's author and to anyone who manages messages, and only while there is
   * something to remove: a preview card, or a picture the server fetched from a
   * link in the text (an upload has no source address and is not an embed). The
   * server echoes the result back as a message update, so nothing is patched here.
   */
  let {
    message,
    ondone,
    onerror,
  }: { message: Message; ondone: () => void; onerror: (text: string) => void } = $props();

  const allowed = $derived(
    message.author?.id === session.user?.id ||
      hasPermission(BigInt(session.permissions || '0'), Permission.ManageMessages),
  );
  const hasEmbeds = $derived(message.embed !== null || message.attachments.some((a) => a.sourceUrl !== null));

  async function remove(): Promise<void> {
    ondone();
    try {
      await api(`/messages/${message.id}/embeds`, { method: 'DELETE' });
    } catch (cause) {
      onerror(cause instanceof ApiError ? cause.message : String(cause));
    }
  }
</script>

{#if allowed && hasEmbeds}
  <button type="button" title="Remove the link preview or picture from this message" onclick={remove}>
    Remove embeds
  </button>
{/if}
