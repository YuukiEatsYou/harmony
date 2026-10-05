<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Permission,
    hasPermission,
    isPollClosed,
    nextPollChoice,
    pollLeaders,
    pollPercent,
    pollTimeLeft,
    type Message,
    type Poll,
    type PollVotersResponse,
  } from '@harmony/shared';
  import { avatarUrl, initial } from '../lib/avatar';
  import { polls } from '../lib/polls.svelte';
  import { session } from '../lib/session.svelte';
  import Icon from './Icon.svelte';

  let { message, poll }: { message: Message; poll: Poll } = $props();

  const myId = $derived(session.user?.id);
  const permissions = $derived(BigInt(session.permissions || '0'));

  const closed = $derived(isPollClosed(poll, polls.now));
  const busy = $derived(polls.busy[message.id] === true);
  const failure = $derived(polls.errors[message.id] ?? null);
  const leaders = $derived(closed ? pollLeaders(poll) : []);
  const timeLeft = $derived(pollTimeLeft(poll.closesAt, polls.now));
  const total = $derived(poll.totalVoters);
  const canEnd = $derived(
    !closed &&
      poll.source === 'harmony' &&
      (message.author?.id === myId || hasPermission(permissions, Permission.ManageMessages)),
  );

  let confirmingEnd = $state(false);
  let showVoters = $state(false);
  let voterLists = $state<Record<string, PollVotersResponse>>({});
  let votersError = $state<string | null>(null);

  function choose(optionId: string): void {
    if (closed || busy) return;
    void polls.vote(message, nextPollChoice(poll, poll.myVotes, optionId));
  }

  async function end(): Promise<void> {
    confirmingEnd = false;
    await polls.end(message);
  }

  /** A signature of the counts, so an open voter list refreshes when a vote lands. */
  const countsKey = $derived(poll.options.map((option) => option.count).join(','));

  async function loadVoters(): Promise<void> {
    try {
      const lists = await Promise.all(poll.options.map((option) => polls.voters(message.id, option.id)));
      voterLists = Object.fromEntries(lists.map((list) => [list.optionId, list]));
      votersError = null;
    } catch {
      votersError = 'Could not load the voters.';
    }
  }

  $effect(() => {
    void countsKey;
    if (showVoters) void loadVoters();
  });

  onMount(() => polls.watchClock());

  function percentLabel(count: number): string {
    return `${pollPercent(count, total)}%`;
  }

  function voteWord(count: number): string {
    return `${count} ${count === 1 ? 'vote' : 'votes'}`;
  }
</script>

