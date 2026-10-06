<script lang="ts">
  import type { Channel, User } from '@harmony/shared';
  import { avatarUrl, initial } from '../lib/avatar';
  import { chat } from '../lib/chat.svelte';
  import { members } from '../lib/members.svelte';
  import { rankSwitcher, type SwitcherResult } from '../lib/quick-switch';
  import { shortcuts, trapFocus } from '../lib/shortcuts.svelte';
  import { ui } from '../lib/ui.svelte';
  import Icon from './Icon.svelte';

  type Row = SwitcherResult<Channel, User>;

  let query = $state('');
  let highlight = $state(0);

  /*
   * Discord stand-ins are left out: they are only reachable through a bridged
   * channel, which is why the member list hides them everywhere else too.
   */
  const people = $derived(members.list.filter((user) => user.accountType !== 'ghost'));
  const results = $derived(
    rankSwitcher({
      query,
      categories: chat.categories,
      channels: chat.channels,
      members: people,
      recentChannelIds: shortcuts.recentChannelIds,
      activeChannelId: chat.activeChannelId,
    }),
  );
  // Clamped rather than reset, so a channel list refresh while the dialog is
  // open does not leave the highlight pointing past the end.
  const selected = $derived(Math.min(highlight, results.length - 1));
  const activeId = $derived(results[selected] ? optionId(results[selected]) : undefined);

  function optionId(row: Row): string {
    return `qs-option-${row.kind}-${row.id}`;
  }

  function nameOf(user: User): string {
    return user.displayName ?? user.username;
  }

  function choose(row: Row | undefined): void {
    if (!row) return;
    if (row.kind === 'channel') {
      void chat.selectChannel(row.id);
      ui.closeDrawers();
    } else {
      // A member opens their full profile, the same as clicking a name anywhere else.
      ui.openProfileViewer(row.member);
    }
    void shortcuts.close();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const count = results.length;
    if (event.key === 'ArrowDown' && count > 0) {
      event.preventDefault();
      highlight = (selected + 1) % count;
    } else if (event.key === 'ArrowUp' && count > 0) {
      event.preventDefault();
      highlight = (selected - 1 + count) % count;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(results[selected]);
    }
  }

  // Keep the highlighted row in view as the arrows walk past the visible ones.
  $effect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  });
</script>

