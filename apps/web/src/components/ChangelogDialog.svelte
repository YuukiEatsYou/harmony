<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { changelog } from '../lib/changelog.svelte';
  import { modalLayers } from '../lib/modal-layers.svelte';
  import { formatChangelogDate } from '../lib/changelog';
  import { session } from '../lib/session.svelte';
  import { trapFocus } from '../lib/shortcuts.svelte';

  /*
   * The "What's new" dialog. After an update, a member opening Harmony is shown
   * the newest release's notes once, and About opens them again on request.
   * Mounted only while someone is signed in, so it never appears over the
   * sign-in screen.
   */

  /**
   * True while something that has to come first is on screen or about to be,
   * which is the owner's setup wizard. Notes found meanwhile wait for it.
   */
  let { held = false }: { held?: boolean } = $props();

  // Each member signed in is asked about once; a later change to their profile
  // replaces the user object but is not a new sign-in.
  $effect(() => {
    const userId = session.user?.id;
    if (userId) untrack(() => void changelog.check(userId));
  });

  $effect(() => {
    if (changelog.due && !held) untrack(() => changelog.showDue());
  });

  onMount(() => () => changelog.reset());

  // Counted as open over the chat while it is, so back closes it like any other dialog.
  $effect(() => {
    if (changelog.shown !== null) return untrack(() => modalLayers.add(() => void changelog.close()));
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      void changelog.close();
    }
    // The chat underneath waits for the dialog, so its shortcuts (the quick
    // switcher, the channel arrows) cannot act out of sight behind it.
    event.stopPropagation();
  }
</script>

{#if changelog.shown}
  {@const entry = changelog.shown}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="cl-layer" onkeydown={onKeydown}>
    <button
      class="cl-backdrop"
      type="button"
      tabindex="-1"
      aria-label="Close what's new"
      onclick={() => changelog.close()}
    ></button>

    <div
      class="cl-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cl-title"
      aria-describedby="cl-items"
      use:trapFocus
    >
      <p class="cl-release">
        Version {entry.version} · <time datetime={entry.date}>{formatChangelogDate(entry.date)}</time>
      </p>
      <h2 id="cl-title">{entry.title}</h2>

      <ul id="cl-items" class="cl-items">
        {#each entry.items as item, index (index)}
          <li>{item}</li>
        {/each}
      </ul>

      <div class="cl-actions">
        <button type="button" class="primary" data-autofocus onclick={() => changelog.close()}>Got it</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .cl-layer {
    position: fixed;
    inset: 0;
    /* Above the admin overlay, since About opens it from there, and below the lightbox. */
    z-index: 120;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }

  .cl-backdrop {
    position: absolute;
    inset: 0;
    margin: 0;
    padding: 0;
    border: none;
    border-radius: 0;
    background: color-mix(in srgb, var(--h-bg-deep) 72%, transparent);
    box-shadow: none;
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    cursor: default;
    animation: overlay-in var(--h-duration) var(--h-ease);
  }

  /* A button, so the shared hover and active styles are pinned off it. The
     :not(:disabled) keeps this more specific than button:hover:not(:disabled),
     or the whole scrim fills with the accent color under the pointer. */
  .cl-backdrop:hover:not(:disabled),
  .cl-backdrop:active:not(:disabled) {
    background: color-mix(in srgb, var(--h-bg-deep) 72%, transparent);
    box-shadow: none;
    transform: none;
  }

  /* A column whose list alone scrolls when the notes are long, so the version
     and the title stay in view above it and Got it below. Focus starts on Got
     it, and with the whole dialog scrolling that would open it at the bottom. */
  .cl-dialog {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    width: min(440px, 100%);
    max-height: 90dvh;
    overflow: hidden;
    padding: 1.25rem 1.4rem;
    border: 1px solid var(--h-glass-border);
    border-radius: var(--h-radius-xl);
    background: var(--h-bg-elevated);
    box-shadow: var(--h-shadow-xl);
    animation: modal-in var(--h-duration-slow) var(--h-ease-out);
  }

  .cl-release {
    margin: 0;
    color: var(--h-text-faint);
    font-size: var(--h-text-sm);
    font-weight: 600;
  }

  /* The title is the news itself rather than a section label, so it drops the
     global h2's small muted capitals and reads as a heading. */
  h2 {
    margin: 0.2rem 0 0;
    color: var(--h-text);
    font-size: 1.3rem;
    letter-spacing: -0.02em;
    text-transform: none;
  }

  .cl-items {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    min-height: 0;
    margin: 1rem 0 0;
    /* The last stretch fades out, which shows a cut-off list has more below.
       It fades the padding only once the list is scrolled to its end. */
    padding: 0 0 1rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    list-style: none;
    -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 1rem), transparent);
    mask-image: linear-gradient(to bottom, #000 calc(100% - 1rem), transparent);
  }

  .cl-items li {
    position: relative;
    padding-left: 1.1rem;
    color: var(--h-text);
    font-size: var(--h-text-md);
    line-height: 1.45;
  }

  /* An accent dot rather than the browser's bullet, so the list reads as the instance's own. */
  .cl-items li::before {
    content: '';
    position: absolute;
    top: 0.55em;
    left: 0.15rem;
    width: 6px;
    height: 6px;
    border-radius: var(--h-radius-full);
    background: var(--h-accent);
  }

  .cl-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 0.4rem;
  }
</style>
