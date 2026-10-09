<script lang="ts">
  import { onMount } from 'svelte';
  import { SOCIAL_PLATFORMS, SOCIAL_PLATFORM_KEYS, socialLink, type SocialPlatform } from '@harmony/shared';
  import { avatarUrl, bannerUrl, initial } from '../lib/avatar';
  import { meta } from '../lib/meta.svelte';
  import { hexColor, profile, profileAccent } from '../lib/profile.svelte';
  import { roster } from '../lib/roster.svelte';
  import { ui } from '../lib/ui.svelte';
  import Icon from './Icon.svelte';
  import MemberBadge from './MemberBadge.svelte';
  import BotBadge from './BotBadge.svelte';

  /**
   * The full, fixed profile: the big surface a click on a member opens. The small
   * hover card is a desktop peek; this is where everything a member put on their
   * profile is shown. It is deliberately a static overlay rather than a cursor
   * popover, so it stays put while it is read.
   */

  const user = $derived(ui.profileViewerUser);
  const userId = $derived(user?.id ?? null);
  const entry = $derived(userId ? profile.get(userId) : null);
  const rosterEntry = $derived(userId ? roster.members.find((item) => item.user.id === userId) : undefined);
  const online = $derived(rosterEntry?.online ?? false);
  const roles = $derived(
    roster.roles
      .filter((role) => (rosterEntry?.roleIds ?? []).includes(role.id))
      .sort((a, b) => b.position - a.position),
  );

  const accent = $derived(user ? profileAccent(entry, user.roleColor) : null);
  /**
   * The member's profile color as a CSS color, or the theme accent when they have
   * none. It drives the panel's own gradient and the avatar's glow; the stylesheet
   * mixes it down toward the panel surface, so it is never bright enough to make
   * the text hard to read.
   */
  const accentValue = $derived(hexColor(accent) ?? 'var(--h-accent)');
  const banner = $derived(user ? bannerUrl(user.id, entry?.bannerHash ?? null) : null);
  /** The banner is an image strip; without one the panel's own gradient shows through. */
  const bannerStyle = $derived(banner ? `background-image: url(${banner})` : '');

  /** A website is the one link that leaves the instance, so it asks first. */
  let pendingUrl = $state<string | null>(null);

  const links = $derived(
    entry
      ? SOCIAL_PLATFORM_KEYS.map((platform) => ({
          platform,
          url: socialLink(platform, entry.socialLinks[platform]),
        })).filter((row): row is { platform: SocialPlatform; url: string } => row.url !== null)
      : [],
  );

  $effect(() => {
    if (userId) void profile.load(userId);
  });

  onMount(() => {
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (pendingUrl) pendingUrl = null;
      else ui.closeProfileViewer();
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  function follow(event: MouseEvent, platform: SocialPlatform, url: string): void {
    if (platform !== 'website') return;
    event.preventDefault();
    pendingUrl = url;
  }

  function proceed(): void {
    if (pendingUrl) window.open(pendingUrl, '_blank', 'noopener,noreferrer');
    pendingUrl = null;
  }
</script>

{#if user}
  <div class="admin-overlay">
    <button
      class="overlay-backdrop"
      type="button"
      aria-label="Close profile"
      onclick={() => ui.closeProfileViewer()}
    ></button>

    <div
      class="profile-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`${user.displayName ?? user.username} profile`}
      style={`--profile-accent: ${accentValue}`}
    >
      <div class="profile-viewer-banner" style={bannerStyle}>
        {#if banner}
          <span class="profile-viewer-tint"></span>
          <span class="profile-viewer-shade"></span>
        {/if}
      </div>
      <button
        class="profile-viewer-close"
        type="button"
        aria-label="Close profile"
        onclick={() => ui.closeProfileViewer()}
      >
        <Icon name="close" size={18} />
      </button>

      <div class="profile-viewer-body">
        <div class="profile-viewer-avatar">
          {#if avatarUrl(user)}
            <img class="avatar large" src={avatarUrl(user)} alt="" />
          {:else}
            <span class="avatar large fallback">{initial(user)}</span>
          {/if}
          {#if online}<span class="profile-viewer-online" title="Online"></span>{/if}
        </div>

        <div class="profile-viewer-names">
          <strong>
            {user.displayName ?? user.username}
            {#if user.badge}<MemberBadge badge={user.badge} size={15} />{/if}
            {#if user.accountType === 'bot'}<BotBadge size={15} />{/if}
            {#if user.discordId}
              {#if user.accountType === 'ghost'}
                <span class="card-linked" title="A Discord account"><Icon name="link" size={13} /></span>
              {:else}
                <span class="card-linked linked-account" title="Linked to a Discord account">
                  <Icon name="check" size={13} />
                </span>
              {/if}
            {/if}
          </strong>
          <span class="muted">@{user.username}</span>
        </div>

        {#if entry?.status}
          <p class="profile-viewer-status">{entry.status}</p>
        {/if}

        {#if entry?.bio}
          <p class="profile-viewer-bio">{entry.bio}</p>
        {/if}

        {#if links.length > 0}
          <div class="profile-viewer-links">
            {#each links as link (link.platform)}
              <a
                class="profile-viewer-link"
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                title={SOCIAL_PLATFORMS[link.platform].label}
                onclick={(event) => follow(event, link.platform, link.url)}
              >
                <Icon name="link" size={15} />
                {SOCIAL_PLATFORMS[link.platform].label}
              </a>
            {/each}
          </div>
        {/if}

        <div class="profile-viewer-fields">
          {#if user.accountType !== 'ghost'}
            <div class="profile-field">
              <span class="profile-field-label">Member since</span>
              <span>{new Date(user.createdAt).toLocaleDateString()}</span>
            </div>
          {/if}
          {#if user.discordId}
            <div class="profile-field">
              <span class="profile-field-label">Discord</span>
              <code class="profile-field-value">{user.discordId}</code>
            </div>
          {/if}
        </div>

        <div class="profile-card-roles">
          <span class="profile-field-label">Roles</span>
          {#if roles.length === 0}
            <span class="muted">No roles</span>
          {:else}
            <div class="profile-roles">
              {#each roles as role (role.id)}
                <span class="role-chip">
                  <span class="role-dot" style={`background: ${hexColor(role.color) ?? 'var(--h-text-muted)'}`}></span>
                  {role.name}
                </span>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

{#if pendingUrl}
  <!-- Leaving the instance is worth a pause: the server name is the reassurance. -->
  <div class="admin-overlay">
    <div class="profile-leave" role="alertdialog" aria-modal="true" aria-label="Leave this site">
      <h3>Leaving Harmony</h3>
      <p>
        You are about to leave <strong>{meta.serverName}</strong> and go to <code>{pendingUrl}</code>. Continue?
      </p>
      <div class="editor-actions">
        <button type="button" onclick={proceed}>Continue</button>
        <button type="button" class="ghost" onclick={() => (pendingUrl = null)}>Cancel</button>
      </div>
    </div>
  </div>
{/if}
