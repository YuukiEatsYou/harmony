/**
 * The update check: whether the version this instance runs is the newest one on
 * its update branch. The running version is `HARMONY_VERSION`; the newest is read
 * from the source file named by the `HARMONY_VERSION_SOURCE_URL` constant.
 *
 * The parsing and comparison are pure so they can be checked without a network.
 */

/** Where a release stands relative to the one this instance is running. */
export interface UpdateStatus {
  /** The version this instance is running. */
  running: string;
  /** The newest version found on the update branch, or null before a first success. */
  latest: string | null;
  /** Whether `latest` is newer than `running`. */
  available: boolean;
  /** When the last successful check ran, as an ISO string, or null. */
  checkedAt: string | null;
  /** The last failure, or null when the last check succeeded. Cleared on success. */
  error: string | null;
  /** Whether the daily automatic check is switched on. Off by default. */
  autoCheck: boolean;
  /**
   * False when no update source is configured, which is how an instance that
   * never wants to call out is set up. The manual button reports it rather than
   * pretending the instance is up to date.
   */
  enabled: boolean;
}

/** Reads the version a constants file declares, or null when it carries none. */
export function parseVersionFile(text: string): string | null {
  const match = /HARMONY_VERSION\s*=\s*'([^']+)'/.exec(text);
  return match?.[1] ?? null;
}

/**
 * Whether `latest` is a newer release than `running`. Both are dotted numbers
 * such as 1.24.2. A part that is not a plain number counts as zero, so an
 * unexpected value never reports a false update.
 */
export function isNewerVersion(latest: string, running: string): boolean {
  const a = latest.split('.');
  const b = running.split('.');
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = versionPart(a[i]);
    const right = versionPart(b[i]);
    if (left !== right) return left > right;
  }
  return false;
}

function versionPart(part: string | undefined): number {
  return part !== undefined && /^\d+$/.test(part) ? Number(part) : 0;
}
