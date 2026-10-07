<script lang="ts">
  import { permissionsFromString } from '@harmony/shared';
  import { session } from '../../lib/session.svelte';
  import { ui } from '../../lib/ui.svelte';
  import { visibleAdminTabs, type AdminTabId } from '../../lib/admin';
  import BansSection from './BansSection.svelte';
  import AuditSection from './AuditSection.svelte';
  import BackupSection from './BackupSection.svelte';
  import ChannelsSection from './ChannelsSection.svelte';
  import BridgeSection from './BridgeSection.svelte';
  import EmojisSection from './EmojisSection.svelte';
  import ServerGifsSection from './ServerGifsSection.svelte';
  import InvitesSection from './InvitesSection.svelte';
  import MediaSection from './MediaSection.svelte';
  import MembersSection from './MembersSection.svelte';
  import RetentionSection from './RetentionSection.svelte';
  import RolesSection from './RolesSection.svelte';
  import ColorsSection from './ColorsSection.svelte';
  import ServerLogSection from './ServerLogSection.svelte';
  import BotsSection from './BotsSection.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import UpdateSection from './UpdateSection.svelte';

  const permissions = $derived(permissionsFromString(session.permissions || '0'));
  const isOwner = $derived(session.user?.isOwner === true);
  const visibleTabs = $derived(visibleAdminTabs(permissions, isOwner));

  let selected = $state<AdminTabId>(ui.adminTab);
  // Fall back to the first available tab if the selected one is not permitted.
  const active = $derived(
    visibleTabs.some((tab) => tab.id === selected) ? selected : (visibleTabs[0]?.id ?? 'settings'),
  );
</script>

<div class="admin-overlay">
  <div class="admin">
    <nav class="admin-nav">
      <h2>Admin</h2>
      {#each visibleTabs as tab (tab.id)}
        <button class="admin-tab" class:active={active === tab.id} type="button" onclick={() => (selected = tab.id)}>
          {tab.label}
        </button>
      {/each}
      <button class="admin-close" type="button" onclick={() => ui.closeAdmin()}>Close</button>
    </nav>

    <div class="admin-body">
      {#if active === 'settings'}
        <SettingsSection />
      {:else if active === 'roles'}
        <RolesSection />
      {:else if active === 'colors'}
        <ColorsSection />
      {:else if active === 'members'}
        <MembersSection />
      {:else if active === 'channels'}
        <ChannelsSection />
      {:else if active === 'emojis'}
        <EmojisSection />
      {:else if active === 'server-gifs'}
        <ServerGifsSection />
      {:else if active === 'media'}
        <MediaSection />
      {:else if active === 'retention'}
        <RetentionSection />
      {:else if active === 'bridge'}
        <BridgeSection />
      {:else if active === 'bans'}
        <BansSection />
      {:else if active === 'audit'}
        <AuditSection />
      {:else if active === 'server-log'}
        <ServerLogSection />
      {:else if active === 'bots'}
        <BotsSection />
      {:else if active === 'update'}
        <UpdateSection />
      {:else if active === 'backup'}
        <BackupSection />
      {:else}
        <InvitesSection />
      {/if}
    </div>
  </div>
</div>