<div class="poll" class:closed aria-label={`Poll: ${poll.question}`} role="group">
  <div class="poll-head">
    <span class="poll-icon"><Icon name="poll" size={16} /></span>
    <span class="poll-question">{poll.question}</span>
  </div>
  <p class="poll-hint">
    {#if closed}Final results{:else if poll.allowMultiple}Select one or more answers{:else}Select one answer{/if}
  </p>

  <ul class="poll-options">
    {#each poll.options as option (option.id)}
      {@const chosen = poll.myVotes.includes(option.id)}
      <li>
        <button
          type="button"
          class="poll-option"
          class:chosen
          class:leader={leaders.includes(option.id)}
          aria-pressed={chosen}
          disabled={closed || busy}
          onclick={() => choose(option.id)}
        >
          <span class="poll-bar" style={`width: ${pollPercent(option.count, total)}%`}></span>
          <span class="poll-check" aria-hidden="true">
            {#if chosen}<Icon name="check" size={14} />{/if}
          </span>
          {#if option.emoji}<span class="poll-emoji">{option.emoji}</span>{/if}
          <span class="poll-text">{option.text}</span>
          <span class="poll-count">
            <span class="poll-percent">{percentLabel(option.count)}</span>
            <span class="poll-votes">{voteWord(option.count)}</span>
          </span>
        </button>
      </li>
    {/each}
  </ul>

  <div class="poll-foot">
    <span class="poll-meta" aria-live="polite">
      {total} {total === 1 ? 'voter' : 'voters'}
      <span aria-hidden="true">·</span>
      {#if closed}Poll closed{:else if timeLeft}{timeLeft}{:else}No expiry{/if}
    </span>
    <span class="poll-actions">
      <button
        type="button"
        class="poll-link"
        aria-expanded={showVoters}
        disabled={total === 0}
        onclick={() => (showVoters = !showVoters)}
      >{showVoters ? 'Hide voters' : 'Show voters'}</button>
      {#if canEnd}
        {#if confirmingEnd}
          <button type="button" class="poll-link danger" disabled={busy} onclick={end}>End now</button>
          <button type="button" class="poll-link" onclick={() => (confirmingEnd = false)}>Keep open</button>
        {:else}
          <button type="button" class="poll-link" disabled={busy} onclick={() => (confirmingEnd = true)}>End poll</button>
        {/if}
      {/if}
    </span>
  </div>

  {#if failure}<p class="poll-error" role="alert">{failure}</p>{/if}

  {#if showVoters}
    <div class="poll-voters">
      {#if votersError}
        <p class="poll-error" role="alert">{votersError}</p>
      {:else}
        {#each poll.options as option (option.id)}
          {@const list = voterLists[option.id]}
          {#if option.count > 0}
            <section class="voter-group" aria-label={`Voters for ${option.text}`}>
              <h4>{#if option.emoji}{option.emoji}&nbsp;{/if}{option.text} <span>{option.count}</span></h4>
              {#if list}
                <ul>
                  {#each list.voters as voter (voter.user.id)}
                    {@const picture = avatarUrl(voter.user)}
                    <li title={voter.user.username}>
                      {#if picture}
                        <img src={picture} alt="" width="18" height="18" />
                      {:else}
                        <span class="voter-initial" aria-hidden="true">{initial(voter.user)}</span>
                      {/if}
                      <span>{voter.user.displayName ?? voter.user.username}</span>
                    </li>
                  {/each}
                </ul>
                {#if list.total > list.voters.length}
                  <p class="poll-hint">and {list.total - list.voters.length} more</p>
                {/if}
              {:else}
                <p class="poll-hint">Loading…</p>
              {/if}
            </section>
          {/if}
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .poll {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    width: min(100%, 26rem);
    margin-top: 0.3rem;
    padding: 0.75rem 0.85rem;
    border: 1px solid var(--h-border);
    border-radius: var(--h-radius);
    background: var(--h-bg-raised);
  }

  .poll-head {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-weight: 700;
    color: var(--h-text);
    overflow-wrap: anywhere;
  }

  .poll-icon {
    display: inline-flex;
    margin-top: 0.15rem;
    color: var(--h-accent);
  }

  .poll-hint {
    margin: 0;
    font-size: 0.78rem;
    color: var(--h-text-faint);
  }

  .poll-options {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* The global button style is an accent fill; a poll option is a row with a bar. */
  .poll .poll-option {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.65rem;
    overflow: hidden;
    border: 1px solid var(--h-border);
    border-radius: var(--h-radius-sm);
    background: var(--h-bg-deep);
    color: var(--h-text);
    font-weight: 500;
    text-align: left;
    transform: none;
  }

  .poll .poll-option:hover:not(:disabled) {
    background: var(--h-bg-deep);
    border-color: var(--h-accent);
    box-shadow: none;
    transform: none;
  }

  .poll .poll-option:focus-visible {
    outline: 2px solid var(--h-accent);
    outline-offset: 2px;
  }

  .poll .poll-option:disabled {
    cursor: default;
    opacity: 1;
  }

  .poll .poll-option.chosen {
    border-color: var(--h-accent);
  }

  .poll-bar {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--h-accent-subtle);
    transition: width var(--h-duration) var(--h-ease);
    pointer-events: none;
  }

  .poll-option.leader .poll-bar {
    background: var(--h-active);
  }

  .poll-check {
    position: relative;
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 1.15rem;
    height: 1.15rem;
    border: 1.5px solid var(--h-border-strong);
    border-radius: var(--h-radius-full);
    color: var(--h-on-accent);
  }

  .chosen .poll-check {
    border-color: var(--h-accent);
    background: var(--h-accent);
  }

  .poll-emoji,
  .poll-text,
  .poll-count {
    position: relative;
  }

  .poll-text {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .poll-count {
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: flex-end;
    line-height: 1.15;
  }

  .poll-percent {
    font-weight: 700;
  }

  .poll-votes {
    font-size: 0.7rem;
    color: var(--h-text-muted);
    font-weight: 400;
  }

  .poll-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.25rem 0.75rem;
    font-size: 0.78rem;
    color: var(--h-text-muted);
  }

  .poll-actions {
    display: inline-flex;
    gap: 0.6rem;
  }

  .poll .poll-link {
    padding: 0.1rem 0.15rem;
    background: none;
    color: var(--h-accent);
    font-size: 0.78rem;
    font-weight: 600;
    transform: none;
  }

  .poll .poll-link:hover:not(:disabled) {
    background: none;
    box-shadow: none;
    text-decoration: underline;
    transform: none;
  }

  .poll .poll-link:focus-visible {
    outline: 2px solid var(--h-accent);
    outline-offset: 2px;
  }

  .poll .poll-link.danger {
    color: var(--h-error);
  }

  .poll-error {
    margin: 0;
    font-size: 0.8rem;
    color: var(--h-error);
  }

  .poll-voters {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--h-border);
  }

  .voter-group h4 {
    margin: 0 0 0.25rem;
    font-size: 0.8rem;
    color: var(--h-text);
  }

  .voter-group h4 span {
    color: var(--h-text-muted);
    font-weight: 400;
  }

  .voter-group ul {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .voter-group li {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.1rem 0.5rem 0.1rem 0.15rem;
    border-radius: var(--h-radius-full);
    background: var(--h-bg-deep);
    font-size: 0.78rem;
    color: var(--h-text);
  }

  .voter-group img,
  .voter-initial {
    width: 18px;
    height: 18px;
    border-radius: var(--h-radius-full);
    object-fit: cover;
  }

  .voter-initial {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--h-accent-subtle);
    font-size: 0.65rem;
    font-weight: 700;
  }

  @media (prefers-reduced-motion: reduce) {
    .poll-bar {
      transition: none;
    }
  }
</style>
