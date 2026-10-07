import { MEMBER_MANAGEMENT_PERMISSIONS, Permission, hasAnyPermission, type PermissionValue } from '@harmony/shared';

export type AdminTabId =
  | 'settings'
  | 'roles'
  | 'colors'
  | 'members'
  | 'channels'
  | 'emojis'
  | 'server-gifs'
  | 'media'
  | 'retention'
  | 'bridge'
  | 'invites'
  | 'bans'
  | 'audit'
  | 'server-log'
  | 'bots'
  | 'update'
  | 'backup';

/**
 * Every admin tab, with the permissions that unlock it. A tab shows when the
 * member holds any one of them, so the Members tab reaches both a role manager
 * and a plain moderator. This list is the single source of truth: the sidebar
 * button and the panel both read from it, so they cannot disagree about who
 * should see what.
 *
 * A tab flagged `ownerOnly` additionally requires `User.isOwner`, because its
 * contents are for the instance owner alone, not every administrator.
 */
export const ADMIN_TABS: ReadonlyArray<{
  id: AdminTabId;
  label: string;
  permissions: readonly PermissionValue[];
  ownerOnly?: boolean;
}> = [
  { id: 'settings', label: 'Settings', permissions: [Permission.ManageServer] },
  { id: 'roles', label: 'Roles', permissions: [Permission.ManageRoles] },
  { id: 'colors', label: 'Colors', permissions: [Permission.ManageServer] },
  { id: 'members', label: 'Members', permissions: MEMBER_MANAGEMENT_PERMISSIONS },
  { id: 'channels', label: 'Channels', permissions: [Permission.ManageChannels] },
  { id: 'emojis', label: 'Emojis', permissions: [Permission.ManageEmojis] },
  { id: 'server-gifs', label: 'Server gifs', permissions: [Permission.ManageEmojis] },
  { id: 'media', label: 'Media', permissions: [Permission.ManageServer] },
  { id: 'retention', label: 'Retention', permissions: [Permission.ManageServer] },
  { id: 'bridge', label: 'Bridge', permissions: [Permission.ManageServer] },
  { id: 'invites', label: 'Invites', permissions: [Permission.ManageServer] },
  { id: 'bans', label: 'Bans', permissions: [Permission.BanMembers] },
  { id: 'audit', label: 'Log', permissions: [Permission.ManageServer] },
  // The server log can carry internals a non-owner administrator should not see.
  { id: 'server-log', label: 'Server log', permissions: [Permission.ManageServer], ownerOnly: true },
  // A bot token is a credential that acts as the bot, so bots are the owner's alone.
  { id: 'bots', label: 'Bots', permissions: [Permission.ManageServer], ownerOnly: true },
  // The owner runs the machine, so the update check is theirs alone.
  { id: 'update', label: 'Update', permissions: [Permission.ManageServer], ownerOnly: true },
  // The full backup inside is owner-only; the tab also holds channel exports.
  { id: 'backup', label: 'Backup', permissions: [Permission.ManageServer] },
];

/** The tabs a member may open, in the order they are shown. */
export function visibleAdminTabs(
  granted: PermissionValue,
  isOwner = false,
): ReadonlyArray<(typeof ADMIN_TABS)[number]> {
  return ADMIN_TABS.filter(
    (tab) => hasAnyPermission(granted, tab.permissions) && (!tab.ownerOnly || isOwner),
  );
}

/** Whether the member can open the admin panel at all, for any reason. */
export function canOpenAdminPanel(granted: PermissionValue): boolean {
  return ADMIN_TABS.some((tab) => hasAnyPermission(granted, tab.permissions));
}
