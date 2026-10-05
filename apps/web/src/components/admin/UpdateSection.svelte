<script lang="ts">
  import { onMount } from 'svelte';
  import { HARMONY_REPO_URL } from '@harmony/shared';
  import { update } from '../../lib/update.svelte';

  /** Shown in the instructions; the same link as the About panel. */
  const repoUrl = HARMONY_REPO_URL;

  function formatChecked(value: string | null): string {
    return value === null ? 'never' : new Date(value).toLocaleString();
  }

  function onAutoCheck(event: Event): void {
    void update.setAutoCheck((event.currentTarget as HTMLInputElement).checked);
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

      <p class="muted">Last checked: {formatChecked(update.checkedAt)}.</p>
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
  </div>
</section>
