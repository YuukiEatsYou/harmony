<script lang="ts">
  import { onMount } from 'svelte';
  import { NAME_COLOR_LABEL_MAX, type NameColor } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';
  import { nameColors } from '../../lib/name-colors.svelte';
  import { hexColor } from '../../lib/profile.svelte';

  let newColor = $state('#5865f2');
  let newLabel = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  onMount(() => {
    void nameColors.load(true);
  });

  /** A `#rrggbb` from the color input as a packed integer. */
  function toColor(hex: string): number {
    return Number.parseInt(hex.slice(1), 16);
  }

  async function add(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    error = null;
    try {
      await api<NameColor>('/name-colors', {
        method: 'POST',
        body: JSON.stringify({ color: toColor(newColor), label: newLabel.trim() || null }),
      });
      newLabel = '';
      await nameColors.load(true);
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function change(entry: NameColor, patch: { color?: number; label?: string | null }): Promise<void> {
    error = null;
    try {
      await api(`/name-colors/${entry.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      await nameColors.load(true);
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    }
  }

  async function remove(entry: NameColor): Promise<void> {
    error = null;
    try {
      await api(`/name-colors/${entry.id}`, { method: 'DELETE' });
      await nameColors.load(true);
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    }
  }
</script>

<section>
  <h3>Username colors</h3>
  <p class="muted">
    Colors members can pick for their username in their profile. They grant nothing, and a colored
    role a member holds still wins.
  </p>

  <form class="inline" onsubmit={add}>
    <input type="color" bind:value={newColor} aria-label="New color" />
    <input bind:value={newLabel} maxlength={NAME_COLOR_LABEL_MAX} placeholder="Label (optional)" />
    <button type="submit" disabled={busy}>Add color</button>
  </form>

  {#if error}<p class="form-error">{error}</p>{/if}

  {#if nameColors.list.length === 0}
    <p class="muted">No colors yet. Add one above and members can start using it.</p>
  {:else}
    <ul class="rows">
      {#each nameColors.list as entry (entry.id)}
        <li class="row">
          <input
            type="color"
            aria-label={`Color ${hexColor(entry.color)}`}
            value={hexColor(entry.color) ?? '#000000'}
            onchange={(event) => change(entry, { color: toColor(event.currentTarget.value) })}
          />
          <input
            value={entry.label ?? ''}
            maxlength={NAME_COLOR_LABEL_MAX}
            placeholder="Label (optional)"
            onchange={(event) => change(entry, { label: event.currentTarget.value.trim() || null })}
          />
          <button type="button" class="danger" onclick={() => remove(entry)}>Remove</button>
        </li>
      {/each}
    </ul>
  {/if}
</section>