<div class="qs-layer">
  <button
    class="qs-backdrop"
    type="button"
    tabindex="-1"
    aria-label="Close quick switcher"
    onclick={() => shortcuts.close()}
  ></button>

  <div class="qs-dialog" role="dialog" aria-modal="true" aria-labelledby="qs-title" use:trapFocus>
    <h2 id="qs-title" class="qs-title">Where would you like to go?</h2>

    <input
      class="qs-input"
      data-autofocus
      type="text"
      role="combobox"
      aria-expanded="true"
      aria-controls="qs-results"
      aria-autocomplete="list"
      aria-activedescendant={activeId}
      placeholder="Find a channel or member"
      autocomplete="off"
      spellcheck="false"
      bind:value={query}
      oninput={() => (highlight = 0)}
      onkeydown={onKeydown}
    />

    <div id="qs-results" class="qs-results" role="listbox" aria-label="Results">
      {#each results as row, index (optionId(row))}
        <div
          id={optionId(row)}
          class="qs-option"
          class:selected={index === selected}
          role="option"
          tabindex="-1"
          aria-selected={index === selected}
          onclick={() => choose(row)}
          onkeydown={(event) => event.key === 'Enter' && choose(row)}
          onmousemove={() => (highlight = index)}
        >
          {#if row.kind === 'channel'}
            <span class="qs-hash">
              {#if row.channel.discordChannelId}<Icon name="link" size={15} />{:else}#{/if}
            </span>
            <span class="qs-name" class:unread={chat.unreadShown(row.channel)}>{row.channel.name}</span>
            {#if chat.mentionsShown(row.channel) > 0}
              <span class="qs-mention" title="You were mentioned"></span>
            {:else if chat.unreadShown(row.channel)}
              <span class="qs-unread" title="Unread messages"></span>
            {/if}
            {#if row.category}<span class="qs-aside">{row.category}</span>{/if}
          {:else}
            {#if avatarUrl(row.member)}
              <img class="avatar small" src={avatarUrl(row.member)} alt="" loading="lazy" />
            {:else}
              <span class="avatar small fallback">{initial(row.member)}</span>
            {/if}
            <span class="qs-name">{nameOf(row.member)}</span>
            <span class="qs-aside">@{row.member.username}</span>
          {/if}
        </div>
      {:else}
        <p class="qs-empty">
          {#if query.trim().length > 0}
            Nothing matches “{query.trim()}”.
          {:else}
            No channels yet.
          {/if}
        </p>
      {/each}
    </div>

    <footer class="qs-footer">
      <span>
        <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close · start with <kbd>#</kbd> or
        <kbd>@</kbd> to narrow
      </span>
      <button class="qs-help" type="button" onclick={() => shortcuts.open('help')}>Keyboard shortcuts</button>
    </footer>
  </div>
</div>

<style>
  .qs-layer {
    position: fixed;
    inset: 0;
    z-index: 120;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 14vh 16px 16px;
  }

  .qs-backdrop {
    position: absolute;
    inset: 0;
    margin: 0;
    padding: 0;
    border: none;
    border-radius: 0;
    background: rgb(0 0 0 / 70%);
    -webkit-backdrop-filter: blur(4px);
    backdrop-filter: blur(4px);
    box-shadow: none;
    cursor: default;
    animation: qs-fade var(--h-duration) var(--h-ease);
  }

  /*
   * The backdrop is a button so a click anywhere closes the switcher, but the
   * shared button styles would tint it accent on hover and shrink it on press, so
   * its own dark, blurred fill is pinned rather than left to the pointer.
   */
  .qs-backdrop:hover,
  .qs-backdrop:active {
    background: rgb(0 0 0 / 70%);
    box-shadow: none;
    transform: none;
  }

  .qs-dialog {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    width: min(560px, 100%);
    max-height: min(520px, 76vh);
    padding: 1rem;
    border: 1px solid var(--h-glass-border);
    border-radius: var(--h-radius-lg);
    background: var(--h-bg-elevated);
    box-shadow: var(--h-shadow-xl);
    animation: qs-rise var(--h-duration-slow) var(--h-ease-out);
  }

  .qs-title {
    margin: 0;
    color: var(--h-text-muted);
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .qs-input {
    width: 100%;
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--h-border-strong);
    border-radius: var(--h-radius);
    background: var(--h-bg-deep);
    color: var(--h-text);
    font: inherit;
    font-size: 1.05rem;
  }

  .qs-results {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .qs-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.6rem;
    border-radius: var(--h-radius-sm);
    color: var(--h-text-muted);
    cursor: pointer;
  }

  .qs-option.selected {
    background: var(--h-active);
    color: var(--h-text);
  }

  .qs-hash {
    display: inline-flex;
    justify-content: center;
    min-width: 1.1em;
    color: var(--h-text-faint);
    font-weight: 600;
  }

  .qs-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .qs-name.unread {
    color: var(--h-text);
    font-weight: 700;
  }

  .qs-mention,
  .qs-unread {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: var(--h-radius-full);
    background: var(--h-error);
  }

  .qs-unread {
    width: 6px;
    height: 6px;
    background: var(--h-text);
  }

  .qs-aside {
    margin-left: auto;
    padding-left: 0.5rem;
    overflow: hidden;
    color: var(--h-text-faint);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .qs-empty {
    margin: 0.5rem 0.6rem;
    color: var(--h-text-muted);
  }

  .qs-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    color: var(--h-text-faint);
    font-size: 0.75rem;
  }

  .qs-help {
    padding: 0;
    border: none;
    background: none;
    color: var(--h-accent);
    font: inherit;
    cursor: pointer;
  }

  .qs-help:hover {
    text-decoration: underline;
  }

  kbd {
    display: inline-block;
    min-width: 1.4em;
    margin: 0 0.1em;
    padding: 0 0.3em;
    border: 1px solid var(--h-border-strong);
    border-radius: var(--h-radius-xs);
    background: var(--h-bg-raised);
    color: var(--h-text-muted);
    font-family: var(--h-font);
    font-size: 0.85em;
    text-align: center;
  }

  @keyframes qs-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes qs-rise {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .qs-backdrop,
    .qs-dialog {
      animation: none;
    }
  }
</style>
