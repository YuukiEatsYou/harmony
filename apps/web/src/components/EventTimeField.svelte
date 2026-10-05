<script lang="ts">
  import { describeSendTime, parseScheduleInput } from '../lib/schedule-time';
  import { fromDateTimeInputs, toDateTimeInputs } from '../lib/time-input';

  /**
   * One moment of an event (its start or its end): a typed expression (`5pm`,
   * `tomorrow 9am`, `in 2h`, the ones the composer reads after an `@`) or the
   * browser's own date and time widgets. Both edit the same two native fields,
   * and a line underneath says how it reads on the member's own clock.
   *
   * `value` is the moment in epoch milliseconds, or null while incomplete. With
   * `optional`, clearing both fields means "no value" and is allowed.
   */
  let {
    value = $bindable(null),
    label,
    optional = false,
    disabled = false,
  }: {
    value?: number | null;
    label: string;
    optional?: boolean;
    disabled?: boolean;
  } = $props();

  // The starting point is read once on purpose: the fields are the state from here on.
  // svelte-ignore state_referenced_locally
  const opened = value === null ? { date: '', time: '' } : toDateTimeInputs(value);
  let date = $state(opened.date);
  let time = $state(opened.time);
  let text = $state('');

  const moment = $derived(date && time ? fromDateTimeInputs(date, time) : null);
  const reading = $derived(moment === null ? null : describeSendTime(moment, { now: Date.now() }));
  const typed = $derived(text.trim().length > 0 ? parseScheduleInput(text, { now: Date.now() }) : null);
  const typedInvalid = $derived(text.trim().length > 0 && typed === null);

  $effect(() => {
    value = moment;
  });

  function setMoment(epochMs: number): void {
    const next = toDateTimeInputs(epochMs);
    date = next.date;
    time = next.time;
  }

  function onType(): void {
    // Only a complete, valid expression moves the fields.
    if (typed !== null) setMoment(typed);
  }

  function clear(): void {
    text = '';
    date = '';
    time = '';
  }
</script>

<div class="schedule-field event-time-field">
  <label>
    {label}
    <input
      type="text"
      class="schedule-expression"
      placeholder="5pm, tomorrow 9am, in 2h, fri 18:30"
      autocomplete="off"
      spellcheck="false"
      {disabled}
      bind:value={text}
      oninput={onType}
    />
  </label>
  {#if typedInvalid}
    <p class="muted schedule-note">Not a time I can read yet. Try "5pm", "tomorrow 9am" or "in 2h".</p>
  {/if}

  <div class="timestamp-when">
    <label>
      Date
      <input type="date" {disabled} bind:value={date} />
    </label>
    <label>
      Time
      <input type="time" {disabled} bind:value={time} />
    </label>
  </div>

  {#if reading}
    <p class="schedule-reading">{reading}</p>
  {/if}
  {#if optional && (date || time) && !disabled}
    <button type="button" class="ghost event-clear" onclick={clear}>No end time</button>
  {/if}
</div>
