<script lang="ts">
  import { onMount } from 'svelte';
  import type { Attachment, GifFavorite, GifItem, GifSearchResult } from '@harmony/shared';
  import { ApiError } from '../lib/api';
  import { favoriteUrl, gifs, localUrl } from '../lib/gifs.svelte';
  import { meta } from '../lib/meta.svelte';
  import Icon from './Icon.svelte';

  let {
    onpick,
    onlink,
  }: {
    onpick: (attachment: Attachment) => void;
    /** Receives a checked gif address to send as text, when the instance links gifs instead of storing them. */
    onlink?: (url: string) => void;
  } = $props();

  /** How long typing settles before a search is asked for. */
  const SEARCH_DEBOUNCE_MS = 250;

  type Tab = 'favorites' | 'local' | 'klipy';
  /** The gifs somebody kept come first, the way they do in Discord. */
  let tab = $state<Tab>('favorites');
  let query = $state('');
  let error = $state<string | null>(null);
  /** The tile whose pick or heart is in flight, if any. */
  let busy = $state<string | null>(null);

  /** The hosted tab only exists once an instance has a key for it. */
  const hosted = $derived(meta.data?.klipyConfigured === true);

  interface Tile {
    key: string;
    url: string;
    label: string;
    favoriteId: string | null;
    ref: { attachmentId: string } | { favoriteId: string } | { url: string };
  }

  function favoriteTile(favorite: GifFavorite): Tile {
    return {
      key: `f-${favorite.id}`,
      url: favoriteUrl(favorite),
      label: favorite.filename,
      favoriteId: favorite.id,
      ref: { favoriteId: favorite.id },
    };
  }

  function localTile(item: GifItem): Tile {
    return {
      key: `l-${item.id}`,
      url: localUrl(item),
      label: item.filename,
      favoriteId: item.favoriteId,
      ref: { attachmentId: item.id },
    };
  }

  function hostedTile(result: GifSearchResult): Tile {
    // A hosted gif has no hash here, so whether it is already saved is answered by
    // the address it was saved from.
    //
    // The tile is fetched through this server rather than from Klipy directly:
    // the instance's own policy only lets the page load its own images, and going
    // through here also keeps a browsing member's address away from the service.
    // That is why the grid uses a smaller size than the copy that gets kept.
    return {
      key: `h-${result.url}`,
      url: `/api/v1/embeds/media?url=${encodeURIComponent(result.previewUrl)}`,
      label: result.title || 'gif',
      favoriteId: gifs.bySourceUrl.get(result.url)?.id ?? null,
      ref: { url: result.url },
    };
  }

  const tiles = $derived(
    tab === 'favorites'
      ? gifs.favorites.map(favoriteTile)
      : tab === 'local'
        ? gifs.local.map(localTile)
        : gifs.remote.map(hostedTile),
  );
  const searching = $derived(query.trim().length > 0);
  const emptyMessage = $derived(
    tab === 'favorites'
      ? searching
        ? 'No saved gif matches that.'
        : 'Nothing saved yet. Press the heart on a gif to keep it.'
      : tab === 'local'
        ? searching
          ? 'No gif here matches that.'
          : 'Nothing here yet. Gifs posted in channels you can see turn up here.'
        : searching
          ? 'Nothing on Klipy matches that.'
          : 'Klipy returned nothing. Try a search.',
  );

  onMount(() => {
    void gifs.loadFavorites();
  });

  // Waits for typing to settle, and follows the tab: switching to a tab is what
  // asks for that tab's gifs the first time and after a search, rather than three
  // lists all being fetched when the picker opens.
  $effect(() => {
    const settled = query;
    const active = tab;
    const timer = setTimeout(() => {
      if (active === 'local') void gifs.searchLocal(settled);
      else if (active === 'klipy') void gifs.searchRemote(settled);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  async function pick(tile: Tile): Promise<void> {
    busy = tile.key;
    error = null;
    try {
      // In link mode a hosted gif is not downloaded: the server checks its address
      // and the member sends that as the message. Saved and local gifs are already
      // stored here and still go in as attachments.
      if ('url' in tile.ref && onlink && meta.data?.gifStorage === 'link') {
        onlink(await gifs.link(tile.ref.url));
      } else {
        onpick(await gifs.pick(tile.ref));
      }
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = null;
    }
  }

  async function toggleFavorite(tile: Tile): Promise<void> {
    busy = tile.key;
    error = null;
    try {
      if (tile.favoriteId !== null) await gifs.forget(tile.favoriteId);
      else if ('attachmentId' in tile.ref) await gifs.save({ attachmentId: tile.ref.attachmentId });
      else if ('url' in tile.ref) await gifs.save({ url: tile.ref.url });
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = null;
    }
  }
</script>

<div class="gif-picker">
  <div class="emoji-picker-head">
    <input
      class="emoji-search"
      type="search"
      bind:value={query}
      placeholder="Search gifs"
      aria-label="Search gifs"
      autocomplete="off"
    />
    <div class="emoji-tabs">
      <button
        type="button"
        class="emoji-tab"
        class:active={tab === 'favorites'}
        aria-pressed={tab === 'favorites'}
        onclick={() => (tab = 'favorites')}
      >
        Favorites
      </button>
      <button
        type="button"
        class="emoji-tab"
        class:active={tab === 'local'}
        aria-pressed={tab === 'local'}
        onclick={() => (tab = 'local')}
      >
        This server
      </button>
      {#if hosted}
        <button
          type="button"
          class="emoji-tab"
          class:active={tab === 'klipy'}
          aria-pressed={tab === 'klipy'}
          onclick={() => (tab = 'klipy')}
        >
          Klipy
        </button>
      {/if}
    </div>
  </div>

  <div class="gif-body">
    {#if error}<p class="form-error">{error}</p>{/if}

    {#if tab === 'klipy' && gifs.remoteLoading && tiles.length === 0}
      <p class="muted emoji-empty">Searching…</p>
    {:else if tiles.length === 0}
      <p class="muted emoji-empty">{emptyMessage}</p>
    {:else}
      <div class="gif-grid">
        {#each tiles as tile (tile.key)}
          <div class="gif-tile">
            <button
              type="button"
              class="gif-send"
              title="Send this gif"
              disabled={busy === tile.key}
              onclick={() => pick(tile)}
            >
              <img src={tile.url} alt={tile.label} loading="lazy" />
            </button>
            <button
              type="button"
              class="gif-heart"
              class:on={tile.favoriteId !== null}
              aria-pressed={tile.favoriteId !== null}
              title={tile.favoriteId !== null ? 'Remove from favorites' : 'Add to favorites'}
              disabled={busy === tile.key}
              onclick={() => toggleFavorite(tile)}
            >
              {#if tile.favoriteId !== null}
                <Icon name="heart-filled" size={16} />
              {:else}
                <Icon name="heart" size={16} />
              {/if}
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
