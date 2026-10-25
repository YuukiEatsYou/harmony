/**
 * The launch parameters a mobile shell adds to the client URL. A notification
 * tap or a `harmony://` deep link opens the instance as
 * `?channel=<id>&message=<id>`, and the same two names are fixed by the
 * launcher's `buildInstanceUrl`, so they must not drift.
 *
 * Kept as plain functions, apart from the DOM, so the parsing and the strip
 * after handling can be checked without a browser. The ids are taken at face
 * value: whether the instance knows the channel or the message is the caller's
 * business, and an unknown id falls back to the normal default rather than
 * leaving the app blank.
 */

export interface LaunchTarget {
  /** The channel the link opens, or null when it names none. */
  channelId: string | null;
  /** The message to scroll to, or null when it names none. */
  messageId: string | null;
}

/** Reads the launch parameters out of a URL search string, such as `?channel=…&message=…`. */
export function parseLaunchParams(search: string): LaunchTarget {
  const params = new URLSearchParams(search);
  return {
    channelId: nonEmpty(params.get('channel')),
    messageId: nonEmpty(params.get('message')),
  };
}

/** Whether a target names anything worth opening. */
export function hasLaunchTarget(target: LaunchTarget): boolean {
  return target.channelId !== null || target.messageId !== null;
}

/**
 * The search string with the launch parameters removed, so a reload does not
 * replay the link. Any other parameters are kept as they were, and an empty
 * result comes back without a bare `?`.
 */
export function withoutLaunchParams(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('channel');
  params.delete('message');
  const rest = params.toString();
  return rest.length > 0 ? `?${rest}` : '';
}

/**
 * The absolute link to one message, for copying and sharing: the instance's own
 * address with the same two parameters a notification tap carries, so opening
 * it anywhere takes the reader to the message, however far back it sits. Each
 * id is encoded, so whatever an id holds reads back unchanged.
 */
export function messageLink(origin: string, channelId: string, messageId: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/?channel=${encodeURIComponent(channelId)}&message=${encodeURIComponent(messageId)}`;
}

/** A present, non-blank id, or null; an absent or blank parameter means "not named". */
function nonEmpty(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}
