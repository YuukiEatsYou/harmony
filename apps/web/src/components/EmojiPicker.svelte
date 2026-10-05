<script lang="ts">
  import { emojis } from '../lib/emojis.svelte';
  import { emojiUsage } from '../lib/emoji-usage.svelte';
  import { filterByName, filterUnicodeGroups, loadUnicodeEmoji, type UnicodeEmojiGroup } from '../lib/unicode-emoji';

  let { onpick }: { onpick: (emoji: string, emojiId: string | null) => void } = $props();

  /** The most common reactions, within reach of both tabs rather than a scroll away. */
  const quickReactions = ['👍', '❤️', '😂', '🎉', '😮', '😢'];

  /** A little daylight between the picker and the keyboard. */
  const REVEAL_MARGIN = 12;

  type Tab = 'recent' | 'server' | 'unicode';
  /**
   * What this member uses most comes first when there is any history; failing
   * that the instance's own emoji, which are the ones people came here for.
   */
  let tab = $state<Tab>(emojiUsage.ranked.length > 0 ? 'recent' : 'server');
  let query = $state('');

  let unicodeGroups = $state<UnicodeEmojiGroup[]>([]);
  let unicodeFailed = $state(false);

  // Started as soon as the picker opens, so the tab is usually already filled by
  // the time anyone reaches for it. The module keeps the result, so this is a
  // background load once per session rather than once per picker.
  void loadUnicodeEmoji()
    .then((groups) => {
      unicodeGroups = groups;
    })
    .catch(() => {
      unicodeFailed = true;
    });

  const serverMatches = $derived(filterByName(emojis.picker, query));
  const unicodeMatches = $derived(filterUnicodeGroups(unicodeGroups, query));

  /** Unicode names by character, so frequently used emoji can be searched too. */
  const unicodeNames = $derived(
    new Map(unicodeGroups.flatMap((group) => group.emojis.map((emoji) => [emoji.emoji, emoji.name] as const))),
  );
  const recentMatches = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    return emojiUsage.ranked.filter((used) =>
      !needle ? true : (used.emojiId ? used.emoji : (unicodeNames.get(used.emoji) ?? '')).toLowerCase().includes(needle),
    );
  });

  /** Searching is a different task from browsing, so the shortcuts step aside. */
  const searching = $derived(query.trim().length > 0);

  let picker = $state<HTMLDivElement | null>(null);

  /**
   * Keeps the picker clear of the keyboard.
   *
   * A soft keyboard drawn over the page leaves no room for a field near the
   * bottom, and the browser's own scroll-into-view has nothing to work with: the
   * shell is a fixed-height column that the page itself cannot scroll. The
   * picker's scroll container can, though, so the shortfall against the part of
   * the page actually on screen is measured and handed to that.
   */
  function reveal(): void {
    const viewport = window.visualViewport;
    const element = picker;
    if (!viewport || !element) return;

    const covered = element.getBoundingClientRect().bottom - (viewport.height + viewport.offsetTop);
    if (covered <= 0) return;

    // The nearest ancestor that actually scrolls: the message list when reacting
    // to something, and nothing at all when the picker sits in the composer, in
    // which case the layout has already moved and there is nothing to do.
    let scroller = element.parentElement;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
    scroller?.scrollBy({ top: covered + REVEAL_MARGIN });
  }

  // Only while the picker is open, and cleaned up with it. The keyboard animates
  // in, so the useful measurements are the later ones; the call here covers a
  // picker opened while a keyboard is already up.
  $effect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    viewport.addEventListener('resize', reveal);
    reveal();
    return () => viewport.removeEventListener('resize', reveal);
  });
</script>

<div class="emoji-picker" bind:this={picker}>
  <div class="emoji-picker-head">
    <input
      class="emoji-search"
      type="search"
      bind:value={query}
      placeholder="Search emoji"
      aria-label="Search emoji"
      autocomplete="off"
    />
    <div class="emoji-tabs">
      {#if emojiUsage.ranked.length > 0}
        <button
          type="button"
          class="emoji-tab"
          class:active={tab === 'recent'}
          aria-pressed={tab === 'recent'}
          onclick={() => (tab = 'recent')}
        >
          Frequent
        </button>
      {/if}
      <button
        type="button"
        class="emoji-tab"
        class:active={tab === 'server'}
        aria-pressed={tab === 'server'}
        onclick={() => (tab = 'server')}
      >
        Server
      </button>
      <button
        type="button"
        class="emoji-tab"
        class:active={tab === 'unicode'}
        aria-pressed={tab === 'unicode'}
        onclick={() => (tab = 'unicode')}
      >
        Unicode
      </button>
    </div>
  </div>

  <div class="emoji-picker-body">
    {#if !searching}
      <div class="emoji-quick">
        {#each quickReactions as quick (quick)}
          <button type="button" class="emoji-option" onclick={() => onpick(quick, null)}>{quick}</button>
        {/each}
      </div>
    {/if}

    {#if tab === 'recent' && emojiUsage.ranked.length > 0}
      {#if recentMatches.length === 0}
        <p class="muted emoji-empty">No frequently used emoji match that.</p>
      {:else}
        <span class="emoji-group-name">Frequently used</span>
        <div class="emoji-options">
          {#each recentMatches as used (used.emojiId ?? used.emoji)}
            <button
              type="button"
              class="emoji-option"
              title={used.emojiId ? used.emoji : (unicodeNames.get(used.emoji) ?? used.emoji)}
              onclick={() => onpick(used.emoji, used.emojiId)}
            >
              {#if used.emojiId}
                <img src={`/api/v1/emojis/${used.emojiId}`} alt={used.emoji} />
              {:else}
                {used.emoji}
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    {:else if tab !== 'unicode'}
      {#if serverMatches.length === 0}
        <p class="muted emoji-empty">
          {searching ? 'No server emoji match that.' : 'This server has no custom emoji yet.'}
        </p>
      {:else}
        <div class="emoji-options">
          {#each serverMatches as emoji (emoji.id)}
            <button
              type="button"
              class="emoji-option"
              title={`:${emoji.name}:`}
              onclick={() => onpick(`:${emoji.name}:`, emoji.id)}
            >
              <img src={`/api/v1/emojis/${emoji.id}`} alt={emoji.name} />
            </button>
          {/each}
        </div>
      {/if}
    {:else if unicodeFailed}
      <p class="muted emoji-empty">Could not load the unicode emoji list. Check your connection.</p>
    {:else if unicodeGroups.length === 0}
      <p class="muted emoji-empty">Loading…</p>
    {:else if unicodeMatches.length === 0}
      <p class="muted emoji-empty">No emoji match that.</p>
    {:else}
      {#each unicodeMatches as group (group.name)}
        <div>
          <!--
            The heading is dropped while searching: a handful of results split
            across nine headings reads worse than one plain list.
          -->
          {#if !searching}<span class="emoji-group-name">{group.name}</span>{/if}
          <div class="emoji-options">
            {#each group.emojis as emoji (emoji.emoji)}
              <button type="button" class="emoji-option" title={emoji.name} onclick={() => onpick(emoji.emoji, null)}>
                {emoji.emoji}
              </button>
            {/each}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>
