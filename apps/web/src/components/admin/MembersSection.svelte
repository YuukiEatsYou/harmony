<script lang="ts">
  import { onMount } from 'svelte';
  import {
    ALLOWED_IMAGE_TYPES,
    Permission,
    hasPermission,
    isTimedOut,
    type MemberListResponse,
    type MemberSummary,
    type Role,
    type RoleListResponse,
  } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';
  import { roleColor } from '../../lib/format';
  import { session } from '../../lib/session.svelte';

  const acceptAttribute = ALLOWED_IMAGE_TYPES.join(',');

  let members = $state<MemberSummary[]>([]);
  let roles = $state<Role[]>([]);
  let error = $state<string | null>(null);
  let busy = $state(false);

  // The account being edited inline, and the draft values for it.
  let editingId = $state<string | null>(null);
  let editUsername = $state('');
  let editDisplayName = $state('');
  let editPassword = $state('');
  let editDiscordId = $state('');
  let editError = $state<string | null>(null);
  let avatarInput = $state<HTMLInputElement | null>(null);

  // The bridge creates a stand-in account for every Discord user it sees, which
  // would drown out real members, so they are kept in their own collapsible group.
  const humanMembers = $derived(members.filter((member) => member.user.accountType !== 'ghost'));
  const bridgeMembers = $derived(members.filter((member) => member.user.accountType === 'ghost'));

  const permissions = $derived(BigInt(session.permissions || '0'));
  const canManageRoles = $derived(hasPermission(permissions, Permission.ManageRoles));
  const canTimeout = $derived(hasPermission(permissions, Permission.ModerateMembers));
  const canKick = $derived(hasPermission(permissions, Permission.KickMembers));
  const canBan = $derived(hasPermission(permissions, Permission.BanMembers));
  const canEdit = $derived(hasPermission(permissions, Permission.ManageMembers));

  const timeoutPresets = [
    { minutes: 1, label: '1 minute' },
    { minutes: 5, label: '5 minutes' },
    { minutes: 60, label: '1 hour' },
    { minutes: 1440, label: '1 day' },
    { minutes: 10080, label: '1 week' },
  ];

  async function load(): Promise<void> {
    const [memberData, roleData] = await Promise.all([
      api<MemberListResponse>('/members'),
      api<RoleListResponse>('/roles'),
    ]);
    members = memberData.members;
    roles = roleData.roles;
  }

  onMount(() => {
    void load().catch((cause: unknown) => {
      error = cause instanceof ApiError ? cause.message : String(cause);
    });
  });

  function roleById(id: string): Role | undefined {
    return roles.find((role) => role.id === id);
  }

  function assignable(member: MemberSummary): Role[] {
    const assigned = new Set(member.roleIds);
    return roles.filter((role) => !role.isDefault && !assigned.has(role.id));
  }

  /** Nobody may moderate themselves, a stand-in, or another administrator. */
  function moderatable(member: MemberSummary): boolean {
    if (member.user.accountType !== 'user') return false;
    if (member.user.id === session.user?.id) return false;
    return !hasPermission(BigInt(member.permissions), Permission.Administrator);
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

  async function assign(userId: string, roleId: string): Promise<void> {
    if (!roleId) return;
    await run(() => api(`/members/${userId}/roles/${roleId}`, { method: 'PUT' }));
  }

  async function unassign(userId: string, roleId: string): Promise<void> {
    await run(() => api(`/members/${userId}/roles/${roleId}`, { method: 'DELETE' }));
  }

  function setTimeoutLength(userId: string, minutes: number): void {
    void run(() =>
      api(`/members/${userId}/timeout`, {
        method: 'PUT',
        body: JSON.stringify({ durationMinutes: minutes }),
      }),
    );
  }

  function clearTimeout(userId: string): void {
    void run(() => api(`/members/${userId}/timeout`, { method: 'DELETE' }));
  }

  function kick(member: MemberSummary): void {
    const name = member.user.displayName ?? member.user.username;
    if (!confirm(`Kick ${name}? They are logged out and can sign back in.`)) return;
    void run(() => api(`/members/${member.user.id}/kick`, { method: 'POST' }));
  }

  function ban(member: MemberSummary): void {
    const name = member.user.displayName ?? member.user.username;
    const reason = prompt(`Ban ${name}? They will not be able to sign in again. Optionally give a reason.`);
    if (reason === null) return;
    void run(() =>
      api(`/members/${member.user.id}/ban`, {
        method: 'PUT',
        body: JSON.stringify({ reason: reason.trim() || null }),
      }),
    );
  }

  function deleteMember(member: MemberSummary): void {
    const name = member.user.displayName ?? member.user.username;
    if (
      !confirm(
        `Delete ${name}'s account? This cannot be undone. Their messages stay behind, no longer attributed to them.`,
      )
    ) {
      return;
    }
    void run(() => api(`/members/${member.user.id}`, { method: 'DELETE' }));
  }

  /** Opens the inline account editor, seeding it with the member's current values. */
  function startEdit(member: MemberSummary): void {
    editingId = member.user.id;
    editUsername = member.user.username;
    editDisplayName = member.user.displayName ?? '';
    editPassword = '';
    editDiscordId = member.user.discordId ?? '';
    editError = null;
  }

  /** Sends only the fields that actually changed, leaving the rest untouched. */
  async function saveEdit(event: SubmitEvent, member: MemberSummary): Promise<void> {
    event.preventDefault();
    editError = null;

    const body: Record<string, unknown> = {};
    const username = editUsername.trim();
    if (username !== member.user.username) body.username = username;
    const displayName = editDisplayName.trim();
    if (displayName !== (member.user.displayName ?? '')) body.displayName = displayName || null;
    if (editPassword) body.password = editPassword;
    const discordId = editDiscordId.trim();
    if (discordId !== (member.user.discordId ?? '')) body.discordId = discordId || null;

    if (Object.keys(body).length === 0) {
      editingId = null;
      return;
    }

    busy = true;
    try {
      await api(`/members/${member.user.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      editingId = null;
      await load();
    } catch (cause) {
      editError = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function saveAvatar(event: Event, member: MemberSummary): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    busy = true;
    editError = null;
    try {
      const form = new FormData();
      form.append('file', file);
      await api(`/members/${member.user.id}/avatar`, { method: 'PUT', body: form });
      await load();
    } catch (cause) {
      editError = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function clearAvatar(member: MemberSummary): Promise<void> {
    busy = true;
    editError = null;
    try {
      await api(`/members/${member.user.id}/avatar`, { method: 'DELETE' });
      await load();
    } catch (cause) {
      editError = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h3>Members</h3>
  {#if error}<p class="form-error">{error}</p>{/if}

  {#snippet memberRow(member: MemberSummary)}
    {@const timeoutLabel =
      isTimedOut(member.user) && member.user.timedOutUntil
        ? new Date(member.user.timedOutUntil).toLocaleString()
        : null}
    <li class="member">
      <div class="member-head">
        <strong>{member.user.displayName ?? member.user.username}</strong>
        {#if member.user.displayName}<span class="muted">@{member.user.username}</span>{/if}
        {#if member.user.isOwner}<span class="badge">owner</span>{/if}
        {#if member.user.discordId}<span class="badge" title="Linked to a Discord account">Discord</span>{/if}
        {#if canEdit && member.user.accountType === 'user'}
          <button
            type="button"
            class="member-edit-toggle"
            onclick={() => (editingId === member.user.id ? (editingId = null) : startEdit(member))}
          >
            {editingId === member.user.id ? 'Close' : 'Edit'}
          </button>
        {/if}
      </div>

      {#if canEdit && member.user.accountType === 'user' && editingId === member.user.id}
        <form class="member-editor" onsubmit={(event) => saveEdit(event, member)}>
          <label>
            Username
            <input bind:value={editUsername} maxlength={32} autocomplete="off" />
          </label>
          <label>
            Display name
            <input bind:value={editDisplayName} maxlength={32} placeholder={member.user.username} />
          </label>
          <label>
            New password <span class="muted">(leave blank to keep it)</span>
            <input type="password" bind:value={editPassword} minlength={8} maxlength={200} autocomplete="new-password" />
          </label>
          <label>
            Discord ID <span class="muted">(optional)</span>
            <input
              bind:value={editDiscordId}
              inputmode="numeric"
              autocomplete="off"
              placeholder="e.g. 1398164034464776202"
            />
          </label>

          <div class="editor-actions">
            <button type="button" onclick={() => avatarInput?.click()} disabled={busy}>Change picture</button>
            {#if member.user.avatarHash}
              <button type="button" class="danger" onclick={() => clearAvatar(member)} disabled={busy}>Remove picture</button>
            {/if}
            <input
              class="file-input"
              type="file"
              accept={acceptAttribute}
              bind:this={avatarInput}
              onchange={(event) => saveAvatar(event, member)}
            />
          </div>

          {#if editError}<p class="form-error">{editError}</p>{/if}

          <div class="editor-actions">
            <button type="submit" disabled={busy || !editUsername.trim()}>Save</button>
            <button type="button" onclick={() => (editingId = null)}>Cancel</button>
          </div>
          <p class="muted">Saving a new password signs the member out everywhere; tell them the new one.</p>
          <p class="muted">
            A Discord ID links the member to their Discord account: their existing Discord messages here become
            theirs, and mentioning them pings them on Discord. Leave it blank to unlink.
          </p>
        </form>
      {/if}

      {#if canManageRoles || member.roleIds.length > 0}
        <div class="member-roles">
          {#each member.roleIds as roleId (roleId)}
            {@const role = roleById(roleId)}
            {#if role}
              <span class="chip">
                <span class="swatch" style={`background: ${roleColor(role.color)}`}></span>{role.name}
                {#if canManageRoles}
                  <button
                    type="button"
                    class="chip-remove"
                    title="Remove role"
                    onclick={() => unassign(member.user.id, roleId)}>×</button
                  >
                {/if}
              </span>
            {/if}
          {/each}

          {#if canManageRoles}
            <select
              disabled={busy || assignable(member).length === 0}
              onchange={(event) => {
                const element = event.currentTarget as HTMLSelectElement;
                void assign(member.user.id, element.value);
                element.value = '';
              }}
            >
              <option value="">Add role…</option>
              {#each assignable(member) as role (role.id)}
                <option value={role.id}>{role.name}</option>
              {/each}
            </select>
          {/if}
        </div>
      {/if}

      {#if moderatable(member)}
        <div class="member-moderation">
          {#if timeoutLabel}
            <span class="muted">Timed out until {timeoutLabel}</span>
            {#if canTimeout}
              <button type="button" onclick={() => clearTimeout(member.user.id)} disabled={busy}>
                Clear timeout
              </button>
            {/if}
          {:else if canTimeout}
            <select
              disabled={busy}
              onchange={(event) => {
                const element = event.currentTarget as HTMLSelectElement;
                const minutes = Number(element.value);
                element.value = '';
                if (minutes > 0) setTimeoutLength(member.user.id, minutes);
              }}
            >
              <option value="">Timeout…</option>
              {#each timeoutPresets as preset (preset.minutes)}
                <option value={preset.minutes}>{preset.label}</option>
              {/each}
            </select>
          {/if}

          {#if canKick}
            <button type="button" onclick={() => kick(member)} disabled={busy}>Kick</button>
          {/if}
          {#if canBan}
            <button type="button" class="danger" onclick={() => ban(member)} disabled={busy}>Ban</button>
          {/if}
          {#if canEdit}
            <button type="button" class="danger" onclick={() => deleteMember(member)} disabled={busy}>
              Delete
            </button>
          {/if}
        </div>
      {/if}
    </li>
  {/snippet}

  <ul class="rows">
    {#each humanMembers as member (member.user.id)}
      {@render memberRow(member)}
    {/each}
  </ul>

  {#if bridgeMembers.length > 0}
    <details class="member-group">
      <summary>Discord accounts <span class="muted">({bridgeMembers.length})</span></summary>
      <p class="muted">
        Stand-in accounts the bridge creates for people on Discord. They are listed here only so
        their roles and colors can be managed.
      </p>
      <ul class="rows">
        {#each bridgeMembers as member (member.user.id)}
          {@render memberRow(member)}
        {/each}
      </ul>
    </details>
  {/if}
</section>
