<script lang="ts">
  import { tick } from 'svelte';
  import { Permission, hasPermission, type Message, type MessageEdit, type MessageEditListResponse } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { session } from '../lib/session.svelte';
  import { trapFocus } from '../lib/shortcuts.svelte';
  import { diffWords } from '../lib/text-diff';

  /**
   * The "(edited)" marker. For the author and for members who manage messages it
   * is a button that opens the earlier versions with what each edit changed;
   * everyone else sees plain text, so a corrected mistake stays private. All text
   * is rendered as text, never as markup.
   */
  let { message }: { message: Message } = $props();

  const canView = $derived(
    message.author?.id === session.user?.id ||
      hasPermission(BigInt(session.permissions || '0'), Permission.ManageMessages),
  );

  let open = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let edits = $state<MessageEdit[]>([]);
  let trigger = $state<HTMLButtonElement | null>(null);

  /** Each saved version with the diff from it to the text that replaced it. */
  const rows = $derived(
    edits.map((edit, index) => ({
      edit,
      parts: diffWords(edit.content, index === 0 ? message.content : (edits[index - 1] as MessageEdit).content),
    })),
  );

  async function show(): Promise<void> {
    open = true;
    loading = true;
    error = null;
    try {
      edits = (await api<MessageEditListResponse>(`/messages/${message.id}/edits`)).edits;
    } catch (cause) {
      error = cause instanceof ApiError && cause.status === 404 ? 'No earlier versions are available.' : 'Could not load the history.';
    } finally {
      loading = false;
    }
  }

  async function close(): Promise<void> {
    open = false;
    edits = [];
    await tick();
    trigger?.focus();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      void close();
    }
  }

  function when(iso: string): string {
    return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function who(edit: MessageEdit): string {
    if (edit.source === 'discord') return 'on Discord';
    return edit.editor ? `by ${edit.editor.displayName ?? edit.editor.username}` : 'by a deleted user';
  }
</script>

{#if canView}
  <button
    bind:this={trigger}
    type="button"
    class="edited-button"
    title="View edit history"
    aria-haspopup="dialog"
    onclick={show}>(edited)</button
  >
{:else}
  <span class="edited-text">(edited)</span>
{/if}

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="eh-layer" onkeydown={onKeydown}>
    <button class="eh-backdrop" type="button" tabindex="-1" aria-label="Close edit history" onclick={close}></button>
    <div class="eh-dialog" role="dialog" aria-modal="true" aria-labelledby="eh-title-{message.id}" use:trapFocus>
      <div class="eh-head">
        <h2 id="eh-title-{message.id}">Edit history</h2>
        <button type="button" data-autofocus onclick={close}>Close</button>
      </div>

      {#if loading}
        <p class="eh-note">Loading…</p>
      {:else if error}
        <p class="eh-note" role="alert">{error}</p>
      {:else if rows.length === 0}
        <p class="eh-note">No earlier versions were kept for this message.</p>
      {:else}
        <p class="eh-note">
          Newest edit first. <del>Struck</del> text was removed and <ins>underlined</ins> text was added by that edit.
        </p>
        <ol class="eh-list">
          {#each rows as row (row.edit.id)}
            <li>
              <div class="eh-meta">
                <time datetime={row.edit.editedAt}>{when(row.edit.editedAt)}</time>
                <span>{who(row.edit)}</span>
              </div>
              <p class="eh-text">
                {#each row.parts as part, index (index)}
                  {#if part.kind === 'del'}<del>{part.text}</del>{:else if part.kind === 'add'}<ins>{part.text}</ins>{:else}{part.text}{/if}
                {/each}
              </p>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </div>
{/if}

<style>
  .edited-text,
  .edited-button {
    color: var(--h-text-faint);
    font-size: 0.72rem;
    font-weight: 500;
  }

  .edited-button {
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
  }

  .edited-button:hover,
  .edited-button:focus-visible {
    color: var(--h-text);
    text-decoration: underline;
  }

  .eh-layer {
    position: fixed;
    inset: 0;
    z-index: 120;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }

  .eh-backdrop {
    position: absolute;
    inset: 0;
    border: none;
    background: rgb(0 0 0 / 70%);
    cursor: default;
  }

  .eh-dialog {
    position: relative;
    width: min(560px, 100%);
    max-height: 85vh;
    overflow-y: auto;
    padding: 1.1rem 1.2rem;
    border: 1px solid var(--h-glass-border);
    border-radius: var(--h-radius-lg);
    background: var(--h-bg-elevated);
    box-shadow: var(--h-shadow-xl);
  }

  .eh-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  h2 {
    margin: 0;
    font-size: 1.1rem;
  }

  .eh-note {
    margin: 0.5rem 0 0;
    color: var(--h-text-muted);
    font-size: 0.85rem;
  }

  .eh-list {
    margin: 0.6rem 0 0;
    padding: 0;
    list-style: none;
  }

  .eh-list li {
    padding: 0.6rem 0;
    border-bottom: 1px solid var(--h-border);
  }

  .eh-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem 0.6rem;
    color: var(--h-text-faint);
    font-size: 0.75rem;
  }

  .eh-text {
    margin: 0.25rem 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.9rem;
  }

  del {
    color: var(--h-danger, #e5484d);
    text-decoration: line-through;
  }

  ins {
    color: var(--h-success, #30a46c);
    text-decoration: underline;
  }
</style>
