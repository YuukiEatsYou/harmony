<script lang="ts">
  import type { Message, MessageListResponse } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { avatarUrl, initial } from '../lib/avatar';
  import { chat } from '../lib/chat.svelte';
  import { members } from '../lib/members.svelte';
  import {
    FILTER_KEYS,
    activeToken,
    applySuggestion,
    buildSearchParams,
    filterLabel,
    mergeFilters,
    parseSearchInput,
    suggestFor,
    type FilterKey,
    type SearchFilter,
    type Suggestion,
  } from '../lib/search-query';
  import { tick } from 'svelte';

  let { onclose }: { onclose: () => void } = $props();

  /** How many matches a page holds, and how long typing settles before searching. */
  const pageSize = 25;
  const debounceMs = 300;

  let term = $state('');
  /** Filters typed as from:alice and finished, shown as chips above the results. */
  let chips = $state<SearchFilter[]>([]);
  let caret = $state(0);
  let highlighted = $state(-1);
  let listDismissed = $state(false);
  let results = $state<Message[]>([]);
  let searched = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let searchInput = $state<HTMLInputElement | null>(null);

  let debounce: ReturnType<typeof setTimeout> | null = null;

  const hasMore = $derived(results.length >= pageSize);
  /**
   * The text and filters as they would be searched: the chips, plus any token
   * typed in the box (even an unfinished one, which is only taken once the
   * search actually runs).
   */
  const typed = $derived(parseSearchInput(term, true));
  const searchText = $derived(typed.text);
  const request = $derived(buildSearchParams(typed.text, mergeFilters(chips, typed.filters)));
  /** A term on its own, or a filter on its own, is enough to search. */
  const canSearch = $derived(request.searchable);
  const filteringOnly = $derived(searchText.length === 0 && canSearch);

  const active = $derived(activeToken(term, caret));
  const suggestions = $derived(
    active && !listDismissed
      ? suggestFor(active, { members: members.list, channels: chat.channels })
      : [],
  );
  const listOpen = $derived(suggestions.length > 0);
  /** A filter still being typed that does not read yet, such as half a date. */
  const typingFilter = $derived(active !== null && request.problems.length > 0);

  function fail(cause: unknown): void {
    error = cause instanceof ApiError ? cause.message : String(cause);
  }

  /** Heading shown above a result, e.g. the channel it lives in. */
  function channelName(message: Message): string {
    return chat.channels.find((channel) => channel.id === message.channelId)?.name ?? 'a channel';
  }

  function authorName(message: Message): string {
    return message.author?.displayName ?? message.author?.username ?? 'Deleted user';
  }

  /**
   * Splits a message into the parts a highlight should wrap, matching the search
   * term case-insensitively. Svelte escapes the text, so this is safe.
   */
  function highlightParts(content: string): Array<{ text: string; match: boolean }> {
    const needle = searchText.toLowerCase();
    if (needle.length === 0) return [{ text: content, match: false }];

    const parts: Array<{ text: string; match: boolean }> = [];
    const haystack = content.toLowerCase();
    let cursor = 0;
    while (cursor < content.length) {
      const found = haystack.indexOf(needle, cursor);
      if (found === -1) break;
      if (found > cursor) parts.push({ text: content.slice(cursor, found), match: false });
      parts.push({ text: content.slice(found, found + needle.length), match: true });
      cursor = found + needle.length;
    }
    if (cursor < content.length) parts.push({ text: content.slice(cursor), match: false });
    return parts.length > 0 ? parts : [{ text: content, match: false }];
  }

  function buildQuery(before?: Message): string {
    const query = new URLSearchParams(request.params);
    query.set('limit', String(pageSize));
    if (before) {
      query.set('before', before.createdAt);
      query.set('beforeId', before.id);
    }
    return query.toString();
  }

  /**
   * Runs the search. One started by typing pausing leaves alone a filter that is
   * still under the caret: `after:2024-05-0` is a date on its way, not a mistake,
   * so it waits for Enter or more typing rather than wiping the results.
   */
  async function search(fromTyping = false): Promise<void> {
    if (fromTyping && active && request.problems.length > 0) return;
    if (request.problems.length > 0) {
      results = [];
      searched = false;
      error = request.problems[0] ?? null;
      return;
    }
    if (!canSearch) {
      results = [];
      searched = false;
      error = null;
      return;
    }

    busy = true;
    error = null;
    try {
      const data = await api<MessageListResponse>(`/search?${buildQuery()}`);
      results = data.messages;
      searched = true;
    } catch (cause) {
      results = [];
      searched = false;
      fail(cause);
    } finally {
      busy = false;
    }
  }

  /** Loads the page of matches older than the oldest one already shown. */
  async function loadMore(): Promise<void> {
    const oldest = results[results.length - 1];
    if (!oldest) return;

    busy = true;
    error = null;
    try {
      const data = await api<MessageListResponse>(`/search?${buildQuery(oldest)}`);
      results = [...results, ...data.messages];
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  /**
   * Moves finished filter tokens (from:alice followed by a space) out of the box
   * and into chips. A token still being typed is left alone.
   */
  function takeFilters(final = false): void {
    const parsed = parseSearchInput(term, final);
    if (parsed.filters.length === 0) return;
    chips = mergeFilters(chips, parsed.filters);
    term = parsed.text.length > 0 && !final ? `${parsed.text} ` : parsed.text;
    caret = term.length;
  }

  function syncCaret(): void {
    caret = searchInput?.selectionStart ?? term.length;
  }

  function removeChip(filter: SearchFilter): void {
    chips = chips.filter((chip) => chip !== filter);
    onFilter();
    searchInput?.focus();
  }

  async function choose(suggestion: Suggestion): Promise<void> {
    if (!active) return;
    const applied = applySuggestion(term, active, suggestion);
    term = applied.text;
    highlighted = -1;
    await tick();
    searchInput?.setSelectionRange(applied.caret, applied.caret);
    caret = applied.caret;
    takeFilters();
    onFilter();
  }

  /** Arrow keys walk the suggestions, Tab or Enter take one, Escape puts them away. */
  function onKeydown(event: KeyboardEvent): void {
    if (!listOpen) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlighted = (highlighted + 1) % suggestions.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlighted = highlighted <= 0 ? suggestions.length - 1 : highlighted - 1;
    } else if (event.key === 'Tab' || (event.key === 'Enter' && highlighted >= 0)) {
      event.preventDefault();
      const picked = suggestions[highlighted >= 0 ? highlighted : 0];
      if (picked) void choose(picked);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      listDismissed = true;
    }
  }

  /** Restarts the settle timer, so a search runs once typing pauses. */
  function onInput(): void {
    syncCaret();
    listDismissed = false;
    highlighted = -1;
    takeFilters();
    if (debounce) clearTimeout(debounce);
    // While a suggestion list is up the token under the caret is unfinished, so
    // wait for it rather than searching for half a name.
    if (listOpen) return;
    debounce = setTimeout(() => {
      debounce = null;
      void search(true);
    }, debounceMs);
  }

  /** Filters apply at once rather than waiting for more typing. */
  function onFilter(): void {
    if (debounce) clearTimeout(debounce);
    takeFilters(true);
    void search();
  }

  /**
   * Starts a filter from its button: the key goes at the end of the box with the
   * caret after it, so the suggestion list for it opens straight away.
   */
  async function startFilter(key: FilterKey): Promise<void> {
    const base = term.trimEnd();
    term = `${base}${base ? ' ' : ''}${key}:`;
    listDismissed = false;
    highlighted = -1;
    await tick();
    searchInput?.focus();
    searchInput?.setSelectionRange(term.length, term.length);
    caret = term.length;
  }

  /** Puts the suggestions away once focus leaves the box and its list. */
  function onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && (event.currentTarget as HTMLElement).contains(next)) return;
    listDismissed = true;
  }

  async function open(message: Message): Promise<void> {
    await chat.jumpToMessage(message.channelId, message);
    onclose();
  }

  $effect(() => {
    searchInput?.focus();
  });
