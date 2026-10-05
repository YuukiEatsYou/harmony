<script lang="ts">
  import { defaultScheduleTime, describeSendTime, parseScheduleInput, scheduleChoices, scheduleProblem } from '../lib/schedule-time';
  import { fromDateTimeInputs, toDateTimeInputs } from '../lib/time-input';

  /**
   * Picks the moment a message goes out: a typed expression (`5pm`,
   * `tomorrow 9am`, `in 2h`, the same ones the composer reads after an `@`),
   * quick choices, or the browser's own date and time widgets. They all edit the
   * same two native fields, so what is shown is always what will be scheduled,
   * and a line underneath says how it reads on the member's own clock.
   *
   * `value` is the chosen moment in epoch milliseconds, or null while the fields
   * are incomplete. `problem` is why it cannot be used, or null when it can.
   */
  let {
    value = $bindable(null),
    problem = $bindable(null),
    initial = null,
    autofocus = false,
  }: {
    value?: number | null;
    problem?: string | null;
    initial?: number | null;
    autofocus?: boolean;
  } = $props();

  // The starting point is read once on purpose: the fields are the state from here on.
  // svelte-ignore state_referenced_locally
  const opened = toDateTimeInputs(initial ?? defaultScheduleTime(Date.now()));
  let date = $state(opened.date);
  let time = $state(opened.time);
  let text = $state('');
  let textInput = $state<HTMLInputElement | null>(null);

  // "Now" is read again whenever the fields change, as the timestamp picker does,
  // so the checks and the readout stay honest without a ticking clock.
  const moment = $derived(fromDateTimeInputs(date, time));
  const reading = $derived(moment === null ? null : describeSendTime(moment, { now: Date.now() }));
  const choices = $derived(scheduleChoices(Date.now()));
  const typed = $derived(text.trim().length > 0 ? parseScheduleInput(text, { now: Date.now() }) : null);
  const typedInvalid = $derived(text.trim().length > 0 && typed === null);

  $effect(() => {
    value = moment;
    problem = scheduleProblem(moment, Date.now());
  });

  function setMoment(epochMs: number): void {
    const next = toDateTimeInputs(epochMs);
    date = next.date;
    time = next.time;
  }

  function onType(): void {
    // Only a complete, valid expression moves the fields; half-typed text leaves
    // the last good time in place and says what is missing.
    if (typed !== null) setMoment(typed);
  }

  $effect(() => {
    if (autofocus) textInput?.focus();
  });
</script>

<div class="schedule-field">
  <label>
    When
    <input
      type="text"
      class="schedule-expression"
      placeholder="5pm, tomorrow 9am, in 2h, fri 18:30"
      autocomplete="off"
      spellcheck="false"
      bind:value={text}
      bind:this={textInput}
      oninput={onType}
    />
  </label>
  {#if typedInvalid}
    <p class="muted schedule-note">Not a time I can read yet. Try "5pm", "tomorrow 9am" or "in 2h".</p>
  {/if}

  <div class="schedule-choices">
    {#each choices as choice (choice.label)}
      <button type="button" class="ghost" onclick={() => { text = ''; setMoment(choice.at); }}>{choice.label}</button>
    {/each}
  </div>

  <div class="timestamp-when">
    <label>
      Date
      <input type="date" bind:value={date} required />
    </label>
    <label>
      Time
      <input type="time" bind:value={time} required />
    </label>
  </div>

  {#if problem}
    <p class="form-error schedule-note">{problem}</p>
  {:else if reading}
    <p class="schedule-reading">Sends {reading}</p>
  {/if}
</div>
