<script lang="ts">
  import { onMount } from 'svelte';
  import type { MeResponse, ServerSettingsResponse } from '@harmony/shared';
  import { api } from './lib/api';
  import { chat } from './lib/chat.svelte';
  import { meta } from './lib/meta.svelte';
  import { session } from './lib/session.svelte';
  import { ui } from './lib/ui.svelte';
  import AdminPanel from './components/admin/AdminPanel.svelte';
  import AboutPanel from './components/AboutPanel.svelte';
  import AuthPanel from './components/AuthPanel.svelte';
  import Chat from './components/Chat.svelte';
  import InboxPanel from './components/InboxPanel.svelte';
  import Lightbox from './components/Lightbox.svelte';
  import ProfileCard from './components/ProfileCard.svelte';
  import ProfilePanel from './components/ProfilePanel.svelte';
  import ProfileViewer from './components/ProfileViewer.svelte';
  import SearchPanel from './components/SearchPanel.svelte';
  import ScreenShare from './components/ScreenShare.svelte';
  import SetupWizard from './components/SetupWizard.svelte';

  let loading = $state(true);
  let setupOpen = $state(false);
  /**
   * A one-off message about a Discord sign-in round trip or a session the server
   * ended, shown then dismissible.
   */
  let notice = $state<{ text: string; kind: 'ok' | 'error' } | null>(null);
  /**
   * The owner whose setup has already been looked up. A plain variable, not
   * `$state`: it is bookkeeping for the effect below, not something to render.
   */
  let setupCheckedFor: string | null = null;

  // What the callback's short codes mean to a person, in the UI's own words.
  const DISCORD_OK: Record<string, string> = {
    linked: 'Discord account connected.',
    signed_in: 'Signed in with Discord.',
    signed_up: 'Welcome! Your account was created from your Discord account.',
  };
  const DISCORD_ERROR: Record<string, string> = {
    disabled: 'Discord sign-in is turned off on this instance.',
    not_signed_in: 'Sign in first, then connect Discord from your profile.',
    taken: 'That Discord account is already linked to another member.',
    invite_required: 'This server needs an invite code to join. Enter one and try again.',
    invalid_invite: 'That invite code is not valid.',
    invite_expired: 'That invite code has expired.',
    invite_exhausted: 'That invite code has already been used up.',
    account_banned: 'You have been banned from this server.',
    denied: 'Discord sign-in was cancelled.',
    failed: 'Discord sign-in could not be completed. Please try again.',
  };

  onMount(async () => {
    const metaPromise = meta.load();
    try {
      const me = await api<MeResponse>('/auth/me');
      session.user = me.user;
      session.permissions = me.permissions;
    } catch {
      // Not signed in, or the server is unreachable — show the auth panel.
    }
    await metaPromise;
    loading = false;

    // The Discord callback lands here by navigation, so its outcome is a query
    // parameter. Read it once, then strip it so a reload does not replay it.
    const params = new URLSearchParams(window.location.search);
    const ok = params.get('discord');
    const error = params.get('discord_error');
    if (ok || error) {
      notice = error
        ? { text: DISCORD_ERROR[error] ?? 'Discord sign-in failed.', kind: 'error' }
        : { text: DISCORD_OK[ok ?? ''] ?? 'Discord connected.', kind: 'ok' };
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    }
  });

  // Being kicked, banned or signed out by a password change drops straight to
  // the sign-in screen; say why, rather than leave it looking like a glitch.
  $effect(() => {
    const reason = chat.signedOutReason;
    if (!reason) return;
    notice = { text: reason, kind: 'error' };
    chat.signedOutReason = null;
  });

  /*
   * Greets the owner the first time they are signed in. This watches the session
   * instead of running once on mount, because signing in happens on this very
   * page and does not reload it; running it in `onMount` alone meant the wizard
   * only appeared after a refresh.
   */
  $effect(() => {
    const user = session.user;
    if (!user?.isOwner) {
      setupCheckedFor = null;
      return;
    }
    if (setupCheckedFor === user.id) return;
    setupCheckedFor = user.id;
    void api<ServerSettingsResponse>('/settings')
      .then((settings) => {
        setupOpen = !settings.setupCompleted;
      })
      .catch(() => {
        // Not worth blocking the app over: the admin panel exposes everything
        // the wizard would have set.
      });
  });
</script>

{#if notice}
  <div class="notice" class:error={notice.kind === 'error'} role="status">
    <span>{notice.text}</span>
    <button type="button" onclick={() => (notice = null)}>Dismiss</button>
  </div>
{/if}

{#if loading}
  <main><p class="muted">Loading…</p></main>
{:else if session.user}
  <Chat />
  {#if ui.adminOpen}
    <AdminPanel />
  {/if}
  {#if ui.profileOpen}
    <ProfilePanel />
  {/if}
  {#if ui.profileViewerUser}
    <ProfileViewer />
  {/if}
  {#if ui.aboutOpen}
    <AboutPanel />
  {/if}
  {#if ui.searchOpen}
    <SearchPanel onclose={() => ui.closeSearch()} />
  {/if}
  {#if ui.inboxOpen}
    <InboxPanel onclose={() => ui.closeInbox()} />
  {/if}
  {#if setupOpen}
    <SetupWizard onclose={() => (setupOpen = false)} />
  {/if}
  <ProfileCard />
  <Lightbox />
  <ScreenShare />
{:else}
  <AuthPanel />
{/if}
