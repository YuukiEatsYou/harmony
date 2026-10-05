<script lang="ts">
  import { onMount } from 'svelte';
  import { HARMONY_REPO_URL, MAX_UPDATE_BACKUP_RETENTION } from '@harmony/shared';
  import { update } from '../../lib/update.svelte';

  /** Shown in the instructions; the same link as the About panel. */
  const repoUrl = HARMONY_REPO_URL;

  function formatWhen(value: string | null): string {
    return value === null ? 'never' : new Date(value).toLocaleString();
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }

  function onAutoCheck(event: Event): void {
    void update.setAutoCheck((event.currentTarget as HTMLInputElement).checked);
  }

  function onRetention(event: Event): void {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    void update.setBackupRetention(Math.min(MAX_UPDATE_BACKUP_RETENTION, Math.max(1, Math.round(value))));
  }

  function applyWithoutBackup(): void {
    const warning =
      'Apply the update without a database snapshot?\n\n' +
      'If the update changes the database and then fails, there may be no way to roll the data back.';
    if (window.confirm(warning)) void update.apply(false);
  }

  onMount(() => void update.load());
</script>

<section>
  <h3>Update</h3>

  <div class="panel">
    <p class="muted">This instance is running <strong>{update.running}</strong>.</p>

    {#if !update.enabled}
      <p class="muted">Update checks are switched off on this instance.</p>
    {:else}
      <p class="update-status">
        {#if update.latest === null}
          <span class="muted">No check has run yet.</span>
        {:else if update.available}
          <strong class="update-available">Version {update.latest} is available.</strong>
        {:else if update.latest === update.running}
          <span class="ok-text">Up to date with {update.latest}.</span>
        {:else}
          <span class="muted">
            This build is ahead of the update branch, which is on {update.latest}.
          </span>
        {/if}
      </p>

      <div class="editor-actions">
        <button type="button" onclick={() => update.check()} disabled={update.checking}>
          {update.checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>

      <p class="muted">Last checked: {formatWhen(update.checkedAt)}.</p>
      {#if update.error}<p class="form-error">{update.error}</p>{/if}
    {/if}
  </div>

  {#if update.enabled}
    <div class="panel">
      <label class="checkbox">
        <input type="checkbox" checked={update.autoCheck} onchange={onAutoCheck} />
        Check for updates once a day
      </label>
      <p class="muted">
        Off by default: switching it on makes this instance call out once a day to read the version
        file, which is all it fetches, and the owner is told when a newer version appears.
      </p>
    </div>
  {/if}

  {#if update.command === null}
    <div class="panel">
      <h2>How to update</h2>
      <p class="muted">From the checkout this instance runs from:</p>
      <pre class="update-command">git pull
npm ci
npm run build:web
systemctl restart harmony</pre>
      <p class="muted">
        Use whatever restarts this instance in place of the last line. The source is at
        <a href={repoUrl} target="_blank" rel="noreferrer">{repoUrl}</a>.
      </p>
      <p class="muted">
        An update button can do the first three lines for you, and restart this instance on its own,
        when the command is set in <code>HARMONY_UPDATE_COMMAND</code>.
      </p>
    </div>
  {:else}
    <div class="panel">
      <h2>Apply an update</h2>
      <p class="muted">The command this instance runs when you press the button:</p>
      <pre class="update-command">{update.command}</pre>
      <p class="muted">
        The server can take a database snapshot first, runs the command from the checkout, then
        restarts itself so the new build takes over.
      </p>

      <div class="editor-actions">
        <button
          type="button"
          class="primary"
          onclick={() => update.apply(true)}
          disabled={update.applying || update.checking}
        >
          {update.applying ? 'Updating…' : 'Backup and update'}
        </button>
        <button
          type="button"
          class="danger"
          onclick={applyWithoutBackup}
          disabled={update.applying || update.checking}
        >
          Update without backup
        </button>
      </div>

      <label>
        Snapshots to keep on disk
        <input
          type="number"
          min="1"
          max={MAX_UPDATE_BACKUP_RETENTION}
          step="1"
          value={update.backupRetention}
          onchange={onRetention}
          disabled={update.applying}
        />
        <span class="muted">The oldest snapshots are removed past this count. Three by default.</span>
      </label>

      {#if update.applying}
        <p class="muted">Updating. This page reloads on its own once the new version answers.</p>
      {/if}
      {#if update.log}
        <pre class="update-log">{update.log}</pre>
      {/if}
      {#if update.failed}
        <p class="form-error">
          The update command failed. This instance is still running the old build.
        </p>
      {/if}
    </div>

    <div class="panel">
      <h2>Snapshots</h2>
      {#if update.snapshots.length === 0}
        <p class="muted">No snapshots yet. One is taken each time you back up and update.</p>
      {:else}
        <ul class="update-snapshots">
          {#each update.snapshots as snapshot (snapshot.filename)}
            <li>
              <code>{snapshot.filename}</code>
              <span class="muted">{formatBytes(snapshot.sizeBytes)} · {formatWhen(snapshot.createdAt)}</span>
            </li>
          {/each}
        </ul>
        <p class="muted">
          These sit beside the database. Restoring one means stopping this instance and copying it
          back over <code>harmony.db</code>.
        </p>
      {/if}
    </div>
  {/if}
</section>
