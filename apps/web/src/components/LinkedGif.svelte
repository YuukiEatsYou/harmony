<script lang="ts">
  import { linkedGifSources } from '../lib/linked-gif';

  interface Props {
    url: string;
    contentType: string;
    mode: 'store' | 'link' | undefined;
  }

  let { url, contentType, mode }: Props = $props();

  const sources = $derived(linkedGifSources(mode, url, contentType));
  /** Which source is showing: 0 the first, 1 the fallback, 2 none worked. */
  let stage = $state(0);
  const src = $derived(stage === 0 ? sources.primary : stage === 1 ? sources.fallback : null);

  function failed(): void {
    stage = stage === 0 && sources.fallback ? 1 : 2;
  }
</script>

<!--
  A gif the message links to. It is drawn from the remote host while the instance
  links, and from this server's own copy while it stores (or when the remote has
  gone). If nothing loads, the address itself is shown, which is what the message
  was before there was a picture.
-->
{#if src}
  <a class="embed-gif" href={url} target="_blank" rel="noreferrer noopener">
    {#if contentType.startsWith('video/')}
      <video {src} autoplay loop muted playsinline preload="metadata" onerror={failed}></video>
    {:else}
      <img {src} alt="" loading="lazy" referrerpolicy="no-referrer" onerror={failed} />
    {/if}
  </a>
{:else}
  <a class="embed-gif-link" href={url} target="_blank" rel="noreferrer noopener">{url}</a>
{/if}
