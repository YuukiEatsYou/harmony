import type { NameColor, NameColorListResponse } from '@harmony/shared';
import { api } from './api';

/**
 * The username colors the administrators offer, as the server lists them. Fetched
 * on demand: the profile picker and the admin Colors tab are the only places that
 * need the palette, so a session that opens neither never pays for it. The color
 * a member actually wears rides on `User.nameColor`, so rendering a name never
 * waits on this.
 */
class NameColors {
  list = $state<NameColor[]>([]);
  loaded = $state(false);

  /** Loads the palette once, or again when `force` is set after an edit. */
  async load(force = false): Promise<NameColor[]> {
    if (this.loaded && !force) return this.list;
    try {
      this.list = (await api<NameColorListResponse>('/name-colors')).nameColors;
      this.loaded = true;
    } catch {
      // Keep whatever we had; the caller reports its own error.
    }
    return this.list;
  }

  reset(): void {
    this.list = [];
    this.loaded = false;
  }
}

export const nameColors = new NameColors();
