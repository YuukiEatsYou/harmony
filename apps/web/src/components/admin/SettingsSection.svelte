<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    ALLOWED_IMAGE_TYPES,
    DEFAULT_ACCENT,
    DEFAULT_BACKGROUND,
    DEFAULT_ICON_PADDING,
    MAX_ICON_PADDING,
    MAX_SCREEN_SHARE_FRAME_RATE,
    MAX_SCREEN_SHARE_HEIGHT,
    MAX_UPLOAD_CEILING_BYTES,
    type Channel,
    type ChannelListResponse,
    type InstanceIconResponse,
    type ServerSettingsResponse,
  } from '@harmony/shared';
  import { ApiError, api } from '../../lib/api';
  import { meta } from '../../lib/meta.svelte';
  import { previewTheme, restoreTheme, setSavedTheme } from '../../lib/theme';
  import GifSourcesPanel from './GifSourcesPanel.svelte';

  let serverName = $state('');
  let requireInvite = $state(false);
  let embedsEnabled = $state(true);
  /** Empty string means "no default": fall back to the first channel. */
  let defaultChannelId = $state('');
  let channels = $state<Channel[]>([]);
  let themeBackground = $state(DEFAULT_BACKGROUND);
  let themeAccent = $state(DEFAULT_ACCENT);
  let maxImageMb = $state('');
  let maxVideoMb = $state('');
  let screenShareHeight = $state(720);
  let screenShareFrameRate = $state(30);
  let previewUserAgent = $state('');
  /** Written only: the server never sends a saved key back, so this starts blank. */
  let klipyKey = $state('');
  let klipyConfigured = $state(false);
  let gifStorage = $state<'store' | 'link'>('store');
  let iconPaddingAuto = $state(true);
  let iconPadding = $state(String(DEFAULT_ICON_PADDING));
  let iconBackgroundAuto = $state(true);
  let iconBackground = $state(DEFAULT_BACKGROUND);
  /**
   * The icon settings the server has actually stored. A preview cannot show an
   * unsaved change, since the rendering happens on the server.
   */
  let storedIcon = $state<{ padding: number | null; background: string | null }>({
    padding: null,
    background: null,
  });
  let busy = $state(false);
  let message = $state<string | null>(null);
  let error = $state<string | null>(null);

  const acceptAttribute = ALLOWED_IMAGE_TYPES.join(',');
  let iconInput = $state<HTMLInputElement | null>(null);

  const MB = 1024 * 1024;
  const ceilingMb = Math.round(MAX_UPLOAD_CEILING_BYTES / MB);

  function toMb(bytes: number): string {
    return String(Math.round((bytes / MB) * 10) / 10);
  }

  function toBytes(value: string): number | undefined {
    const parsed = Number(value.trim());
    if (!value.trim() || !Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.round(parsed * MB);
  }

  onMount(async () => {
    try {
      const [settings, channelData] = await Promise.all([
        api<ServerSettingsResponse>('/settings'),
        api<ChannelListResponse>('/channels'),
      ]);
      serverName = settings.serverName;
      requireInvite = settings.requireInvite;
      embedsEnabled = settings.embedsEnabled;
      defaultChannelId = settings.defaultChannelId ?? '';
      themeBackground = settings.theme.background ?? DEFAULT_BACKGROUND;
      themeAccent = settings.theme.accent ?? DEFAULT_ACCENT;
      maxImageMb = toMb(settings.maxImageBytes);
      maxVideoMb = toMb(settings.maxVideoBytes);
      screenShareHeight = settings.screenShareHeight;
      screenShareFrameRate = settings.screenShareFrameRate;
      previewUserAgent = settings.previewUserAgent ?? '';
      klipyConfigured = settings.klipyConfigured;
      gifStorage = settings.gifStorage;
      applyIcon(settings.icon);
      channels = channelData.channels;
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    }
  });

  // Leaving the panel undoes any color that was only being previewed.
  onDestroy(restoreTheme);

  function pickBackground(event: Event): void {
    themeBackground = (event.currentTarget as HTMLInputElement).value;
    previewTheme({ background: themeBackground, accent: themeAccent });
  }

  function pickAccent(event: Event): void {
    themeAccent = (event.currentTarget as HTMLInputElement).value;
    previewTheme({ background: themeBackground, accent: themeAccent });
  }

  function resetTheme(): void {
    themeBackground = DEFAULT_BACKGROUND;
    themeAccent = DEFAULT_ACCENT;
    previewTheme({ background: themeBackground, accent: themeAccent });
  }

  /**
   * The padding is a percentage, so it is rounded and held inside the range
   * rather than trusted: an empty or nonsense field must not become a broken icon.
   */
  function readPadding(value: string): number {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return DEFAULT_ICON_PADDING;
    return Math.min(MAX_ICON_PADDING, Math.max(0, parsed));
  }

  function applyIcon(icon: { padding: number | null; background: string | null }): void {
    storedIcon = icon;
    iconPaddingAuto = icon.padding === null;
    iconPadding = String(icon.padding ?? DEFAULT_ICON_PADDING);
    iconBackgroundAuto = icon.background === null;
    iconBackground = icon.background ?? DEFAULT_BACKGROUND;
  }

  // A stand-in for what a home screen does to the installed icon: the padding and
  // background only mean anything once they are stored, so this follows the save.
  const iconPreview = $derived(
    `/api/v1/icons/192?maskable=1&v=${[
      meta.data?.iconHash ?? 'default',
      storedIcon.padding ?? 'auto',
      storedIcon.background ?? 'auto',
    ].join('-')}`,
  );

  async function uploadIcon(event: Event): Promise<void> {
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
      const result = await api<InstanceIconResponse>('/icon', { method: 'PUT', body: form });
      meta.setIconHash(result.iconHash);
      message = 'Server icon updated.';
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function removeIcon(): Promise<void> {
    busy = true;
    error = null;
    message = null;
    try {
      const result = await api<InstanceIconResponse>('/icon', { method: 'DELETE' });
      meta.setIconHash(result.iconHash);
      message = 'Server icon reset to the default.';
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function clearKlipyKey(): Promise<void> {
    busy = true;
    error = null;
    message = null;
    try {
      const updated = await api<ServerSettingsResponse>('/settings', {
        method: 'PATCH',
        body: JSON.stringify({ klipyApiKey: '' }),
      });
      klipyConfigured = updated.klipyConfigured;
      klipyKey = '';
      if (meta.data) meta.data = { ...meta.data, klipyConfigured: updated.klipyConfigured };
      message = 'Gif key cleared.';
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    error = null;
    message = null;
    try {
      const body: Record<string, unknown> = {
        serverName: serverName.trim(),
        requireInvite,
        embedsEnabled,
        defaultChannelId: defaultChannelId || null,
        theme: { background: themeBackground, accent: themeAccent },
        icon: {
          padding: iconPaddingAuto ? null : readPadding(iconPadding),
          background: iconBackgroundAuto ? null : iconBackground,
        },
        previewUserAgent: previewUserAgent.trim(),
        gifStorage,
      };
      // Blank leaves a size unchanged rather than clearing it.
      const imageBytes = toBytes(maxImageMb);
      const videoBytes = toBytes(maxVideoMb);
      if (imageBytes !== undefined) body.maxImageBytes = imageBytes;
      if (videoBytes !== undefined) body.maxVideoBytes = videoBytes;
      body.screenShareHeight = screenShareHeight;
      body.screenShareFrameRate = screenShareFrameRate;
      // Blank means "keep the saved key", which is why it is left out entirely.
      if (klipyKey.trim()) body.klipyApiKey = klipyKey.trim();

      const updated = await api<ServerSettingsResponse>('/settings', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      serverName = updated.serverName;
      requireInvite = updated.requireInvite;
      embedsEnabled = updated.embedsEnabled;
      defaultChannelId = updated.defaultChannelId ?? '';
      themeBackground = updated.theme.background ?? DEFAULT_BACKGROUND;
      themeAccent = updated.theme.accent ?? DEFAULT_ACCENT;
      applyIcon(updated.icon);
      maxImageMb = toMb(updated.maxImageBytes);
      maxVideoMb = toMb(updated.maxVideoBytes);
      screenShareHeight = updated.screenShareHeight;
      screenShareFrameRate = updated.screenShareFrameRate;
      previewUserAgent = updated.previewUserAgent ?? '';
      klipyConfigured = updated.klipyConfigured;
      gifStorage = updated.gifStorage;
      klipyKey = '';
      // Remember the saved palette, and keep the public meta in step, so the
      // restore above falls back to what is actually stored.
      setSavedTheme(updated.theme);
      if (meta.data) {
        meta.data = {
          ...meta.data,
          theme: updated.theme,
          klipyConfigured: updated.klipyConfigured,
          gifStorage: updated.gifStorage,
        };
      }
      message = 'Settings saved.';
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h3>Server settings</h3>
  <form onsubmit={save}>
    <label>
      Server name
      <input bind:value={serverName} required maxlength="64" />
    </label>

    <label class="checkbox">
      <input type="checkbox" bind:checked={requireInvite} />
      Require an invite code to register
    </label>

    <label class="checkbox">
      <input type="checkbox" bind:checked={embedsEnabled} />
      Link previews
    </label>
    <p class="muted">
      When on, the server fetches the first link in a message to show a small preview. This makes an
      outbound request to the linked site from your server.
    </p>

    <label>
      Link preview user agent <span class="muted">(optional)</span>
      <input bind:value={previewUserAgent} placeholder="Harmony/1.0 link-preview" maxlength="200" />
    </label>
    <p class="muted">
      Some sites will not serve a preview to a client they do not recognize — many Cloudflare-backed
      ones, such as Klipy — so their links stay as plain text. Naming a user agent the site allows
      makes them preview. Leave blank to identify honestly as Harmony.
    </p>

    <label>
      Default channel
      <select bind:value={defaultChannelId}>
        <option value="">First channel</option>
        {#each channels as channel (channel.id)}
          <option value={channel.id}># {channel.name}</option>
        {/each}
      </select>
    </label>
    <p class="muted">The channel that opens automatically when someone enters the server.</p>

    <fieldset>
      <legend>Upload limits</legend>
      <div class="inline">
        <label>
          Images (MB)
          <input bind:value={maxImageMb} inputmode="decimal" />
        </label>
        <label>
          Videos (MB)
          <input bind:value={maxVideoMb} inputmode="decimal" />
        </label>
      </div>
      <p class="muted">
        The largest file a member may attach. Videos must be MP4. Leave a field as it is to keep the
        current value; the hard ceiling is {ceilingMb} MB per upload.
      </p>
    </fieldset>

    <fieldset>
      <legend>Screen sharing</legend>
      <div class="inline">
        <label>
          Height (px)
          <input type="number" min="240" max={MAX_SCREEN_SHARE_HEIGHT} step="1" bind:value={screenShareHeight} />
        </label>
        <label>
          Frames per second
          <input type="number" min="5" max={MAX_SCREEN_SHARE_FRAME_RATE} step="1" bind:value={screenShareFrameRate} />
        </label>
      </div>
      <p class="muted">
        The bound a shared screen is captured at. The relay never re-encodes, so a higher bound is
        more bandwidth for the sharer and every viewer; 720p30 suits most connections, up to
        {MAX_SCREEN_SHARE_HEIGHT}p{MAX_SCREEN_SHARE_FRAME_RATE} if the server has room.
      </p>
    </fieldset>

    <fieldset>
      <legend>Colors</legend>
      <div class="inline">
        <label>
          Background
          <input type="color" value={themeBackground} oninput={pickBackground} />
        </label>
        <label>
          Accent
          <input type="color" value={themeAccent} oninput={pickAccent} />
        </label>
        <button type="button" onclick={resetTheme}>Reset colors</button>
      </div>
      <p class="muted">
        Panel shades, text and highlight tints are all derived from these two colors, and the text
        flips between dark and light on its own. Changes preview here immediately; save to keep them.
      </p>
    </fieldset>

    <fieldset>
      <legend>Icon</legend>
      <div class="server-icon-editor">
        <img class="server-icon large" src={meta.iconUrl} alt="" />
        <div class="editor-actions">
          <button type="button" onclick={() => iconInput?.click()} disabled={busy}>Upload icon</button>
          {#if meta.data?.iconHash}
            <button type="button" class="danger" onclick={removeIcon} disabled={busy}>Use default</button>
          {/if}
          <input
            class="file-input"
            type="file"
            accept={acceptAttribute}
            bind:this={iconInput}
            onchange={uploadIcon}
          />
        </div>
      </div>
      <p class="muted">
        Shown in the browser tab and beside the server name. Square images work best; PNG, JPEG, GIF
        or WebP.
      </p>

      <div class="icon-preview-row">
        <img class="icon-preview" src={iconPreview} alt="" />
        <p class="muted">
          How an installed app icon is drawn. Phones and desktops crop an installed icon to a shape
          of their own, which is what the padding below is for. This follows what is saved, so it
          updates when you save.
        </p>
      </div>

      <label class="checkbox">
        <input type="checkbox" bind:checked={iconPaddingAuto} />
        Work the padding out from the image
      </label>
      <p class="muted">
        A picture that fills its frame gets none; a logo drawn on transparency gets 10%.
      </p>

      <label>
        Padding (%)
        <input
          type="number"
          min="0"
          max={MAX_ICON_PADDING}
          step="1"
          bind:value={iconPadding}
          disabled={iconPaddingAuto}
        />
        <span class="muted">How much of the tile to leave clear around the artwork. 0 fills it.</span>
      </label>

      <label class="checkbox">
        <input type="checkbox" bind:checked={iconBackgroundAuto} />
        Take the background color from the image
      </label>
      <label>
        Background
        <input type="color" bind:value={iconBackground} disabled={iconBackgroundAuto} />
        <span class="muted">Only ever seen where the padding leaves a gap.</span>
      </label>
    </fieldset>

    <fieldset>
      <legend>Gifs</legend>
      <label>
        Klipy API key
        {#if klipyConfigured}<span class="muted">(saved — leave blank to keep it)</span>{/if}
        <input
          type="password"
          bind:value={klipyKey}
          placeholder={klipyConfigured ? '••••••••••••' : 'Optional'}
          maxlength="200"
          autocomplete="off"
        />
      </label>
      <p class="muted">
        Adds a Klipy tab to the gif picker, searched through your server so the key is never sent to a
        browser. A free key can be made at <code>partner.klipy.com</code>. Leave blank to run the
        picker on saved and locally posted gifs alone.
      </p>
      {#if klipyConfigured}
        <div class="editor-actions">
          <button type="button" class="danger" onclick={clearKlipyKey} disabled={busy}>Clear key</button>
        </div>
      {/if}

      <label>
        Gif storage
        <select bind:value={gifStorage}>
          <option value="store">Store a copy on this server (recommended)</option>
          <option value="link">Link to the hosted service</option>
        </select>
      </label>
      <p class="muted">
        <strong>Store a copy</strong> downloads each gif that is sent and serves it from this server. Members'
        addresses stay private, and a gif survives its source disappearing, at the cost of disk space.
        <strong>Link</strong> sends no bytes through this server for gifs from Klipy, Tenor's media hosts and
        Giphy: the message just points at the gif and everyone's browser loads it from that service.
        <strong>That service then sees the IP address of everyone who views the gif</strong>, and the gif
        disappears if the service removes it. Only those known hosts are ever linked (https only, checked
        before each message is accepted); every other gif, and every Discord attachment, is still stored.
        Saving a gif to favorites always keeps a copy here. People with the page already open should reload
        after you change this.
      </p>
      <GifSourcesPanel storedMode={meta.data?.gifStorage ?? 'store'} />
    </fieldset>

    {#if error}<p class="form-error">{error}</p>{/if}
    {#if message}<p class="ok-text">{message}</p>{/if}

    <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
  </form>
</section>
