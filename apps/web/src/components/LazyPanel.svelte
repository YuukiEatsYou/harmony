<script lang="ts" generics="T">
  import { onMount, tick, type Snippet } from 'svelte';
  import { SLOW_LOAD_MS, type Lazy } from '../lib/lazy';
  import { trapFocus } from '../lib/shortcuts.svelte';

  /**
   * Draws a panel that is fetched on first use (see lib/lazy-panels.ts). The
   * caller says how to draw it once it is here, through `children`, which is
   * handed the loaded component:
   *
   *   <LazyPanel module={adminPanel} label="the admin panel" onclose={...}>
   *     {#snippet children(AdminPanel)}<AdminPanel />{/snippet}
   *   </LazyPanel>
   *
   * While it is on its way nothing is drawn, so a fast fetch simply opens the
   * panel with its own entrance, and only a slow one shows a small loading line.
   * A fetch that fails, typically because an update replaced the files this page
   * was built against, says so and offers a reload instead of leaving the click
   * to do nothing.
   */
  let {
    module,
    label,
    onclose,
    children,
  }: {
    module: Lazy<T>;
    /** What is being opened, as it reads after "Loading" ("the admin panel"). */
    label: string;
    /** Closes the panel, which is what the error's Close and Escape do. */
    onclose: () => void;
    children: Snippet<[T]>;
  } = $props();

  let loaded = $state.raw<T | null>(null);
  let failed = $state(false);
  let slow = $state(false);
  /**
   * Whatever had focus when the panel was asked for, to hand it back if the
   * error is closed. A panel that does load looks after focus itself.
   */
  let returnTo: HTMLElement | null = null;

  // Fetched for an earlier opening: drawn straight away, with no pending pass.
  const ready = $derived(loaded ?? module.current);

  onMount(() => {
    if (module.current !== null) return;
    const focused = document.activeElement;
    returnTo = focused instanceof HTMLElement && focused !== document.body ? focused : null;

    const timer = setTimeout(() => (slow = true), SLOW_LOAD_MS);
    module
      .load()
      .then(
        (value) => {
          loaded = value;
        },
        () => {
          failed = true;
        },
      )
      .finally(() => clearTimeout(timer));
    return () => clearTimeout(timer);
  });

  /** Closes from the error, then hands focus back to where it was once this has gone. */
  async function close(): Promise<void> {
    const target = returnTo;
    onclose();
    await tick();
    // The opener may have gone meanwhile, such as a menu that closed itself.
    if (target?.isConnected) target.focus({ preventScroll: true });
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    void close();
  }
</script>

{#if ready !== null}
  {@render children(ready)}
{:else if failed}
  <!--
    The admin overlay class is what the keyboard layer looks for to stay quiet
    under a panel, so Alt and an arrow cannot switch channels out of sight
    behind this either.
  -->
  <div class="admin-overlay">
    <button class="overlay-backdrop" type="button" tabindex="-1" aria-label="Close" onclick={close}></button>
    <div
      class="lazy-error"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lazy-error-title"
      aria-describedby="lazy-error-text"
      tabindex="-1"
      onkeydown={onKeydown}
      use:trapFocus
    >
      <h3 id="lazy-error-title">Could not open {label}</h3>
      <p id="lazy-error-text" class="status err">
        It did not download. Harmony may have been updated since this page was opened, or the connection
        dropped; reloading the page fixes either, once you are back online.
      </p>
      <div class="editor-actions">
        <button type="button" data-autofocus onclick={() => window.location.reload()}>Reload</button>
        <button type="button" class="ghost" onclick={close}>Close</button>
      </div>
    </div>
  </div>
{:else if slow}
  <div class="lazy-loading" role="status">
    <span class="lazy-spinner" aria-hidden="true"></span>
    Loading {label}…
  </div>
{/if}

<style>
  .lazy-error {
    position: relative;
    z-index: 1;
    margin: auto;
    /* The overlay drops its padding on a phone, so the card keeps its own gutter. */
    width: min(420px, calc(100% - 32px));
    padding: 1.25rem 1.4rem;
    border: 1px solid var(--h-glass-border);
    border-radius: var(--h-radius-xl);
    background: var(--h-bg-elevated);
    box-shadow: var(--h-shadow-xl);
    animation: h-scale-in var(--h-duration-slow) var(--h-ease-spring) both;
  }

  .lazy-error:focus {
    outline: none;
  }

  h3 {
    margin: 0;
  }

  .lazy-error .status {
    margin: 0.9rem 0 1.1rem;
  }

  .lazy-error .editor-actions {
    justify-content: flex-end;
  }

  /*
   * Opaque rather than glass on purpose: the spinner turns continuously, and an
   * animation inside a backdrop-filter makes Firefox repaint the whole blurred
   * surface every frame.
   */
  .lazy-loading {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 100;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    max-width: calc(100vw - 32px);
    padding: 0.6rem 1rem;
    translate: -50% -50%;
    border: 1px solid var(--h-glass-border);
    border-radius: var(--h-radius-full);
    background: var(--h-bg-elevated);
    box-shadow: var(--h-shadow-lg);
    color: var(--h-text-muted);
    font-size: var(--h-text-sm);
    white-space: nowrap;
    pointer-events: none;
    animation: h-fade-in var(--h-duration) var(--h-ease) both;
  }

  .lazy-spinner {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    border: 2px solid var(--h-border-strong);
    border-top-color: var(--h-accent);
    border-radius: 50%;
    will-change: transform;
    animation: lazy-spin 0.8s linear infinite;
  }

  @keyframes lazy-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
