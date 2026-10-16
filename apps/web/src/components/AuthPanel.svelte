<script lang="ts">
  import { onMount } from 'svelte';
  import type { AuthResponse, DiscordStartResponse, InviteCheckResponse, MeResponse } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { meta } from '../lib/meta.svelte';
  import { session } from '../lib/session.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    /** An invite code handed over in the URL, from an invite link. */
    invite?: string;
    /** A Discord callback that stopped on the invite, so its message belongs on the code. */
    discordError?: string | null;
    /** True when the server kept the verified Discord identity and needs only the code. */
    discordResume?: boolean;
  }
  let { invite = '', discordError = null, discordResume = false }: Props = $props();

  /** The typed code survives a Discord round trip, so a failure is not retyped. */
  const STORAGE_KEY = 'harmony.inviteCode';

  /** The states of the pre-flight check, as a person experiences them. */
  type InviteState = 'idle' | 'checking' | 'valid' | 'invalid' | 'expired' | 'exhausted' | 'unavailable';

  /** What the callback's invite codes mean to a person, in the panel's own words. */
  const DISCORD_INVITE_MESSAGE: Record<string, string> = {
    invite_required: 'This server needs an invite code to join.',
    invalid_invite: 'That invite code is not valid.',
    invite_expired: 'That invite code has expired.',
    invite_exhausted: 'That invite code has already been used up.',
  };

  function storedInvite(): string {
    try {
      return sessionStorage.getItem(STORAGE_KEY) ?? '';
    } catch {
      // Private mode, or storage disabled: start empty.
      return '';
    }
  }

  // The props are read once on purpose: the panel is mounted per visit, and the
  // URL-derived starting point is the state from here on.
  // svelte-ignore state_referenced_locally
  const opened = {
    mode: invite || discordError ? ('register' as const) : ('login' as const),
    resume: discordResume,
    invite: invite.trim() || storedInvite(),
    error: discordError ? (DISCORD_INVITE_MESSAGE[discordError] ?? null) : null,
  };

  let mode = $state<'login' | 'register'>(opened.mode);
  let resume = $state(opened.resume);
  let username = $state('');
  let password = $state('');
  let inviteCode = $state(opened.invite);
  let error = $state<string | null>(opened.error);
  let busy = $state(false);
  let inviteState = $state<InviteState>('idle');
  let inviteInput = $state<HTMLInputElement | null>(null);

  let debounce: ReturnType<typeof setTimeout> | null = null;
  /** A ticket for the newest check, so a slow answer to an old one is ignored. */
  let checkSeq = 0;

  /** The code is typed verbatim — base64url is case-sensitive — but never padded. */
  const code = $derived(inviteCode.trim());
  /** The invite field shows only where a code is genuinely needed. */
  const inviteRequired = $derived(meta.requireInvite && (mode === 'register' || resume));
  /** Only a verified code may proceed to a local account or to Discord. */
  const verified = $derived(!inviteRequired || inviteState === 'valid');
  const canSubmit = $derived(!busy && verified);

  function rememberInvite(value: string): void {
    try {
      if (value) sessionStorage.setItem(STORAGE_KEY, value);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Not worth surfacing: the code is still in the field for this session.
    }
  }

  /**
   * Runs the pre-flight check and records its outcome. `seq` guards against a
   * response that lands after a newer check: only the newest writes the state.
   * The top-level `error` is left to the submit paths; a check that could not be
   * made reads as `unavailable` under the field.
   */
  async function requestCheck(value: string, seq: number): Promise<boolean> {
    if (seq === checkSeq) inviteState = 'checking';
    try {
      await api<InviteCheckResponse>('/invites/check', { method: 'POST', body: JSON.stringify({ code: value }) });
      if (seq !== checkSeq) return false;
      inviteState = 'valid';
      return true;
    } catch (cause) {
      if (seq !== checkSeq) return false;
      if (cause instanceof ApiError && cause.code === 'invite_expired') inviteState = 'expired';
      else if (cause instanceof ApiError && cause.code === 'invite_exhausted') inviteState = 'exhausted';
      else if (cause instanceof ApiError && cause.code === 'invalid_invite') inviteState = 'invalid';
      else inviteState = 'unavailable';
      return false;
    }
  }

  /** Re-derives the code from the server, discarding whatever was verified before. */
  function recheck(): void {
    checkSeq += 1;
    void requestCheck(code, checkSeq);
  }

  /**
   * Types into the code. A change invalidates whatever was verified before, so
   * the buttons stay off until the new code comes back clean, and the check
   * itself waits for typing to settle.
   */
  function onInviteInput(event: Event): void {
    const value = (event.currentTarget as HTMLInputElement).value.trim();
    rememberInvite(value);
    if (debounce) clearTimeout(debounce);
    checkSeq += 1;
    inviteState = value ? 'checking' : 'idle';
    if (!value) return;
    const seq = checkSeq;
    debounce = setTimeout(() => {
      debounce = null;
      void requestCheck(value, seq);
    }, 300);
  }

  function switchMode(next: 'login' | 'register'): void {
    mode = next;
    resume = false;
    error = null;
    // A code already in the field (a stored one, from an earlier attempt) is
    // verified on the way into the register view rather than left unverified.
    if (next === 'register' && inviteRequired && code && inviteState === 'idle') recheck();
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    // The button is disabled until a code is verified, but a code can also be
    // submitted with Enter, so re-check that it is still allowed.
    if (busy || !verified) return;
    error = null;

    busy = true;
    try {
      if (inviteRequired) {
        // One click, two requests: re-check first, then continue. The code may
        // have expired or been used up since the debounced check.
        if (debounce) {
          clearTimeout(debounce);
          debounce = null;
        }
        checkSeq += 1;
        const seq = checkSeq;
        if (!(await requestCheck(code, seq))) return;
      }

      if (resume) {
        await api<AuthResponse>('/auth/discord/finish', {
          method: 'POST',
          body: JSON.stringify({ inviteCode: code }),
        });
      } else {
        const body =
          mode === 'login'
            ? { username, password }
            : { username, password, inviteCode: inviteRequired ? code : undefined };
        await api<AuthResponse>(`/auth/${mode}`, { method: 'POST', body: JSON.stringify(body) });
      }

      rememberInvite('');
      const me = await api<MeResponse>('/auth/me');
      session.user = me.user;
      session.permissions = me.permissions;
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
      // A failed attempt invalidates whatever was verified before: discard it and
      // re-derive it from the server, so a code that is still good re-enables the
      // button rather than leaving it stuck.
      if (inviteRequired) {
        inviteState = 'idle';
        recheck();
      }
      // The parked Discord identity expired while the person was away; the code
      // alone cannot finish it, so fall back to the normal register view.
      if (cause instanceof ApiError && cause.code === 'discord_resume_expired') {
        resume = false;
        mode = 'register';
      }
    } finally {
      busy = false;
    }
  }

  /** Leaves the resume step so the person can use a different account. */
  function cancelResume(): void {
    resume = false;
    mode = 'register';
    error = null;
  }

  /**
   * Handing the browser to Discord is a navigation, not a fetch, so the code is
   * stashed first: a failed round trip comes back with it still typed. When a
   * code is needed the sign-in is started with a POST — the code rides in the
   * body, never in the URL the browser records or the server logs — and the
   * returned authorize URL is followed. With no code to carry it stays a plain
   * navigation.
   */
  async function startDiscord(): Promise<void> {
    if (!verified) {
      error = 'Enter a valid invite code first.';
      return;
    }
    rememberInvite(code);
    if (!inviteRequired) {
      window.location.assign('/api/v1/auth/discord');
      return;
    }
    busy = true;
    try {
      const { url } = await api<DiscordStartResponse>('/auth/discord', {
        method: 'POST',
        body: JSON.stringify({ invite: code }),
      });
      window.location.assign(url);
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
      busy = false;
    }
  }

  onMount(() => {
    // A link with a code, and a callback that stopped on the invite, both open
    // the register view ready to verify and focused on the code.
    if (inviteRequired && code) {
      checkSeq += 1;
      void requestCheck(code, checkSeq);
    }
    if ((invite || discordError) && inviteRequired) inviteInput?.focus();
  });
