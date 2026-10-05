<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { EVENT_LIMITS, groupEvents, interestedLabel, type ServerEvent, type User } from '@harmony/shared';
  import { ApiError } from '../lib/api';
  import { chat } from '../lib/chat.svelte';
  import {
    draftFromEvent,
    eventDraftProblem,
    eventStatusLabel,
    describeEventTime,
    newEventDraft,
    toCreateEventBody,
    toUpdateEventBody,
    type EventDraft,
  } from '../lib/event-form';
  import { events } from '../lib/events.svelte';
  import { trapFocus } from '../lib/shortcuts.svelte';
  import { formatTimestamp } from '../lib/timestamp';
  import EventTimeField from './EventTimeField.svelte';

  let { onclose }: { onclose: () => void } = $props();

  // The panel is opened from the header button; remember it so closing puts focus back.
  const restoreTo = document.activeElement as HTMLElement | null;

  let error = $state<string | null>(null);
  /** The event with a request in flight, so its buttons cannot be pressed twice. */
  let working = $state<string | null>(null);
  /** `'new'` for the create form, an event id for an edit, null when closed. */
  let formFor = $state<string | null>(null);
  let draft = $state<EventDraft>(newEventDraft(Date.now()));
  let formProblem = $state<string | null>(null);
  let saving = $state(false);
  /** Names behind an event's count, loaded when asked for. */
  let whoOpen = $state<Record<string, User[] | 'loading'>>({});
  /** Moves on so "starts in 5 minutes" and the groups stay honest while the panel sits open. */
  let now = $state(Date.now());

  const groups = $derived(groupEvents(events.items));
  const editingEvent = $derived(formFor && formFor !== 'new' ? events.items.find((e) => e.id === formFor) : undefined);
  const editingStarted = $derived(editingEvent?.status === 'active');
  const channelChoices = $derived(chat.channels);

  function fail(cause: unknown): void {
    error = cause instanceof ApiError ? cause.message : String(cause);
  }

  function creatorName(event: ServerEvent): string {
    return event.creator ? (event.creator.displayName ?? event.creator.username) : 'a former member';
  }

  function place(event: ServerEvent): string {
    return event.locationKind === 'channel' ? `#${events.channelName(event.channelId)}` : event.locationText;
  }

  function startForm(): void {
    error = null;
    draft = newEventDraft(Date.now(), chat.activeChannel?.id ?? null);
    // New events default to the open channel's place only when asked; start with a text place.
    draft.locationKind = 'external';
    draft.channelId = chat.activeChannel?.id ?? chat.channels[0]?.id ?? null;
    formProblem = null;
    formFor = 'new';
  }

  function startEdit(event: ServerEvent): void {
    error = null;
    draft = draftFromEvent(event);
    formProblem = null;
    formFor = event.id;
  }

  function closeForm(): void {
    formFor = null;
    formProblem = null;
  }

  /** Closes the whole panel, returning focus to whatever opened it. */
  function close(): void {
    const target = restoreTo;
    onclose();
    void tick().then(() => target?.focus());
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }

  async function submit(): Promise<void> {
    error = null;
    const problem = eventDraftProblem(draft, Date.now(), editingStarted);
    formProblem = problem;
    if (problem) return;
    saving = true;
    try {
      if (formFor === 'new') {
        await events.create(toCreateEventBody(draft));
      } else if (editingEvent) {
        const body = toUpdateEventBody(draft, editingEvent);
        if (Object.keys(body).length > 0) await events.update(editingEvent.id, body);
      }
      closeForm();
    } catch (cause) {
      fail(cause);
    } finally {
      saving = false;
    }
  }

  async function toggleInterested(event: ServerEvent): Promise<void> {
    error = null;
    working = event.id;
    try {
      await events.setInterested(event.id, !event.interested);
      // Keep an open name list in step with the new count.
      if (whoOpen[event.id] && whoOpen[event.id] !== 'loading') await loadWho(event.id);
    } catch (cause) {
      fail(cause);
    } finally {
      working = null;
    }
  }

  async function cancelEvent(event: ServerEvent): Promise<void> {
    error = null;
    working = event.id;
    try {
      await events.cancel(event.id);
      if (formFor === event.id) closeForm();
    } catch (cause) {
      fail(cause);
    } finally {
      working = null;
    }
  }

  async function loadWho(id: string): Promise<void> {
    try {
      whoOpen[id] = (await events.interested(id)).users;
    } catch (cause) {
      delete whoOpen[id];
      fail(cause);
    }
  }

  async function toggleWho(event: ServerEvent): Promise<void> {
    if (whoOpen[event.id]) {
      delete whoOpen[event.id];
      return;
    }
    whoOpen[event.id] = 'loading';
    await loadWho(event.id);
  }

  onMount(() => {
    if (events.notice) events.notice = null;
    void events.load();
    const timer = setInterval(() => (now = Date.now()), 20_000);
    return () => clearInterval(timer);
  });
</script>

