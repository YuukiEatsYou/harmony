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
   * A Discord callback that stopped on the invite. Its message belongs on the
   * code, which the auth panel owns, so it is passed there rather than shown in
   * the banner: the panel opens on the register view, or on the one-more-thing
   * step when the server parked a verified identity.
   */
  let authDiscordError = $state<string | null>(null);
  let authDiscordResume = $state(false);
  /** An invite code handed over in the URL, which opens the register view. */
  let authInvite = $state('');
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
  /** The invite codes above are handled by the auth panel, not the banner. */
  const DISCORD_INVITE_ERRORS = new Set(['invite_required', 'invalid_invite', 'invite_expired', 'invite_exhausted']);

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
    // parameter. Read it once, then strip it so a reload does not replay it. An
    // invite link's code is read the same way and kept in the field.
    const params = new URLSearchParams(window.location.search);
    const ok = params.get('discord');
    const error = params.get('discord_error');
    const invite = params.get('invite')?.trim() ?? '';
    const resume = params.get('discord_resume') === '1';

    if (invite) authInvite = invite;
    if (error && DISCORD_INVITE_ERRORS.has(error)) {
      authDiscordError = error;
      authDiscordResume = resume;
    } else if (ok || error) {
      // The query string is arbitrary input, so a key is only read from our own
      // maps: `?discord_error=constructor` otherwise resolves to an inherited
      // function and its string form is rendered.
      const errorText = error && Object.hasOwn(DISCORD_ERROR, error) ? DISCORD_ERROR[error] : null;
      const okText = ok && Object.hasOwn(DISCORD_OK, ok) ? DISCORD_OK[ok] : null;
      notice = error
        ? { text: errorText ?? 'Discord sign-in failed.', kind: 'error' }
        : { text: okText ?? 'Discord connected.', kind: 'ok' };
    }
    if (invite || ok || error || resume) {
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
  <AuthPanel invite={authInvite} discordError={authDiscordError} discordResume={authDiscordResume} />
{/if}
