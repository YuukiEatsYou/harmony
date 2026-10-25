/**
 * A part of the client that is fetched the first time it is wanted instead of
 * with the app, such as the admin panel or the setup wizard: most visits never
 * open them, so they are kept out of the first download, the same way the
 * highlighter and the unicode emoji set already are.
 */
export interface Lazy<T> {
  /**
   * What the import exported, once it has arrived, and null before. A panel
   * opened a second time reads this and is drawn at once, with no loading
   * state at all.
   */
  readonly current: T | null;
  /**
   * Fetches it, or joins the fetch already under way, so two openings in quick
   * succession make one request. A failure is not kept here, so the next
   * opening asks the browser again, but that is no promise of a second
   * download: Chromium remembers a module that failed to load for as long as
   * the page is open, and fails the same import again at once. A reload is what
   * reliably recovers, after a dropped connection as much as after an update
   * that replaced the files the page was built against, and it is what the
   * panel offers when this rejects.
   */
  load(): Promise<T>;
}

/** Wraps a dynamic import, written as `() => import('./Thing.svelte')`, so it runs once. */
export function lazy<T>(importer: () => Promise<{ default: T }>): Lazy<T> {
  let current: T | null = null;
  let pending: Promise<T> | null = null;

  return {
    get current() {
      return current;
    },
    load() {
      if (current !== null) return Promise.resolve(current);
      pending ??= importer().then(
        (module) => {
          current = module.default;
          return module.default;
        },
        (cause: unknown) => {
          pending = null;
          throw cause;
        },
      );
      return pending;
    },
  };
}

/**
 * How long a fetch may take before the loading line appears. On an ordinary
 * connection the panel arrives well inside this, and saying "Loading" for a
 * blink just before it opens reads as a flicker; on a slow one the line shows
 * that the click was heard.
 */
export const SLOW_LOAD_MS = 200;
