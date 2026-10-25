<script lang="ts">
  import { HARMONY_NAME, HARMONY_REPO_URL, HARMONY_VERSION, latestChangelog } from '@harmony/shared';
  import { changelog } from '../lib/changelog.svelte';
  import { meta } from '../lib/meta.svelte';
  import { ui } from '../lib/ui.svelte';

  /** The address without its scheme, which reads better as a link label. */
  const repoLabel = HARMONY_REPO_URL.replace(/^https?:\/\//, '');
  /** Whether there are any notes to open again; a build with an empty changelog has none. */
  const hasNotes = latestChangelog() !== null;
</script>

<div class="admin-overlay">
  <button class="overlay-close" type="button" aria-label="Close" onclick={() => ui.closeAbout()}></button>

  <div class="admin about">
    <div class="admin-body">
      <div class="about-head">
        <img class="server-icon large" src={meta.iconUrl} alt="" />
        <h3>{meta.serverName}</h3>
      </div>

      <p class="about-powered">Powered by {HARMONY_NAME}</p>

      <a class="about-link" href={HARMONY_REPO_URL} target="_blank" rel="noopener noreferrer">
        {repoLabel}
      </a>

      <p class="about-version muted">Version {HARMONY_VERSION}</p>

      <div class="editor-actions">
        <!-- Opens over this panel, so closing it lands back here. What has been seen is left alone. -->
        {#if hasNotes}
          <button type="button" class="ghost" aria-haspopup="dialog" onclick={() => changelog.openLatest()}>
            What's new
          </button>
        {/if}
        <button type="button" onclick={() => ui.closeAbout()}>Close</button>
      </div>
    </div>
  </div>
</div>
