/**
 * Discord-style permission bitfield.
 *
 * Permissions are a single `bigint` rendered as a decimal string in the
 * database and over the wire, so adding new flags never breaks storage.
 * Living in `shared` means the server, web client and bridge bot can never
 * disagree about what a flag means.
 */

export const Permission = {
  ViewChannels: 1n << 0n,
  SendMessages: 1n << 1n,
  ManageMessages: 1n << 2n,
  AttachFiles: 1n << 3n,
  EmbedLinks: 1n << 4n,
  AddReactions: 1n << 5n,
  ManageChannels: 1n << 6n,
  ManageRoles: 1n << 7n,
  ManageEmojis: 1n << 8n,
  ManageServer: 1n << 9n,
  KickMembers: 1n << 10n,
  BanMembers: 1n << 11n,
  CreateInvites: 1n << 12n,
  MentionEveryone: 1n << 13n,
  Administrator: 1n << 14n,
  /** Put members in a timeout: they keep read access but cannot post. */
  ModerateMembers: 1n << 15n,
  /** Edit another member's account: username, display name, picture and password. */
  ManageMembers: 1n << 16n,
  /** Create, edit and cancel server events (a creator can always edit their own). */
  ManageEvents: 1n << 17n,
  /** Join a voice channel and hear the members in it. */
  ConnectVoice: 1n << 18n,
  /** Unmute a microphone in a voice channel; muting yourself is always allowed. */
  SpeakVoice: 1n << 19n,
} as const;

export type PermissionName = keyof typeof Permission;
export type PermissionValue = bigint;

/** Every known permission OR-ed together. */
export const ALL_PERMISSIONS: PermissionValue = Object.values(Permission).reduce<PermissionValue>(
  (acc, flag) => acc | flag,
  0n,
);

/** Granted to the implicit @everyone role on a fresh instance. */
export const EVERYONE_PERMISSIONS: PermissionValue =
  Permission.ViewChannels |
  Permission.SendMessages |
  Permission.AttachFiles |
  Permission.AddReactions |
  Permission.CreateInvites |
  // Voice is open to everyone out of the box, as it is on Discord; a moderator
  // can still take it away by editing @everyone.
  Permission.ConnectVoice |
  Permission.SpeakVoice;

/** `Administrator` implies every other flag. */
export function hasPermission(granted: PermissionValue, required: PermissionValue): boolean {
  if ((granted & Permission.Administrator) === Permission.Administrator) return true;
  return (granted & required) === required;
}

/** True when the member holds any one of the listed permissions. */
export function hasAnyPermission(
  granted: PermissionValue,
  required: readonly PermissionValue[],
): boolean {
  return required.some((flag) => hasPermission(granted, flag));
}

/**
 * Permissions that unlock the member-management surface: assigning roles,
 * editing accounts, and the moderation actions. A member needs any one of them
 * to list members at all, so a moderator who can only kick is not shut out of
 * the one screen where the kick button lives.
 */
export const MEMBER_MANAGEMENT_PERMISSIONS: readonly PermissionValue[] = [
  Permission.ManageRoles,
  Permission.ManageMembers,
  Permission.KickMembers,
  Permission.BanMembers,
  Permission.ModerateMembers,
];

/**
 * Members who skip channel slowmode. Managing the channel or its messages is
 * enough, which is what Discord does too, so a moderator is never held back by
 * a cooldown meant for everyone else.
 */
export function bypassesSlowmode(permissions: PermissionValue): boolean {
  return (
    hasPermission(permissions, Permission.ManageChannels) ||
    hasPermission(permissions, Permission.ManageMessages)
  );
}

export function permissionsFromString(value: string): PermissionValue {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

export function permissionsToString(value: PermissionValue): string {
  return value.toString();
}

export function permissionsToNames(value: PermissionValue): PermissionName[] {
  return (Object.keys(Permission) as PermissionName[]).filter(
    (name) => (value & Permission[name]) !== 0n,
  );
}

export function namesToPermissions(names: readonly PermissionName[]): PermissionValue {
  return names.reduce<PermissionValue>((acc, name) => acc | Permission[name], 0n);
}
