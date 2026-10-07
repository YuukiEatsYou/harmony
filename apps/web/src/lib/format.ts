/** Turns a permission key like `ManageMessages` into `Manage Messages`. */
export function permissionLabel(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/** Formats an RGB integer as a CSS color. */
export function roleColor(color: number | null): string {
  return color == null ? 'var(--h-text-muted)' : hexColor(color);
}

/** `#rrggbb` for a packed RGB integer. */
function hexColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/**
 * Whether a member's name is drawn in a role color. A role color is shown with a
 * glow, which is how the client tells it apart from a color the member picked
 * from the palette.
 */
export function nameColorGlow(user: { roleColor: number | null } | null | undefined): boolean {
  return user?.roleColor != null;
}

/**
 * The inline style drawing a member's name in their color, or an empty string for
 * the default. A role color wins over a chosen one, so the name shows their
 * strongest colour and the caller adds the glow with `nameColorGlow`.
 */
export function nameColorStyle(user: { roleColor: number | null; nameColor: number | null } | null | undefined): string {
  const color = user?.roleColor ?? user?.nameColor;
  return color == null ? '' : `color: ${hexColor(color)}`;
}

/** Human-readable byte size, e.g. `1.5 GB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
