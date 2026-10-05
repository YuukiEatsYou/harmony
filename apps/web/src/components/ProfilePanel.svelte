<script lang="ts">
  import {
    ALLOWED_IMAGE_TYPES,
    BIO_MAX,
    LIMITS,
    SOCIAL_PLATFORMS,
    SOCIAL_PLATFORM_KEYS,
    SOCIAL_VALUE_MAX,
    STATUS_MAX,
    type MeResponse,
    type UserProfile,
  } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { avatarUrl, bannerUrl, initial } from '../lib/avatar';
  import { meta } from '../lib/meta.svelte';
  import { accentGradient, hexColor, profile as profiles } from '../lib/profile.svelte';
  import { session } from '../lib/session.svelte';
  import { ui } from '../lib/ui.svelte';
  import Icon from './Icon.svelte';

  const acceptAttribute = ALLOWED_IMAGE_TYPES.join(',');

  let displayName = $state(session.user?.displayName ?? '');
  let showTyping = $state(session.user?.showTyping ?? true);
  let notifyMajor = $state(session.user?.notifyMajor ?? true);
  let notifyMinor = $state(session.user?.notifyMinor ?? true);
  let fileInput = $state<HTMLInputElement | null>(null);
  let error = $state<string | null>(null);
  let message = $state<string | null>(null);
  let busy = $state(false);

  let soundError = $state<string | null>(null);
  let soundMessage = $state<string | null>(null);
  let savingSounds = $state(false);

  let currentPassword = $state('');
  let newPassword = $state('');
  let confirmPassword = $state('');
  let passwordError = $state<string | null>(null);
  let passwordMessage = $state<string | null>(null);
  let changingPassword = $state(false);

  let discordBusy = $state(false);
  let discordError = $state<string | null>(null);
  let discordMessage = $state<string | null>(null);

  const picture = $derived(avatarUrl(session.user));

  type Tab = 'profile' | 'customize' | 'notifications' | 'password';
  let tab = $state<Tab>('profile');

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'profile', label: 'Profile' },
    { id: 'customize', label: 'Customize' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'password', label: 'Password' },
  ];

  /** Suggested profile colors, shown as swatches beside the picker. */
  const PRESET_ACCENTS = [0xe0575f, 0xe0a63a, 0x4caf7d, 0x57b0e0, 0x8b7bd8, 0xe07ab0, 0x9aa4b2];

  /** The viewer's own fetched profile: bio, status, colors and links. */
  let custom = $state<UserProfile | null>(null);
  let bio = $state('');
  let status = $state('');
  let accentColor = $state<number | null>(null);
  let socials = $state<Record<string, string>>({});
  let customizing = $state(false);
  let customError = $state<string | null>(null);
  let customMessage = $state<string | null>(null);
  let bannerInput = $state<HTMLInputElement | null>(null);
  let bannerBusy = $state(false);

  /** Banner artwork when there is one, else the accent gradient it falls back to. */
  const bannerPreview = $derived.by(() => {
    if (!session.user) return 'var(--h-accent-gradient)';
    const url = bannerUrl(session.user.id, custom?.bannerHash ?? null);
    return url
      ? `url(${url})`
      : (accentGradient(accentColor ?? custom?.avatarColor ?? session.user.roleColor) ?? 'var(--h-accent-gradient)');
  });

  /** The chosen (or picture's) color as a gradient, used to tint a banner image. */
  const accentCss = $derived(accentGradient(accentColor ?? custom?.avatarColor ?? session.user?.roleColor ?? null));

  async function loadCustom(): Promise<void> {
    if (!session.user) return;
    const loaded = await profiles.load(session.user.id);
    if (!loaded) return;
    custom = loaded;
    bio = loaded.bio;
    status = loaded.status;
    accentColor = loaded.accentColor;
    socials = { ...loaded.socialLinks };
  }

  /** Switching to Customize loads the profile the first time it is opened. */
  function selectTab(next: Tab): void {
    tab = next;
    if (next === 'customize' && custom === null) void loadCustom();
  }

  async function saveCustom(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    customizing = true;
    customError = null;
    customMessage = null;
    try {
      const links: Record<string, string> = {};
      for (const key of SOCIAL_PLATFORM_KEYS) {
        const value = socials[key]?.trim();
        if (value) links[key] = value;
      }
      apply(
        await api<MeResponse>('/users/@me', {
          method: 'PATCH',
          body: JSON.stringify({ bio, status, accentColor, socialLinks: links }),
        }),
      );
      await loadCustom();
      customMessage = 'Profile saved.';
    } catch (cause) {
      customError = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      customizing = false;
    }
  }

  async function uploadBanner(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    bannerBusy = true;
    customError = null;
    customMessage = null;
    try {
      const form = new FormData();
      form.append('file', file);
      apply(await api<MeResponse>('/users/@me/banner', { method: 'PUT', body: form }));
      await loadCustom();
      customMessage = 'Banner updated.';
    } catch (cause) {
      customError = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      bannerBusy = false;
    }
  }

  async function removeBanner(): Promise<void> {
    bannerBusy = true;
    customError = null;
    customMessage = null;
    try {
      apply(await api<MeResponse>('/users/@me/banner', { method: 'DELETE' }));
      await loadCustom();
      customMessage = 'Banner removed.';
    } catch (cause) {
      customError = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      bannerBusy = false;
    }
  }

  /** A `#rrggbb` from the color input as a packed integer. */
  function parseHexColor(hex: string): number {
    return Number.parseInt(hex.slice(1), 16);
  }

  function apply(data: MeResponse): void {
    session.user = data.user;
    session.permissions = data.permissions;
    displayName = data.user.displayName ?? '';
    showTyping = data.user.showTyping;
    notifyMajor = data.user.notifyMajor;
    notifyMinor = data.user.notifyMinor;
  }

  function fail(cause: unknown): void {
    error = cause instanceof ApiError ? cause.message : String(cause);
  }

  async function saveName(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    error = null;
    message = null;
    try {
      apply(
        await api<MeResponse>('/users/@me', {
          method: 'PATCH',
          body: JSON.stringify({ displayName: displayName.trim() || null, showTyping }),
        }),
      );
      message = 'Profile saved.';
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  async function uploadAvatar(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    busy = true;
    error = null;
    message = null;
    try {
      const form = new FormData();
      form.append('file', file);
      apply(await api<MeResponse>('/users/@me/avatar', { method: 'PUT', body: form }));
      message = 'Profile picture updated.';
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  async function removeAvatar(): Promise<void> {
    busy = true;
    error = null;
    message = null;
    try {
      apply(await api<MeResponse>('/users/@me/avatar', { method: 'DELETE' }));
      message = 'Profile picture removed.';
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  async function saveSounds(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    savingSounds = true;
    soundError = null;
    soundMessage = null;
    try {
      apply(
        await api<MeResponse>('/users/@me', {
          method: 'PATCH',
          body: JSON.stringify({ notifyMajor, notifyMinor }),
        }),
      );
      soundMessage = 'Notification sounds saved.';
    } catch (cause) {
      soundError = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      savingSounds = false;
    }
  }

  async function disconnectDiscord(): Promise<void> {
    discordBusy = true;
    discordError = null;
    discordMessage = null;
    try {
      await api('/users/@me/discord', { method: 'DELETE' });
      apply(await api<MeResponse>('/auth/me'));
      discordMessage = 'Discord disconnected.';
    } catch (cause) {
      discordError = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      discordBusy = false;
    }
  }

  async function changePassword(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    passwordError = null;
    passwordMessage = null;
    if (newPassword !== confirmPassword) {
      passwordError = 'The two new passwords do not match.';
      return;
    }

    changingPassword = true;
    const hadPassword = session.user?.hasPassword ?? true;
    try {
      await api('/users/@me/password', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword: hadPassword ? currentPassword : undefined, newPassword }),
      });
      currentPassword = '';
      newPassword = '';
      confirmPassword = '';
      passwordMessage = hadPassword
        ? 'Password changed. Your other devices have been signed out.'
        : 'Password set. You can now log in with your username too.';
      apply(await api<MeResponse>('/auth/me'));
    } catch (cause) {
      passwordError = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      changingPassword = false;
    }
  }
</script>

<div class="admin-overlay">
  <div class="admin profile-panel">
    <nav class="admin-nav">
      <h2>Your account</h2>
      {#each TABS as entry (entry.id)}
        <button class="admin-tab" class:active={tab === entry.id} type="button" onclick={() => selectTab(entry.id)}>
          {entry.label}
        </button>
      {/each}
      <button class="admin-close" type="button" onclick={() => ui.closeProfile()}>Close</button>
    </nav>

    <div class="admin-body">
      {#if tab === 'profile'}
        <h3>Your profile</h3>

        <div class="profile-avatar">
          {#if picture}
            <img class="avatar large" src={picture} alt="" />
          {:else}
            <span class="avatar large fallback">{initial(session.user)}</span>
          {/if}

          <div class="editor-actions">
            <button type="button" onclick={() => fileInput?.click()} disabled={busy}>Change picture</button>
            {#if picture}
              <button type="button" class="danger" onclick={removeAvatar} disabled={busy}>Remove</button>
            {/if}
            <input
              class="file-input"
              type="file"
              accept={acceptAttribute}
              bind:this={fileInput}
              onchange={uploadAvatar}
            />
          </div>
        </div>

        <form onsubmit={saveName}>
          <label>
            Display name
            <input bind:value={displayName} maxlength={LIMITS.displayName.max} placeholder={session.user?.username} />
          </label>
          <p class="muted">Leave this blank to show your username, {session.user?.username}.</p>

          <label class="checkbox">
            <input type="checkbox" bind:checked={showTyping} />
            Typing indicators
          </label>
          <p class="muted">See when other people are typing, and let them see when you are.</p>

          {#if error}<p class="form-error">{error}</p>{/if}
          {#if message}<p class="ok-text">{message}</p>{/if}

          <div class="editor-actions">
            <button type="submit" disabled={busy}>Save</button>
          </div>
        </form>

        <div class="panel">
          <h2>Discord</h2>
          {#if session.user?.discordId}
            <p>Connected to <code>{session.user.discordId}</code>.</p>
            <p class="muted">
              You are pinged on Discord when someone mentions you here, and your Discord messages
              appear under this account.
            </p>
            {#if !session.user?.hasPassword}
              <p class="muted">
                Discord is how you sign in. Set a password on the Password tab if you want to be able to
                disconnect it.
              </p>
            {/if}
            <div class="editor-actions">
              <button
                type="button"
                class="danger"
                onclick={disconnectDiscord}
                disabled={discordBusy || !session.user?.hasPassword}
              >
                Disconnect
              </button>
            </div>
          {:else if meta.discordAuthEnabled}
            <p class="muted">
              Connect your Discord account so mentions here reach you there, and your Discord
              messages appear under this account.
            </p>
            <a class="button-link" href="/api/v1/auth/discord?intent=link">
              <Icon name="link" size={16} /> Connect Discord
            </a>
          {:else}
            <p class="muted">An administrator can link your Discord account to this one.</p>
          {/if}
          {#if discordError}<p class="form-error">{discordError}</p>{/if}
          {#if discordMessage}<p class="ok-text">{discordMessage}</p>{/if}
        </div>
      {:else if tab === 'customize'}
        <h3>Customize your profile</h3>

        <form onsubmit={saveCustom}>
          <p class="custom-label">Banner</p>
          <div class="custom-banner" style={`background-image: ${bannerPreview}`}>
            {#if custom?.bannerHash && accentCss}
              <span class="custom-banner-tint" style={`background-image: ${accentCss}`}></span>
            {/if}
            <div class="editor-actions">
              <button type="button" onclick={() => bannerInput?.click()} disabled={bannerBusy}>Change banner</button>
              {#if custom?.bannerHash}
                <button type="button" class="danger" onclick={removeBanner} disabled={bannerBusy}>Remove</button>
              {/if}
            </div>
          </div>
          <input
            class="file-input"
            type="file"
            accept={acceptAttribute}
            bind:this={bannerInput}
            onchange={uploadBanner}
          />

          <p class="custom-label">Profile color</p>
          <div class="custom-accent">
            <input
              type="color"
              aria-label="Profile color"
              value={hexColor(accentColor) ?? hexColor(custom?.avatarColor) ?? '#8b7bd8'}
              oninput={(event) => (accentColor = parseHexColor((event.currentTarget as HTMLInputElement).value))}
            />
            <button type="button" class="ghost" onclick={() => (accentColor = null)}>Use my picture's color</button>
            <div class="custom-presets">
              {#each PRESET_ACCENTS as preset (preset)}
                <button
                  type="button"
                  class="custom-preset"
                  aria-label={`Use color ${hexColor(preset)}`}
                  style={`background: ${hexColor(preset)}`}
                  onclick={() => (accentColor = preset)}
                ></button>
              {/each}
            </div>
          </div>
          <p class="muted">Colors your banner and profile. Leaving it as your picture's color is the default.</p>

          <label>
            Custom status
            <input bind:value={status} maxlength={STATUS_MAX} placeholder="What are you up to?" />
          </label>

          <label>
            About me
            <textarea bind:value={bio} maxlength={BIO_MAX} rows="3" placeholder="A few words about you"></textarea>
          </label>

          <fieldset class="custom-links">
            <legend>Links</legend>
            {#each SOCIAL_PLATFORM_KEYS as key (key)}
              <label>
                {SOCIAL_PLATFORMS[key].label}
                <input
                  bind:value={socials[key]}
                  maxlength={SOCIAL_VALUE_MAX}
                  placeholder={SOCIAL_PLATFORMS[key].placeholder}
                />
              </label>
            {/each}
          </fieldset>

          {#if customError}<p class="form-error">{customError}</p>{/if}
          {#if customMessage}<p class="ok-text">{customMessage}</p>{/if}

          <div class="editor-actions">
            <button type="submit" disabled={customizing}>Save</button>
          </div>
        </form>
      {:else if tab === 'notifications'}
        <h3>Notifications</h3>

        <form onsubmit={saveSounds}>
          <label class="checkbox">
            <input type="checkbox" bind:checked={notifyMajor} />
            Someone mentions me
          </label>
          <p class="muted">
            The louder sound, for a reply to one of your messages or a message that names you.
          </p>

          <label class="checkbox">
            <input type="checkbox" bind:checked={notifyMinor} />
            New messages in the channel I am reading
          </label>
          <p class="muted">The quieter sound. Messages in other channels stay silent.</p>

          <p class="muted">
            Sounds only play while Harmony is open in a tab or window. Nothing is ever sent to your phone or
            desktop.
          </p>

          {#if soundError}<p class="form-error">{soundError}</p>{/if}
          {#if soundMessage}<p class="ok-text">{soundMessage}</p>{/if}

          <div class="editor-actions">
            <button type="submit" disabled={savingSounds}>Save</button>
          </div>
        </form>
      {:else}
        <h3>{session.user?.hasPassword ? 'Change password' : 'Set a password'}</h3>

        <form onsubmit={changePassword}>
          {#if session.user?.hasPassword}
            <label>
              Current password
              <input
                type="password"
                bind:value={currentPassword}
                autocomplete="current-password"
                maxlength={LIMITS.password.max}
              />
            </label>
          {:else}
            <p class="muted">
              You signed up with Discord, so you have no password yet. Setting one lets you log in with your
              username <code>{session.user?.username}</code> as well.
            </p>
          {/if}

          <label>
            New password
            <input
              type="password"
              bind:value={newPassword}
              autocomplete="new-password"
              minlength={LIMITS.password.min}
              maxlength={LIMITS.password.max}
            />
          </label>

          <label>
            Confirm new password
            <input
              type="password"
              bind:value={confirmPassword}
              autocomplete="new-password"
              minlength={LIMITS.password.min}
              maxlength={LIMITS.password.max}
            />
          </label>

          <p class="muted">Changing your password signs out every other device. Ask an admin if you have forgotten it.</p>

          {#if passwordError}<p class="form-error">{passwordError}</p>{/if}
          {#if passwordMessage}<p class="ok-text">{passwordMessage}</p>{/if}

          <div class="editor-actions">
            <button type="submit" disabled={changingPassword || (session.user?.hasPassword && !currentPassword) || !newPassword}>
              {session.user?.hasPassword ? 'Change password' : 'Set password'}
            </button>
          </div>
        </form>
      {/if}
    </div>
  </div>
</div>
