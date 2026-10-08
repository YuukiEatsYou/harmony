<script lang="ts">
  import { onMount } from 'svelte';
  import {
    SLOWMODE_CHOICES,
    formatSlowmode,
    type Category,
    type Channel,
    type ChannelImportResponse,
    type ChannelListResponse,
    type DiscordChannelImportPreview,
    type DiscordChannelListResponse,
    type DiscordChannelOption,
    type Role,
    type RoleListResponse,
  } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';

  let categories = $state<Category[]>([]);
  let channels = $state<Channel[]>([]);
  let roles = $state<Role[]>([]);
  let discordChannels = $state<DiscordChannelOption[]>([]);
  let newChannelName = $state('');
  let newChannelType = $state<'text' | 'voice'>('text');
  let newChannelCategory = $state('');
  let newChannelDiscord = $state('');
  let newCategoryName = $state('');
  let editing = $state<{ kind: 'channel' | 'category'; id: string; name: string } | null>(null);
  let importPreview = $state<DiscordChannelImportPreview | null>(null);
  /** Discord channel ids ticked for import. */
  let selected = $state<Set<string>>(new Set());
  let importMessage = $state<string | null>(null);
  let importOk = $state(false);
  let error = $state<string | null>(null);
  let busy = $state(false);

  /** Discord channels that are not bridged yet, i.e. the importable ones. */
  const unbridgedIds = $derived(
    importPreview?.groups.flatMap((group) =>
      group.channels.filter((channel) => !channel.bridged).map((channel) => channel.id),
    ) ?? [],
  );

  async function load(): Promise<void> {
    const data = await api<ChannelListResponse>('/channels');
    categories = data.categories;
    channels = data.channels;
  }

  onMount(() => {
    void load().catch((cause: unknown) => {
      error = cause instanceof ApiError ? cause.message : String(cause);
    });
    // @everyone is implicit, so it is never a useful requirement.
    void api<RoleListResponse>('/roles')
      .then((data) => {
        roles = data.roles.filter((role) => !role.isDefault);
      })
      .catch(() => {
        roles = [];
      });
    // Only available once the Discord bridge is connected; ignore failures.
    void api<DiscordChannelListResponse>('/bridge/channels')
      .then((data) => {
        discordChannels = data.channels;
      })
      .catch(() => {
        discordChannels = [];
      });
  });

  function channelsIn(categoryId: string | null): Channel[] {
    return channels.filter((channel) => channel.categoryId === categoryId);
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    busy = true;
    error = null;
    try {
      await action();
      await load();
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  function createChannel(event: SubmitEvent): void {
    event.preventDefault();
    const name = newChannelName.trim();
    if (!name) return;
    void run(async () => {
      await api('/channels', {
        method: 'POST',
        body: JSON.stringify({
          name,
          type: newChannelType,
          categoryId: newChannelCategory || null,
          discordChannelId: newChannelDiscord || null,
        }),
      });
      newChannelName = '';
      newChannelDiscord = '';
    });
  }

  function createCategory(event: SubmitEvent): void {
    event.preventDefault();
    const name = newCategoryName.trim();
    if (!name) return;
    void run(async () => {
      await api('/categories', { method: 'POST', body: JSON.stringify({ name }) });
      newCategoryName = '';
    });
  }

  function setMapping(channel: Channel, discordChannelId: string): void {
    void run(async () => {
      await api(`/channels/${channel.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ discordChannelId: discordChannelId || null }),
      });
    });
  }

  /** Recategorizing sends the channel to the end of its new category. */
  function setCategory(channel: Channel, categoryId: string): void {
    void run(async () => {
      await api(`/channels/${channel.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ categoryId: categoryId || null }),
      });
    });
  }

  /** Seconds a member must wait between messages; 0 turns slowmode off. */
  function setSlowmode(channel: Channel, seconds: number): void {
    void run(async () => {
      await api(`/channels/${channel.id}`, { method: 'PATCH', body: JSON.stringify({ slowmodeSeconds: seconds }) });
    });
  }

  function moveChannel(channel: Channel, direction: 'up' | 'down'): void {
    void run(() => api(`/channels/${channel.id}/move`, { method: 'POST', body: JSON.stringify({ direction }) }));
  }

  function moveCategory(category: Category, direction: 'up' | 'down'): void {
    void run(() => api(`/categories/${category.id}/move`, { method: 'POST', body: JSON.stringify({ direction }) }));
  }

  /** Requires one role to see a channel or category. Empty means open. */
  function setRequiredRole(kind: 'channel' | 'category', id: string, roleId: string): void {
    void run(async () => {
      const path = kind === 'channel' ? `/channels/${id}` : `/categories/${id}`;
      await api(path, { method: 'PATCH', body: JSON.stringify({ requiredRoleId: roleId || null }) });
    });
  }

  function saveRename(): void {
    if (!editing) return;
    const { kind, id, name } = editing;
    void run(async () => {
      const path = kind === 'channel' ? `/channels/${id}` : `/categories/${id}`;
      await api(path, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
      editing = null;
    });
  }

  function describeImport(result: ChannelImportResponse): { text: string; ok: boolean } {
    if (result.imported === 0 && result.failed === 0) {
      return {
        text: result.skipped > 0 ? 'Every Discord channel is already bridged.' : 'There was nothing to import.',
        ok: true,
      };
    }
    const parts = [`imported ${result.imported}`];
    if (result.categoriesCreated > 0) parts.push(`${result.categoriesCreated} categories created`);
    if (result.skipped > 0) parts.push(`${result.skipped} already bridged`);
    if (result.failed > 0) parts.push(`${result.failed} nothing could be done with`);
    return { text: `Channel import finished: ${parts.join(', ')}.`, ok: result.failed === 0 };
  }

  /** Ticks or unticks one Discord channel for import. */
  function toggleSelected(id: string, on: boolean): void {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    selected = next;
  }

  /** Lists the linked server's channels before importing, so the admin can choose. */
  async function checkDiscordChannels(): Promise<void> {
    busy = true;
    error = null;
    importMessage = null;
    try {
      const preview = await api<DiscordChannelImportPreview>('/channels/discord');
      importPreview = preview;
      // Everything not bridged yet starts ticked; the owner unticks what they
      // would rather bring over later.
      selected = new Set(
        preview.groups.flatMap((group) =>
          group.channels.filter((channel) => !channel.bridged).map((channel) => channel.id),
        ),
      );
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function importChannels(): Promise<void> {
    busy = true;
    error = null;
    try {
      const result = await api<ChannelImportResponse>('/channels/import', {
        method: 'POST',
        body: JSON.stringify({ channelIds: [...selected] }),
      });
      const described = describeImport(result);
      importOk = described.ok;
      importMessage = described.text;
      importPreview = null;
      await load();
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

{#snippet moveButtons(index: number, count: number, onMove: (direction: 'up' | 'down') => void)}
  <button type="button" class="move" title="Move up" disabled={busy || index === 0} onclick={() => onMove('up')}
    >↑</button
  >
  <button
    type="button"
    class="move"
    title="Move down"
    disabled={busy || index === count - 1}
    onclick={() => onMove('down')}>↓</button
  >
{/snippet}

{#snippet roleSelect(kind: 'channel' | 'category', id: string, current: string | null)}
  <select title="Role required to see this" value={current ?? ''} onchange={(event) => setRequiredRole(kind, id, event.currentTarget.value)}>
    <option value="">Open to everyone</option>
    {#each roles as role (role.id)}
      <option value={role.id}>{role.name}</option>
    {/each}
  </select>
{/snippet}

{#snippet discordSelect(channel: Channel)}
  <select
    title="Discord channel to sync with"
    value={channel.discordChannelId ?? ''}
    onchange={(event) => setMapping(channel, event.currentTarget.value)}
  >
    <option value="">Not bridged</option>
    {#if channel.discordChannelId && !discordChannels.some((option) => option.id === channel.discordChannelId)}
      <option value={channel.discordChannelId}>{channel.discordChannelId}</option>
    {/if}
    {#each discordChannels as option (option.id)}
      <option value={option.id}>#{option.name}</option>
    {/each}
  </select>
{/snippet}

{#snippet slowmodeSelect(channel: Channel)}
  <select
    title="Slowmode: how long members must wait between messages"
    value={String(channel.slowmodeSeconds)}
    onchange={(event) => setSlowmode(channel, Number(event.currentTarget.value))}
  >
    {#if !SLOWMODE_CHOICES.some((choice) => choice.seconds === channel.slowmodeSeconds)}
      <option value={String(channel.slowmodeSeconds)}>{formatSlowmode(channel.slowmodeSeconds)}</option>
    {/if}
    {#each SLOWMODE_CHOICES as choice (choice.seconds)}
      <option value={String(choice.seconds)}>{choice.label}</option>
    {/each}
  </select>
{/snippet}

{#snippet channelRow(channel: Channel, index: number, count: number)}
  <div class="row channel-row">
    {#if editing?.kind === 'channel' && editing.id === channel.id}
      <input bind:value={editing.name} />
      <button type="button" onclick={saveRename} disabled={busy}>Save</button>
      <button type="button" onclick={() => (editing = null)}>Cancel</button>
    {:else}
      {@render moveButtons(index, count, (direction) => moveChannel(channel, direction))}
      <span class="grow">{channel.type === 'voice' ? 'Voice ·' : '#'} {channel.name}</span>
      <select
        title="Category"
        value={channel.categoryId ?? ''}
        onchange={(event) => setCategory(channel, event.currentTarget.value)}
      >
        <option value="">No category</option>
        {#each categories as category (category.id)}
          <option value={category.id}>{category.name}</option>
        {/each}
      </select>
      {@render roleSelect('channel', channel.id, channel.requiredRoleId)}
      {#if channel.type !== 'voice'}
        <!-- Slowmode and a Discord bridge apply to text channels only. -->
        {@render slowmodeSelect(channel)}
        {@render discordSelect(channel)}
      {/if}
      <button
        type="button"
        onclick={() => (editing = { kind: 'channel', id: channel.id, name: channel.name })}>Rename</button
      >
      <button
        type="button"
        class="danger"
        onclick={() => run(() => api(`/channels/${channel.id}`, { method: 'DELETE' }))}>Delete</button
      >
    {/if}
  </div>
{/snippet}

{#snippet channelRows(list: Channel[])}
  {#each list as channel, index (channel.id)}
    {@render channelRow(channel, index, list.length)}
  {/each}
{/snippet}

<section>
  <h3>Channels</h3>
  {#if error}<p class="form-error">{error}</p>{/if}

  <div class="inline-forms">
    <form class="inline" onsubmit={createCategory}>
      <input bind:value={newCategoryName} placeholder="New category" required maxlength="64" />
      <button type="submit" disabled={busy}>Add category</button>
    </form>

    <form class="inline" onsubmit={createChannel}>
      <input bind:value={newChannelName} placeholder="New channel" required maxlength="64" />
      <select bind:value={newChannelType} title="Channel type">
        <option value="text">Text</option>
        <option value="voice">Voice</option>
      </select>
      <select bind:value={newChannelCategory}>
        <option value="">No category</option>
        {#each categories as category (category.id)}
          <option value={category.id}>{category.name}</option>
        {/each}
      </select>
      <select bind:value={newChannelDiscord} title="Discord channel to sync with">
        <option value="">Not bridged</option>
        {#each discordChannels as option (option.id)}
          <option value={option.id}>#{option.name}</option>
        {/each}
      </select>
      <button type="submit" disabled={busy}>Add channel</button>
    </form>
  </div>

  {#if discordChannels.length === 0}
    <p class="muted">Connect the Discord bridge to link channels for syncing.</p>
  {/if}

  <div class="panel">
    <h2>Import from Discord</h2>
    <p class="muted">
      Recreate the linked Discord server's channels here, in the same categories, and bridge each one
      so messages sync. Channels already bridged are skipped, so it is safe to run more than once.
    </p>

    <div class="editor-actions">
      <button type="button" onclick={checkDiscordChannels} disabled={busy}>Check Discord channels</button>
      {#if unbridgedIds.length > 0}
        <button type="button" onclick={importChannels} disabled={busy || selected.size === 0}>
          Import {selected.size} of {unbridgedIds.length}
        </button>
        <button type="button" onclick={() => (selected = new Set(unbridgedIds))} disabled={busy}>Select all</button>
        <button type="button" onclick={() => (selected = new Set())} disabled={busy}>Select none</button>
        <button type="button" onclick={() => (importPreview = null)} disabled={busy}>Cancel</button>
      {/if}
    </div>

    {#if importPreview}
      {#if importPreview.guildName === null}
        <p class="muted">The Discord bridge is not connected. Set a bot token in the Bridge panel first.</p>
      {:else if importPreview.groups.length === 0}
        <p class="muted">No text channels found in <strong>{importPreview.guildName}</strong>.</p>
      {:else}
        <p class="muted">
          {importPreview.groups.reduce((total, group) => total + group.channels.length, 0)} channels in
          <strong>{importPreview.guildName}</strong>{#if unbridgedIds.length > 0}, {unbridgedIds.length} new{:else}, all already bridged{/if}.
        </p>
        {#each importPreview.groups as group (group.categoryName ?? '')}
          <div class="group">
            <div class="group-head"><strong class="grow">{group.categoryName ?? 'No category'}</strong></div>
            <ul class="import-list">
              {#each group.channels as channel (channel.id)}
                <li>
                  <label class="checkbox">
                    <input
                      type="checkbox"
                      disabled={channel.bridged || busy}
                      checked={channel.bridged || selected.has(channel.id)}
                      onchange={(event) => toggleSelected(channel.id, event.currentTarget.checked)}
                    />
                    #{channel.name}
                    {#if channel.bridged}<span class="muted">already bridged</span>{/if}
                  </label>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      {/if}
    {/if}

    {#if importMessage}
      <p class={importOk ? 'ok-text' : 'form-error'}>{importMessage}</p>
    {/if}
  </div>

  {#each categories as category, index (category.id)}
    {@const list = channelsIn(category.id)}
    <div class="group">
      <div class="group-head">
        {#if editing?.kind === 'category' && editing.id === category.id}
          <input bind:value={editing.name} />
          <button type="button" onclick={saveRename} disabled={busy}>Save</button>
          <button type="button" onclick={() => (editing = null)}>Cancel</button>
        {:else}
          {@render moveButtons(index, categories.length, (direction) => moveCategory(category, direction))}
          <strong class="grow">{category.name}</strong>
          {@render roleSelect('category', category.id, category.requiredRoleId)}
          <button
            type="button"
            onclick={() => (editing = { kind: 'category', id: category.id, name: category.name })}>Rename</button
          >
          <button
            type="button"
            class="danger"
            disabled={busy || list.length > 0}
            title={list.length === 0 ? 'Delete this category' : 'Move or delete its channels first'}
            onclick={() => run(() => api(`/categories/${category.id}`, { method: 'DELETE' }))}>Delete</button
          >
        {/if}
      </div>

      {@render channelRows(list)}
    </div>
  {/each}

  {@render channelRows(channelsIn(null))}
</section>
