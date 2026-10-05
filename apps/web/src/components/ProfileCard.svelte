<script lang="ts">
  import { onMount } from 'svelte';
  import { avatarUrl, bannerUrl, initial } from '../lib/avatar';
  import { profileCard } from '../lib/profile-card.svelte';
  import { accentGradient, profile, profileAccent } from '../lib/profile.svelte';
  import { roster } from '../lib/roster.svelte';
  import Icon from './Icon.svelte';
  import MemberBadge from './MemberBadge.svelte';

  let card = $state<HTMLDivElement | null>(null);
  let left = $state(0);
  let top = $state(0);

  const user = $derived(profileCard.user);
  /** The full profile, so the card can show the banner and the member's color. */
  const cardProfile = $derived(user ? profile.get(user.id) : null);
  const cardBanner = $derived(user ? bannerUrl(user.id, cardProfile?.bannerHash ?? null) : null);
  const roleIds = $derived(
    user ? (roster.members.find((entry) => entry.user.id === user.id)?.roleIds ?? []) : [],
  );
  const roles = $derived(
    roster.roles.filter((role) => roleIds.includes(role.id)).sort((a, b) => b.position - a.position),
  );
  const bannerStyle = $derived(
    cardBanner
      ? `background-image: url(${cardBanner}); background-size: cover; background-position: center;`
      : `background: ${accentGradient(profileAccent(cardProfile, user?.roleColor ?? null)) ?? 'var(--h-accent-gradient)'};`,
  );

  $effect(() => {
    if (user) void profile.load(user.id);
  });

  function colorHex(value: number | null): string {
    return value == null ? 'var(--h-text-muted)' : `#${value.toString(16).padStart(6, '0')}`;
  }

  // Placed after render so the card can measure itself and stay on screen.
  $effect(() => {
    const anchor = profileCard.rect;
    const element = card;
    if (!anchor || !element) return;

    const margin = 8;
    const width = element.offsetWidth;
    const height = element.offsetHeight;

    let x = anchor.left;
    if (x + width > window.innerWidth - margin) x = window.innerWidth - margin - width;
    if (x < margin) x = margin;

    let y = anchor.bottom + 6;
    if (y + height > window.innerHeight - margin) y = anchor.top - 6 - height;
    if (y < margin) y = margin;

    /*
     * Snap to whole pixels. The anchor comes from rem-based padding, so it is
     * usually fractional, and the entrance animation composites the card and
     * then hands it back to the page; a fractional origin makes the icon badge,
     * avatar and checkmark settle a hair off after the animation ends. Landing
     * on integers keeps that detail still, the way the clamped roster case
     * already does.
     */
    left = Math.round(x);
    top = Math.round(y);
  });

  onMount(() => {
    // Any click outside the card, or its trigger, dismisses it.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (target?.closest('.profile-card') || target?.closest('.profile-trigger')) return;
      profileCard.hide();
    };
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') profileCard.hide();
    };
    // Moving on would leave the card pointing at nothing.
    const onMove = (): void => profileCard.hide();

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);

    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeydown);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  });
</script>

{#if user && profileCard.rect}
  <div
    class="profile-card"
    bind:this={card}
    style={`left: ${left}px; top: ${top}px`}
    role="dialog"
    tabindex="-1"
    aria-label={`${user.displayName ?? user.username} profile`}
    onmouseenter={() => profileCard.cancelHide()}
    onmouseleave={() => profileCard.scheduleHide()}
  >
    <div class="profile-card-banner" style={bannerStyle}></div>

    <div class="profile-card-body">
      <div class="profile-card-avatar-wrap">
        {#if avatarUrl(user)}
          <img class="avatar large" src={avatarUrl(user)} alt="" />
        {:else}
          <span class="avatar large fallback">{initial(user)}</span>
        {/if}
      </div>

      <div class="profile-card-names">
        <strong>
          {user.displayName ?? user.username}
          {#if user.badge}<MemberBadge badge={user.badge} size={14} />{/if}
          {#if user.discordId}
            {#if user.isBot}
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

      <!-- A Discord stand-in was never a member here, so it has no join date. -->
      {#if !user.isBot || user.discordId}
        <div class="profile-card-fields">
          {#if !user.isBot}
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
      {/if}

      <div class="profile-card-roles">
        <span class="profile-field-label">Roles</span>
        {#if roles.length === 0}
          <span class="muted">No roles</span>
        {:else}
          <div class="profile-roles">
            {#each roles as role (role.id)}
              <span class="role-chip">
                <span class="role-dot" style={`background: ${colorHex(role.color)}`}></span>
                {role.name}
              </span>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
