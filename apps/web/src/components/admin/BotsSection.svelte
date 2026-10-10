<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Permission,
    namesToPermissions,
    permissionsToNames,
    permissionsToString,
    type BotListResponse,
    type BotSummary,
    type BotTokenResponse,
    type BotCreateResponse,
    type PermissionName,
  } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';
  import { avatarUrl } from '../../lib/avatar';
  import { permissionLabel } from '../../lib/format';

  const allPermissionNames = Object.keys(Permission) as PermissionName[];

  let bots = $state<BotSummary[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);
  /** The token to show once, with the bot it belongs to. Cleared on navigation. */
  let token = $state<{ name: string; value: string } | null>(null);

  // The creation form.
  let newUsername = $state('');
  let newDisplayName = $state('');
  let newAvatar = $state<File | null>(null);
  let newPermissions = $state<PermissionName[]>(['ViewChannels', 'SendMessages', 'AttachFiles', 'EmbedLinks']);

  // Inline editing of one bot.
  let editingId = $state<string | null>(null);
  let editUsername = $state('');
  let editDisplayName = $state('');
  let editPermissions = $state<PermissionName[]>([]);

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : String(cause);
  }

  async function load(): Promise<void> {
    try {
      bots = (await api<BotListResponse>('/bots')).bots;
      error = null;
    } catch (cause) {
      error = describe(cause);
    } finally {
      loading = false;
    }
  }

  async function uploadAvatar(id: string, file: File): Promise<void> {
    const form = new FormData();
    form.append('file', file);
    await api(`/bots/${id}/avatar`, { method: 'PUT', body: form });
  }

  async function create(event: Event): Promise<void> {
    event.preventDefault();
    busy = true;
    error = null;
    token = null;
    try {
      const created = await api<BotCreateResponse>('/bots', {
        method: 'POST',
        body: JSON.stringify({
          username: newUsername.trim(),
          displayName: newDisplayName.trim() || null,
          permissions: permissionsToString(namesToPermissions(newPermissions)),
        }),
      });
      if (newAvatar) await uploadAvatar(created.bot.user.id, newAvatar);
      token = { name: created.bot.user.username, value: created.token };
      newUsername = '';
      newDisplayName = '';
      newAvatar = null;
      await load();
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }

  function startEdit(bot: BotSummary): void {
    editingId = bot.user.id;
    editUsername = bot.user.username;
    editDisplayName = bot.user.displayName ?? '';
    editPermissions = permissionsToNames(BigInt(bot.permissions));
    error = null;
  }

  async function saveEdit(event: Event): Promise<void> {
    event.preventDefault();
    if (editingId === null) return;
    busy = true;
    error = null;
    try {
      await api(`/bots/${editingId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          username: editUsername.trim(),
          displayName: editDisplayName.trim() || null,
          permissions: permissionsToString(namesToPermissions(editPermissions)),
        }),
      });
      editingId = null;
      await load();
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }

  async function regenerate(bot: BotSummary): Promise<void> {
    if (!window.confirm(`Issue a new token for ${bot.user.username}? The old one stops working at once.`)) return;
    error = null;
    try {
      const result = await api<BotTokenResponse>(`/bots/${bot.user.id}/token`, { method: 'POST' });
      token = { name: bot.user.username, value: result.token };
      await load();
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function remove(bot: BotSummary): Promise<void> {
    if (!window.confirm(`Delete ${bot.user.username}? Its token stops working immediately.`)) return;
    error = null;
    try {
      await api(`/bots/${bot.user.id}`, { method: 'DELETE' });
      if (editingId === bot.user.id) editingId = null;
      await load();
    } catch (cause) {
      error = describe(cause);
    }
  }

  onMount(() => void load());
</script>

<section>
  <h3>Bots</h3>

  <div class="panel">
    <p class="muted">
      A bot is an account you own that acts through a token instead of a password, using the same API
      and realtime connection as anyone else, limited to the permissions you give it here. Granting a
      bot the Administrator permission makes its token effectively root on the instance, so give it
      only what it needs. Only you, the owner, can see or change them.
    </p>
    {#if error}<p class="form-error">{error}</p>{/if}
    {#if token}
      <div class="status ok">
        <p><strong>Token for {token.name}</strong> — copy it now. It is shown once and stored only as a hash.</p>
        <pre class="update-command">{token.value}</pre>
        <div class="editor-actions">
          <button type="button" onclick={() => (token = null)}>Done</button>
        </div>
      </div>
    {/if}
  </div>

  <div class="panel">
    <h2>Add a bot</h2>
    <form onsubmit={create}>
      <label>
        Username
        <input bind:value={newUsername} required maxlength="32" placeholder="helper" />
      </label>
      <label>
        Display name
        <input bind:value={newDisplayName} maxlength="32" placeholder="Optional" />
      </label>
      <label>
        Profile picture
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          onchange={(event) => (newAvatar = (event.currentTarget as HTMLInputElement).files?.[0] ?? null)}
        />
      </label>
      <fieldset>
        <legend>Permissions</legend>
        <div class="perms">
          {#each allPermissionNames as name (name)}
            <label class="checkbox">
              <input type="checkbox" value={name} bind:group={newPermissions} />
              {permissionLabel(name)}
            </label>
          {/each}
        </div>
      </fieldset>
      <div class="editor-actions">
        <button type="submit" class="primary" disabled={busy || newUsername.trim().length === 0}>
          {busy ? 'Creating…' : 'Create bot'}
        </button>
      </div>
    </form>
  </div>

  <div class="panel">
    <h2>Bots</h2>
    {#if loading}
      <p class="muted">Loading…</p>
    {:else if bots.length === 0}
      <p class="muted">No bots yet.</p>
    {:else}
      <div class="rows">
        {#each bots as bot (bot.user.id)}
          <div class="row">
            <img class="avatar small" src={avatarUrl(bot.user)} alt="" />
            <div class="grow">
              <strong>{bot.user.displayName ?? bot.user.username}</strong>
              <span class="muted">@{bot.user.username}</span>
              <p class="muted">
                {permissionsToNames(BigInt(bot.permissions)).map(permissionLabel).join(', ') || 'No permissions'}
              </p>
              <p class="muted">
                {bot.lastUsedAt ? `Last used ${new Date(bot.lastUsedAt).toLocaleString()}` : 'Never used'}
              </p>
            </div>
            <button type="button" onclick={() => startEdit(bot)}>Edit</button>
            <button type="button" onclick={() => regenerate(bot)}>New token</button>
            <button type="button" class="danger" onclick={() => remove(bot)}>Delete</button>
          </div>
          {#if editingId === bot.user.id}
            <form class="editor" onsubmit={saveEdit}>
              <label>
                Username
                <input bind:value={editUsername} required maxlength="32" />
              </label>
              <label>
                Display name
                <input bind:value={editDisplayName} maxlength="32" placeholder="Optional" />
              </label>
              <fieldset>
                <legend>Permissions</legend>
                <div class="perms">
                  {#each allPermissionNames as name (name)}
                    <label class="checkbox">
                      <input type="checkbox" value={name} bind:group={editPermissions} />
                      {permissionLabel(name)}
                    </label>
                  {/each}
                </div>
              </fieldset>
              <div class="editor-actions">
                <button type="submit" class="primary" disabled={busy}>Save</button>
                <button type="button" onclick={() => (editingId = null)}>Cancel</button>
              </div>
            </form>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</section>