</script>

<div class="admin-overlay">
  <div class="admin search-panel">
    <!-- The box and its filters stay put; only the results scroll. -->
    <div class="search-top">
      <div class="search-head">
        <h3>Search messages</h3>
        <button type="button" onclick={onclose}>Close</button>
      </div>

      <form class="inline" onsubmit={(event) => { event.preventDefault(); onFilter(); }}>
        <div class="search-box" onfocusout={onFocusOut}>
          <input
            bind:this={searchInput}
            bind:value={term}
            oninput={onInput}
            onkeydown={onKeydown}
            onkeyup={syncCaret}
            onclick={() => { syncCaret(); listDismissed = false; }}
            onfocus={() => (listDismissed = false)}
            placeholder="Search messages"
            aria-label="Search messages"
            autocomplete="off"
            role="combobox"
            aria-expanded={listOpen}
            aria-controls="search-suggestions"
            aria-autocomplete="list"
            aria-activedescendant={highlighted >= 0 ? `search-suggestion-${highlighted}` : undefined}
          />
          {#if listOpen}
            <ul class="autocomplete search-suggestions" id="search-suggestions" role="listbox" aria-label="Filter suggestions">
              {#each suggestions as suggestion, index (suggestion.value)}
                <li role="presentation">
                  <button
                    type="button"
                    id={`search-suggestion-${index}`}
                    class="autocomplete-item"
                    class:active={index === highlighted}
                    role="option"
                    aria-selected={index === highlighted}
                    tabindex="-1"
                    onmousedown={(event) => event.preventDefault()}
                    onclick={() => choose(suggestion)}
                  >
                    <span class="autocomplete-name">{suggestion.label}</span>
                    {#if suggestion.detail}<span class="autocomplete-detail">{suggestion.detail}</span>{/if}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
        <button type="submit" disabled={busy}>Search</button>
      </form>

      <!--
        The filters are typed tokens (from:alice) and these buttons only start
        one, so there is a single way to narrow a search and one place, the
        chips, that shows what is applied.
      -->
      <div class="search-filter-keys" role="group" aria-label="Add a filter">
        {#each FILTER_KEYS as key (key)}
          <button type="button" class="search-filter-key" onclick={() => startFilter(key)}>{key}:</button>
        {/each}
      </div>

      {#if chips.length > 0}
        <ul class="search-chips" aria-label="Active filters">
          {#each chips as chip (`${chip.key}:${chip.value}`)}
            <li class="search-chip">
              <span>{filterLabel(chip)}</span>
              <button type="button" aria-label={`Remove filter ${filterLabel(chip)}`} onclick={() => removeChip(chip)}>×</button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if error}<p class="form-error">{error}</p>{/if}
    </div>

    <div class="search-scroll">
      <!-- Half a date keeps the last results on screen until it reads as one. -->
      {#if !canSearch && !(typingFilter && searched)}
        <p class="muted">
          Search across every channel you can see. Pick a filter above or type one:
          <code>from:name</code>, <code>mentions:name</code>, <code>in:channel</code>, <code>has:image</code> (or video,
          gif, file, link, embed, sticker, pin), <code>before:</code>, <code>after:</code> or <code>on:</code> a date like
          2024-05-01, today or yesterday. Quote names with spaces: <code>from:"Some Name"</code>.
        </p>
      {:else if busy && results.length === 0}
        <p class="muted">Searching…</p>
      {:else if !searched}
        <p class="muted">Press Enter to search.</p>
      {:else if results.length === 0}
        <p class="muted">
          {#if filteringOnly}
            Nothing found for that filter.
          {:else}
            No messages match “{searchText}”.
          {/if}
        </p>
      {:else}
        <p class="muted">
          {results.length}{#if hasMore}+{/if}
          {filteringOnly ? 'message' : 'match'}{results.length === 1 ? '' : 'es'}, newest first.
        </p>
        <ul class="search-results">
          {#each results as message (message.id)}
            <li>
              <button type="button" class="search-result" onclick={() => open(message)}>
                <span class="search-result-head">
                  {#if avatarUrl(message.author)}
                    <img class="avatar small" src={avatarUrl(message.author)} alt="" loading="lazy" />
                  {:else}
                    <span class="avatar small fallback">{initial(message.author)}</span>
                  {/if}
                  <strong>{authorName(message)}</strong>
                  <span class="muted">in #{channelName(message)}</span>
                  <time class="muted">{new Date(message.createdAt).toLocaleString()}</time>
                </span>
                <span class="search-result-text">{#each highlightParts(message.content) as part, index (index)}{#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
                {#if message.attachments.length > 0}
                  <span class="muted">
                    {message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'}
                  </span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>

        {#if hasMore}
          <div class="editor-actions">
            <button type="button" onclick={loadMore} disabled={busy}>
              {busy ? 'Loading…' : 'Load older matches'}
            </button>
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>