</script>

{#snippet inviteField()}
  <div class="invite-field">
    <label>
      Invite code
      <input
        name="inviteCode"
        bind:value={inviteCode}
        bind:this={inviteInput}
        oninput={onInviteInput}
        autocapitalize="none"
        spellcheck="false"
        autocomplete="off"
        required
      />
    </label>
    {#if inviteState === 'idle'}
      <p class="field-note">Enter your invite code to continue.</p>
    {:else if inviteState === 'checking'}
      <p class="field-note">Checking…</p>
    {:else if inviteState === 'valid'}
      <p class="field-note ok">Invite code verified.</p>
    {:else if inviteState === 'invalid'}
      <p class="field-note err">That invite code is not valid.</p>
    {:else if inviteState === 'expired'}
      <p class="field-note err">That invite code has expired.</p>
    {:else if inviteState === 'exhausted'}
      <p class="field-note err">That invite code has already been used up.</p>
    {:else if inviteState === 'unavailable'}
      <p class="field-note err">Could not check the invite code. Try again.</p>
    {/if}
  </div>
{/snippet}

<main>
  {#if resume}
    <header>
      <h1>{meta.serverName}</h1>
      <p class="muted">
        One more thing — your Discord account is verified. Enter an invite code to finish creating your account.
      </p>
    </header>

    <form onsubmit={submit}>
      {@render inviteField()}

      {#if error}
        <p class="form-error">{error}</p>
      {/if}

      <button type="submit" disabled={!canSubmit}>{busy ? 'Please wait…' : 'Finish creating account'}</button>
    </form>

    <p class="switch">
      <button type="button" class="link" onclick={cancelResume}>Use a different account</button>
    </p>
  {:else}
    <header>
      <h1>{meta.serverName}</h1>
      <p class="muted">
        {#if mode === 'login'}
          Welcome back.
        {:else if meta.requireInvite}
          Create your account — an invite code is required.
        {:else}
          Create your account.
        {/if}
      </p>
    </header>

    <form onsubmit={submit}>
      {#if inviteRequired}
        {@render inviteField()}
      {/if}

      <label>
        Username
        <input name="username" bind:value={username} autocomplete="username" required />
      </label>

      <label>
        Password
        <input
          name="password"
          type="password"
          bind:value={password}
          autocomplete={mode === 'login' ? 'current-password' : 'new-password'}
          required
        />
      </label>

      {#if error}
        <p class="form-error">{error}</p>
      {/if}

      <button type="submit" disabled={!canSubmit}>
        {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
      </button>
    </form>

    <p class="switch">
      {#if mode === 'login'}
        No account yet?
        <button type="button" class="link" onclick={() => switchMode('register')}>Register</button>
      {:else}
        Already have an account?
        <button type="button" class="link" onclick={() => switchMode('login')}>Log in</button>
      {/if}
    </p>

    {#if meta.discordAuthEnabled}
      <p class="or"><span>or</span></p>
      <button type="button" class="button-link discord" onclick={startDiscord} disabled={busy || !verified}>
        <Icon name="link" size={16} /> Continue with Discord
      </button>
      <p class="muted">
        New here? Continue with Discord creates your account on first use — no password needed.
      </p>
    {/if}
  {/if}
</main>
