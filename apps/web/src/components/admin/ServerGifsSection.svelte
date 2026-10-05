<script lang="ts">
  import { onMount } from 'svelte';
  import type { Attachment, GifItem, ServerGif, ServerGifManageResponse } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';
  import { gifs } from '../../lib/gifs.svelte';
  import { formatTags, moveInOrder, orderCurated, parseTags } from '../../lib/server-gifs';

  let curated = $state<ServerGif[]>([]);
  let hidden = $state<ServerGif[]>([]);
  let auto = $state<GifItem[]>([]);
  /** Unsaved name and tag edits, by gif id; a card with an entry shows a Save button. */
  let drafts = $state<Record<string, { name: string; tags: string }>>({});
  let newName = $state('');
  let newTags = $state('');
  let newUrl = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let busy = $state(false);

  function fail(cause: unknown): void {
    notice = null;
    error = cause instanceof ApiError ? cause.message : String(cause);
  }

  async function load(): Promise<void> {
    const body = await api<ServerGifManageResponse>('/gifs/server/manage');
    curated = orderCurated(body.curated);
    hidden = body.hidden;
    auto = body.auto;
  }

  onMount(() => {
    void load().catch(fail);
  });

  // The server announces every change, ours included, so the lists follow along
  // (and follow another administrator's edits) without each action refetching by hand.
  let seenVersion = gifs.serverVersion;
  $effect(() => {
    const version = gifs.serverVersion;
    if (version === seenVersion) return;
    seenVersion = version;
    void load().catch(fail);
  });

  /** Runs one change, then shows its result; errors land in the banner. */
  async function run(action: () => Promise<unknown>, done?: string): Promise<void> {
    busy = true;
    error = null;
    notice = null;
    try {
      await action();
      await load();
      if (done) notice = done;
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  function draftOf(gif: ServerGif): { name: string; tags: string } {
    return drafts[gif.id] ?? { name: gif.name, tags: formatTags(gif.tags) };
  }

  function edit(gif: ServerGif, patch: Partial<{ name: string; tags: string }>): void {
    drafts = { ...drafts, [gif.id]: { ...draftOf(gif), ...patch } };
  }

  function save(gif: ServerGif): Promise<void> {
    const draft = draftOf(gif);
    return run(async () => {
      await api(`/gifs/server/${gif.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: draft.name.trim(), tags: parseTags(draft.tags) }),
      });
      const { [gif.id]: _saved, ...rest } = drafts;
      drafts = rest;
    }, 'Saved.');
  }

  function togglePin(gif: ServerGif): Promise<void> {
    return run(() => api(`/gifs/server/${gif.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: !gif.pinned }) }));
  }

  function move(gif: ServerGif, delta: -1 | 1): Promise<void> {
    const ids = moveInOrder(curated, gif.id, delta);
    return run(() => api('/gifs/server/order', { method: 'POST', body: JSON.stringify({ ids }) }));
  }

  function remove(gif: ServerGif): Promise<void> {
    return run(() => api(`/gifs/server/${gif.id}`, { method: 'DELETE' }), 'Removed.');
  }

  function curate(gif: GifItem): Promise<void> {
    return run(() => api('/gifs/server', { method: 'POST', body: JSON.stringify({ attachmentId: gif.id }) }), 'Added.');
  }

  function hide(gif: GifItem): Promise<void> {
    return run(
      () => api('/gifs/server/hide', { method: 'POST', body: JSON.stringify({ attachmentId: gif.id }) }),
      'Hidden from the Server tab.',
    );
  }

  function unhide(gif: ServerGif): Promise<void> {
    return run(() => api(`/gifs/server/${gif.id}`, { method: 'DELETE' }), 'Restored to the Server tab.');
  }

  /** Adds a gif from the chosen file or the pasted address, whichever was given. */
  async function add(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const file = fileInput?.files?.[0];
    const url = newUrl.trim();
    if (!file && url.length === 0) {
      error = 'Choose a gif file or paste a Klipy address.';
      return;
    }

    await run(async () => {
      const extras = { name: newName.trim() || undefined, tags: parseTags(newTags) };
      if (file) {
        // The ordinary upload path: it validates the picture and stores the bytes,
        // and the server then copies the reference into the curated list.
        const form = new FormData();
        form.append('file', file);
        const attachment = await api<Attachment>('/attachments', { method: 'POST', body: form });
        await api('/gifs/server', { method: 'POST', body: JSON.stringify({ attachmentId: attachment.id, ...extras }) });
      } else {
        await api('/gifs/server', { method: 'POST', body: JSON.stringify({ url, ...extras }) });
      }
      newName = '';
      newTags = '';
      newUrl = '';
      if (fileInput) fileInput.value = '';
    }, 'Added.');
  }
</script>

<section>
  <h3>Server gifs</h3>
  <p class="muted">
    The <strong>Server</strong> tab in the gif picker shows the gifs you curate here first, pinned ones on top,
    then the gifs members have posted in channels they can see. Each curated gif is a copy kept on this server, so it
    stays even if the message or the website it came from goes away.
  </p>

  <form class="panel sg-add" onsubmit={add}>
    <h2>Add a gif</h2>
    <div class="inline">
      <input type="file" accept="image/gif" bind:this={fileInput} aria-label="Gif file" />
      <span class="muted">or</span>
      <input bind:value={newUrl} placeholder="Klipy gif address" maxlength="2048" aria-label="Klipy gif address" />
    </div>
    <div class="inline">
      <input bind:value={newName} placeholder="Name (optional)" maxlength="60" aria-label="Name" />
      <input bind:value={newTags} placeholder="Tags, e.g. happy, dance" aria-label="Tags" />
      <button type="submit" disabled={busy}>Add gif</button>
    </div>
  </form>

  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  {#if notice}<p class="ok-text" role="status">{notice}</p>{/if}

  <h4>Curated ({curated.length})</h4>
  {#if curated.length === 0}
    <p class="muted">Nothing curated yet. Add a gif above, or pick one from the list below.</p>
  {:else}
    <ul class="sg-grid">
      {#each curated as gif, index (gif.id)}
        {@const draft = draftOf(gif)}
        <li class="sg-card" class:pinned={gif.pinned}>
          <img src={`/api/v1/gifs/server/${gif.id}/image`} alt={gif.name || gif.filename} loading="lazy" />
          <input
            value={draft.name}
            oninput={(event) => edit(gif, { name: event.currentTarget.value })}
            maxlength="60"
            placeholder="Name"
            aria-label={`Name of ${gif.filename}`}
          />
          <input
            value={draft.tags}
            oninput={(event) => edit(gif, { tags: event.currentTarget.value })}
            placeholder="Tags"
            aria-label={`Tags of ${gif.filename}`}
          />
          <div class="sg-actions">
            <button
              type="button"
              onclick={() => move(gif, -1)}
              disabled={busy || index === 0 || curated[index - 1]?.pinned !== gif.pinned}
              aria-label={`Move ${gif.name || gif.filename} earlier`}
              title="Move earlier"
            >
              ↑
            </button>
            <button
              type="button"
              onclick={() => move(gif, 1)}
              disabled={busy || index === curated.length - 1 || curated[index + 1]?.pinned !== gif.pinned}
              aria-label={`Move ${gif.name || gif.filename} later`}
              title="Move later"
            >
              ↓
            </button>
            <button type="button" aria-pressed={gif.pinned} onclick={() => togglePin(gif)} disabled={busy}>
              {gif.pinned ? 'Unpin' : 'Pin'}
            </button>
            {#if drafts[gif.id]}
              <button type="button" onclick={() => save(gif)} disabled={busy}>Save</button>
            {/if}
            <button type="button" class="danger" onclick={() => remove(gif)} disabled={busy}>Remove</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <h4>Collected from channels ({auto.length})</h4>
  <p class="muted">
    Gifs members posted that the Server tab lists after your curated ones. Hide one to take it off the list for
    everyone, or add it to your curated gifs to keep it for good.
  </p>
  {#if auto.length === 0}
    <p class="muted">No gifs have been posted yet.</p>
  {:else}
    <ul class="sg-grid">
      {#each auto as gif (gif.id)}
        <li class="sg-card">
          <img src={`/api/v1/attachments/${gif.id}`} alt={gif.filename} loading="lazy" />
          <span class="sg-name" title={gif.filename}>{gif.filename}</span>
          <div class="sg-actions">
            <button type="button" onclick={() => curate(gif)} disabled={busy}>Add to curated</button>
            <button type="button" onclick={() => hide(gif)} disabled={busy}>Hide</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if hidden.length > 0}
    <h4>Hidden ({hidden.length})</h4>
    <ul class="sg-grid">
      {#each hidden as gif (gif.id)}
        <li class="sg-card sg-hidden">
          <img src={`/api/v1/gifs/server/${gif.id}/image`} alt={gif.filename} loading="lazy" />
          <span class="sg-name" title={gif.filename}>{gif.filename}</span>
          <div class="sg-actions">
            <button type="button" onclick={() => unhide(gif)} disabled={busy}>Unhide</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
