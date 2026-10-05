<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { POLL_DURATION_CHOICES, POLL_LIMITS } from '@harmony/shared';
  import { ApiError } from '../lib/api';
  import { chat } from '../lib/chat.svelte';
  import { draftProblem, newPollDraft, withAddedOption, withoutOption, type PollDraft } from '../lib/poll-draft';
  import { polls } from '../lib/polls.svelte';
  import Icon from './Icon.svelte';

  /** `onclose` says whether focus should go back to the message box. */
  let { onclose }: { onclose: (refocus: boolean) => void } = $props();

  let draft = $state<PollDraft>(newPollDraft());
  let sending = $state(false);
  let error = $state<string | null>(null);
  let questionInput = $state<HTMLInputElement | null>(null);
  let optionInputs = $state<Record<number, HTMLInputElement | null>>({});

  const problem = $derived(draftProblem(draft));

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const channelId = chat.activeChannelId;
    if (sending || problem || !channelId) return;
    sending = true;
    error = null;
    try {
      await polls.create(channelId, draft, chat.replyTarget?.id ?? null);
      chat.replyTarget = null;
      onclose(true);
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : 'The poll could not be sent. Try again.';
    } finally {
      sending = false;
    }
  }

  async function addOption(): Promise<void> {
    const before = draft.options.length;
    draft = withAddedOption(draft);
    if (draft.options.length === before) return;
    // Land the caret in the new row so a list can be typed straight through.
    await tick();
    const added = draft.options[draft.options.length - 1];
    if (added) optionInputs[added.key]?.focus();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    // The composer would otherwise take the same Escape to cancel a reply.
    event.preventDefault();
    event.stopPropagation();
    onclose(true);
  }

  /** Enter in an option moves on to the next one, or adds one at the end. */
  function onOptionKeydown(event: KeyboardEvent, index: number): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    const next = draft.options[index + 1];
    if (next) optionInputs[next.key]?.focus();
    else void addOption();
  }

  onMount(() => {
    questionInput?.focus();
    // A click anywhere else dismisses the form, except on the button that
    // toggles it, which would otherwise close it only to open it again.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (target?.closest('.poll-composer') || target?.closest('.poll-trigger')) return;
      onclose(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });
</script>

<div class="poll-composer" role="dialog" aria-label="Create a poll" tabindex="-1" onkeydown={onKeydown}>
  <form class="pc-form" onsubmit={submit}>
    <label class="field">
      <span>Question</span>
      <input
        type="text"
        bind:this={questionInput}
        bind:value={draft.question}
        maxlength={POLL_LIMITS.question}
        placeholder="What do you want to ask?"
        autocomplete="off"
      />
    </label>

    <fieldset class="options">
      <legend>Answers</legend>
      {#each draft.options as option, index (option.key)}
        <div class="option-row">
          <input
            class="pc-emoji"
            type="text"
            bind:value={option.emoji}
            maxlength="8"
            placeholder="🙂"
            aria-label={`Emoji for answer ${index + 1} (optional)`}
            autocomplete="off"
          />
          <input
            class="pc-text"
            type="text"
            bind:this={optionInputs[option.key]}
            bind:value={option.text}
            maxlength={POLL_LIMITS.optionText}
            placeholder={`Answer ${index + 1}`}
            aria-label={`Answer ${index + 1}`}
            autocomplete="off"
            onkeydown={(event) => onOptionKeydown(event, index)}
          />
          <button
            type="button"
            class="pc-remove"
            title="Remove answer"
            aria-label={`Remove answer ${index + 1}`}
            disabled={draft.options.length <= POLL_LIMITS.optionsMin}
            onclick={() => (draft = withoutOption(draft, option.key))}
          ><Icon name="close" size={14} /></button>
        </div>
      {/each}
      <button
        type="button"
        class="pc-add"
        disabled={draft.options.length >= POLL_LIMITS.optionsMax}
        onclick={addOption}
      ><Icon name="plus" size={14} /> Add answer</button>
    </fieldset>

    <div class="settings">
      <label class="check">
        <input type="checkbox" bind:checked={draft.allowMultiple} />
        <span>Allow multiple answers</span>
      </label>
      <label class="duration">
        <span>Duration</span>
        <select
          value={draft.durationHours === null ? 'none' : String(draft.durationHours)}
          onchange={(event) => {
            const value = event.currentTarget.value;
            draft.durationHours = value === 'none' ? null : Number(value);
          }}
        >
          {#each POLL_DURATION_CHOICES as choice (choice.label)}
            <option value={choice.hours === null ? 'none' : String(choice.hours)}>{choice.label}</option>
          {/each}
        </select>
      </label>
    </div>

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <div class="actions">
      <button type="button" class="ghost" onclick={() => onclose(true)}>Cancel</button>
      <button type="submit" disabled={sending || problem !== null} title={problem ?? 'Post the poll'}>
        {sending ? 'Posting…' : 'Post poll'}
      </button>
    </div>
  </form>
</div>

<style>
  .poll-composer {
    width: min(420px, 100%);
    padding: 0.75rem;
    border-radius: var(--h-radius-lg);
    background: var(--h-glass-bg);
    -webkit-backdrop-filter: blur(var(--h-glass-blur));
    backdrop-filter: blur(var(--h-glass-blur));
    border: 1px solid var(--h-glass-border);
    box-shadow: var(--h-shadow-lg);
  }

  .poll-composer:focus {
    outline: none;
  }

  /* The composer styles every form inside it as a row of buttons; this is a column. */
  .poll-composer form.pc-form {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.65rem;
  }

  .poll-composer form.pc-form button {
    margin-bottom: 0;
  }

  .field,
  .duration {
    display: flex;
    align-items: stretch;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    color: var(--h-text-muted);
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    border: none;
    min-width: 0;
  }

  .options legend {
    padding: 0;
    margin-bottom: 0.25rem;
    font-size: 0.8rem;
    color: var(--h-text-muted);
  }

  .option-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .pc-emoji {
    flex: none;
    width: 3rem;
    text-align: center;
  }

  .pc-text {
    flex: 1;
    min-width: 0;
  }

  .poll-composer .pc-remove {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.9rem;
    height: 1.9rem;
    padding: 0;
    background: none;
    color: var(--h-text-muted);
    transform: none;
  }

  .poll-composer .pc-remove:hover:not(:disabled) {
    background: var(--h-hover);
    color: var(--h-text);
    box-shadow: none;
    transform: none;
  }

  .poll-composer .pc-add {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.3rem 0.5rem;
    background: none;
    color: var(--h-accent);
    font-size: 0.82rem;
    transform: none;
  }

  .poll-composer .pc-add:hover:not(:disabled) {
    background: var(--h-hover);
    box-shadow: none;
    transform: none;
  }

  .settings {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.5rem 1rem;
  }

  .check {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: var(--h-text);
  }

  .error {
    margin: 0;
    font-size: 0.82rem;
    color: var(--h-error);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