{#snippet eventCard(event: ServerEvent)}
  <li class="saved-entry event-entry" class:live={event.status === 'active'} class:over={event.status === 'ended' || event.status === 'canceled'}>
    <div class="search-result-head">
      <strong>{event.title}</strong>
      <span class="event-status event-status-{event.status}">{eventStatusLabel(event.status)}</span>
    </div>
    <p class="event-when">
      <span title={formatTimestamp(event.startsAt, 'F')}>{describeEventTime(event, { now })}</span>
      {#if event.status === 'scheduled' || event.status === 'active'}
        <span class="muted">· {formatTimestamp(event.startsAt, 'R', { now })}</span>
      {/if}
    </p>
    <p class="event-place muted">{event.locationKind === 'channel' ? 'In' : 'At'} {place(event)} · by {creatorName(event)}</p>
    {#if event.description}<p class="event-description">{event.description}</p>{/if}

    <div class="saved-actions">
      {#if event.status === 'scheduled' || event.status === 'active'}
        <button
          type="button"
          class="event-interest"
          class:on={event.interested}
          aria-pressed={event.interested}
          disabled={working === event.id}
          onclick={() => toggleInterested(event)}
        >
          {event.interested ? 'Interested ✓' : 'Interested'}
        </button>
      {/if}
      <button
        type="button"
        class="ghost event-count"
        disabled={event.interestedCount === 0}
        aria-expanded={Boolean(whoOpen[event.id])}
        onclick={() => toggleWho(event)}
      >
        {interestedLabel(event.interestedCount)}
      </button>
      {#if events.canManage(event) && (event.status === 'scheduled' || event.status === 'active')}
        <button type="button" class="ghost" disabled={working === event.id} onclick={() => startEdit(event)}>Edit</button>
        <button
          type="button"
          class="ghost"
          title="Cancel this event"
          disabled={working === event.id}
          onclick={() => cancelEvent(event)}
        >
          Cancel event
        </button>
      {/if}
    </div>

    {#if whoOpen[event.id]}
      {@const names = whoOpen[event.id]}
      {#if names === 'loading' || names === undefined}
        <p class="muted event-who">Loading…</p>
      {:else}
        <ul class="event-who">
          {#each names as user (user.id)}
            <li>{user.displayName ?? user.username}</li>
          {:else}
            <li class="muted">No one you can see yet.</li>
          {/each}
        </ul>
      {/if}
    {/if}
  </li>
{/snippet}

{#snippet group(title: string, list: ServerEvent[])}
  {#if list.length > 0}
    <h4 class="saved-heading">{title}</h4>
    <ul class="search-results">
      {#each list as event (event.id)}
        {@render eventCard(event)}
      {/each}
    </ul>
  {/if}
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="admin-overlay" onkeydown={onKeydown}>
  <div
    class="admin inbox-panel saved-panel events-panel"
    role="dialog"
    aria-modal="true"
    aria-label="Events"
    use:trapFocus
  >
    <div class="admin-body">
      <div class="search-head">
        <h3>Events</h3>
        <div class="events-head-actions">
          {#if events.canCreate && formFor === null}
            <button type="button" onclick={startForm}>New event</button>
          {/if}
          <button type="button" data-autofocus onclick={close}>Close</button>
        </div>
      </div>

      {#if error}<p class="form-error">{error}</p>{/if}

      {#if formFor !== null}
        {#key formFor}
        <form
          class="event-form"
          onsubmit={(submitEvent) => {
            submitEvent.preventDefault();
            void submit();
          }}
        >
          <h4 class="saved-heading">{formFor === 'new' ? 'New event' : 'Edit event'}</h4>
          <label>
            Title
            <input type="text" maxlength={EVENT_LIMITS.title} bind:value={draft.title} required />
          </label>
          <label>
            Description
            <textarea rows="3" maxlength={EVENT_LIMITS.description} bind:value={draft.description}></textarea>
          </label>

          <fieldset class="event-kind">
            <legend>Where</legend>
            <label class="checkbox">
              <input type="radio" name="event-kind" value="external" bind:group={draft.locationKind} />
              Somewhere else
            </label>
            <label class="checkbox">
              <input type="radio" name="event-kind" value="channel" bind:group={draft.locationKind} />
              In a channel
            </label>
          </fieldset>
          {#if draft.locationKind === 'channel'}
            <label>
              Channel
              <select bind:value={draft.channelId}>
                {#each channelChoices as channel (channel.id)}
                  <option value={channel.id}>#{channel.name}</option>
                {/each}
              </select>
            </label>
          {:else}
            <label>
              Place
              <input
                type="text"
                maxlength={EVENT_LIMITS.locationText}
                placeholder="A link, an address, a game…"
                bind:value={draft.locationText}
              />
            </label>
          {/if}

          <EventTimeField label="Starts" bind:value={draft.startsAt} disabled={editingStarted} />
          <EventTimeField label="Ends (optional)" optional bind:value={draft.endsAt} />
          <p class="muted event-hint">
            Times are shown in your own time zone. An event with no end is over four hours after it starts.
          </p>

          {#if formFor === 'new'}
            <label>
              Announce in a channel
              <select bind:value={draft.announceChannelId}>
                <option value={null}>Do not announce</option>
                {#each channelChoices as channel (channel.id)}
                  <option value={channel.id}>#{channel.name}</option>
                {/each}
              </select>
            </label>
          {/if}

          {#if formProblem}<p class="form-error">{formProblem}</p>{/if}
          <div class="saved-actions">
            <button type="submit" disabled={saving}>{formFor === 'new' ? 'Create event' : 'Save changes'}</button>
            <button type="button" class="ghost" onclick={closeForm}>Discard</button>
          </div>
        </form>
        {/key}
      {/if}

      {#if !events.loaded}
        <p class="muted">Loading…</p>
      {:else if events.items.length === 0}
        <p class="muted">
          No events yet.{events.canCreate ? ' Choose "New event" to plan one.' : ''}
        </p>
      {:else}
        {@render group('Now', groups.now)}
        {@render group('Upcoming', groups.upcoming)}
        {@render group('Past', groups.past)}
      {/if}
    </div>
  </div>
</div>
