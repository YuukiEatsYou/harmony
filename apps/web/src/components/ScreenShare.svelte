<script lang="ts">
  import { voice } from '../lib/voice.svelte';
  import Icon from './Icon.svelte';

  /**
   * The screens being shared in the current voice channel. The relay only carries
   * a member's screen to others in the same room, so the sharer is always in
   * `voice.members` and their name can be read from it.
   */
  const screens = $derived(Object.entries(voice.screens));

  function label(userId: string): string {
    const entry = voice.members.find((member) => member.user.id === userId);
    if (!entry) return 'Someone';
    return entry.user.displayName ?? entry.user.username;
  }

  /** Fullscreens the tile the button belongs to, so the share fills the screen. */
  function goFullscreen(event: MouseEvent): void {
    const tile = (event.currentTarget as HTMLElement).closest('.screen-tile');
    const video = tile?.querySelector('video');
    void video?.requestFullscreen?.().catch(() => undefined);
  }
</script>

{#if screens.length > 0}
  <div class="screen-share" role="region" aria-label="Shared screens">
    {#each screens as [userId, stream] (userId)}
      <div class="screen-tile">
        <div class="screen-tile-head">
          <span class="screen-tile-name">
            <Icon name="screen" size={13} />
            {label(userId)}
          </span>
          <button
            type="button"
            class="screen-tile-action"
            title="Fullscreen"
            aria-label="Fullscreen"
            onclick={goFullscreen}
          >
            <Icon name="expand" size={15} />
          </button>
        </div>
        <video srcObject={stream} autoplay playsinline></video>
      </div>
    {/each}
  </div>
{/if}
