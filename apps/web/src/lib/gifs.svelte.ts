import type {
  Attachment,
  GifFavorite,
  GifFavoriteListResponse,
  GifLinkResponse,
  GifSearchResponse,
  GifSearchResult,
  ServerGifItem,
  ServerGifListResponse,
} from '@harmony/shared';
import { api } from './api';

/**
 * The picker's data. Both tabs are kept here so a heart pressed on one is
 * reflected on the other: a gif saved from the local list shows as saved when the
 * favorites list is next opened, without a refetch.
 */
class GifState {
  favorites = $state<GifFavorite[]>([]);
  remote = $state<GifSearchResult[]>([]);
  /** The Server tab: curated gifs first, then the auto-collected ones. */
  server = $state<ServerGifItem[]>([]);
  /** Raised on SERVER_GIFS_UPDATE, so an open admin section knows to refetch. */
  serverVersion = $state(0);
  /** The term the Server tab was last loaded for, so an update refetches the same view. */
  #serverQuery = '';
  #serverLoaded = false;
  remoteLoading = $state(false);
  /** Saved gifs by content hash, so a heart anywhere can tell whether it is on. */
  byHash = $derived(new Map(this.favorites.map((favorite) => [favorite.hash, favorite])));
  /**
   * Saved gifs by the address they came from. A hosted gif has no hash until it is
   * fetched, so this is what tells whether one already saved is the one on screen.
   */
  bySourceUrl = $derived(
    new Map(
      this.favorites
        .filter((favorite) => favorite.sourceUrl !== null)
        .map((favorite) => [favorite.sourceUrl as string, favorite]),
    ),
  );
  /** Raised with each search, so a slower earlier one cannot overwrite it. */
  #search = 0;

  async loadFavorites(): Promise<void> {
    try {
      this.favorites = (await api<GifFavoriteListResponse>('/gifs/favorites')).favorites;
    } catch {
      // Not signed in or offline — leave the list empty.
    }
  }

  async searchServer(query: string): Promise<void> {
    const search = ++this.#search;
    this.#serverQuery = query;
    try {
      const params = new URLSearchParams();
      if (query.trim().length > 0) params.set('q', query.trim());
      const suffix = params.size > 0 ? `?${params.toString()}` : '';
      const body = await api<ServerGifListResponse>(`/gifs/server${suffix}`);
      if (search !== this.#search) return;
      this.server = body.gifs;
      this.#serverLoaded = true;
    } catch {
      // Leave whatever was there.
    }
  }

  /** The administrators changed the server gifs: refresh what is on screen. */
  serverChanged(): void {
    this.serverVersion += 1;
    if (this.#serverLoaded) void this.searchServer(this.#serverQuery);
  }

  /** Takes a curated gif into the message being written; returns the pending attachment. */
  pickServer(id: string): Promise<Attachment> {
    return api<Attachment>(`/gifs/server/${id}/pick`, { method: 'POST' });
  }

  /** The hosted service's gifs, searched by the server so its key stays there. */
  async searchRemote(query: string): Promise<void> {
    const search = ++this.#search;
    this.remoteLoading = true;
    try {
      const params = new URLSearchParams();
      if (query.trim().length > 0) params.set('q', query.trim());
      const suffix = params.size > 0 ? `?${params.toString()}` : '';
      const body = await api<GifSearchResponse>(`/gifs/klipy${suffix}`);
      if (search !== this.#search) return;
      this.remote = body.gifs;
    } catch {
      // Leave whatever was there.
    } finally {
      if (search === this.#search) this.remoteLoading = false;
    }
  }

  /** Keeps a gif, from this instance or from the hosted service, and marks it. */
  async save(ref: { attachmentId: string } | { url: string }): Promise<void> {
    const favorite = await api<GifFavorite>('/gifs/favorites', {
      method: 'POST',
      body: JSON.stringify(ref),
    });
    this.favorites = [favorite, ...this.favorites.filter((entry) => entry.id !== favorite.id)];
    this.server = this.server.map((item) =>
      item.hash === favorite.hash ? { ...item, favoriteId: favorite.id } : item,
    );
  }

  async forget(favoriteId: string): Promise<void> {
    await api(`/gifs/favorites/${favoriteId}`, { method: 'DELETE' });
    this.favorites = this.favorites.filter((entry) => entry.id !== favoriteId);
    this.server = this.server.map((item) => (item.favoriteId === favoriteId ? { ...item, favoriteId: null } : item));
  }

  /** Has the server check a hosted gif's address for linking; returns the address to send. */
  async link(url: string): Promise<string> {
    return (await api<GifLinkResponse>('/gifs/link', { method: 'POST', body: JSON.stringify({ url }) })).url;
  }

  /** Takes a gif into the message being written; returns the pending attachment. */
  pick(ref: { attachmentId: string } | { favoriteId: string } | { url: string }): Promise<Attachment> {
    return api<Attachment>('/gifs/pick', { method: 'POST', body: JSON.stringify(ref) });
  }
}

export const gifs = new GifState();

/** Where the picker loads each kind of gif from. */
export function favoriteUrl(favorite: GifFavorite): string {
  return `/api/v1/gifs/favorites/${favorite.id}/image`;
}
