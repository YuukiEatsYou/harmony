/**
 * The decisions behind the app-wide keyboard layer: which shortcut, if any, a
 * key press is, given what the page looked like when it went down. Kept apart
 * from `KeyboardShortcuts.svelte`, which only gathers that picture and carries
 * the answer out, so the rules can be checked by `npm run smoke:text` without a
 * page.
 *
 * "Ctrl" throughout means either Ctrl or Cmd, since an Apple keyboard puts the
 * same shortcuts on Cmd and a press of either is taken the same way.
 */

/** The parts of a key press the layer looks at, as a `KeyboardEvent` carries them. */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /**
   * AltGr, which many layouts need for characters such as @, € or {. Windows
   * reports it as Ctrl and Alt held together, so without this those characters
   * would look like shortcuts rather than typing.
   */
  altGraph?: boolean;
}

/** What the page looked like when the key went down. */
export interface KeyScene {
  /** Something earlier already acted on this key, by calling `preventDefault`. */
  handled: boolean;
  /**
   * A modal panel (admin, search, inbox, pins, a profile and so on), a dialog
   * registered as a modal layer (edit history, "What's new") or the lightbox
   * covers the chat.
   */
  panel: boolean;
  /** The quick switcher or the shortcut list, the keyboard layer's own dialogs, is open. */
  dialog: boolean;
  /** A menu, picker, popover or drawer is open over the chat; each takes its own keys. */
  popover: boolean;
  /** One of those is the channel or member drawer of a narrow screen. */
  drawer: boolean;
  /** A profile card is showing. It closes on Escape but takes no typing. */
  card: boolean;
  /** Focus is in a field that takes text. */
  typing: boolean;
  /** That field is the message box. */
  inComposer: boolean;
  /** The message box is on the page and can be typed into. */
  composerReady: boolean;
  /** A text channel is open. */
  channelOpen: boolean;
  /** The open channel shows a "new" line or is still marked unread, so Escape has something to clear. */
  hasNew: boolean;
  /** This member is connected to a voice channel. */
  inVoice: boolean;
}

export type GlobalShortcut =
  | { action: 'switcher' }
  | { action: 'help' }
  | { action: 'close-dialog' }
  | { action: 'close-panel' }
  | { action: 'search' }
  | { action: 'inbox' }
  | { action: 'pins' }
  | { action: 'members' }
  | { action: 'step'; direction: 1 | -1; unreadOnly: boolean }
  | { action: 'dismiss-new' }
  | { action: 'read-all' }
  | { action: 'mute' }
  | { action: 'deafen' }
  | { action: 'type' };

/**
 * Whether a key press types a character: one character, with no shortcut
 * modifier held. Space is left out, so a focused list or page still scrolls
 * with it instead of the press jumping into the message box.
 */
export function typesCharacter(press: KeyPress): boolean {
  // Spread, so a character outside the Basic Multilingual Plane (an emoji from
  // an on-screen keyboard) counts as the one character it is.
  if ([...press.key].length !== 1 || press.key === ' ') return false;
  if (press.metaKey) return false;
  if (press.altGraph) return true;
  return !press.ctrlKey && !press.altKey;
}

/**
 * The shortcut a key press is, or null when it is not one and should be left
 * to the page and the browser. Only a non-null answer is acted on, and every
 * one but `type` (which has to reach the message box) is the layer's to keep,
 * so the browser's own meaning for the keys is prevented.
 *
 * The rules, in the order they apply:
 * - A key something else already used is never taken again.
 * - Mute and deafen work from anywhere while connected to voice, panels and
 *   text boxes included: they are about the call, not about what is on screen.
 * - Ctrl+K works from text boxes, as in Discord. It and everything else stays
 *   quiet while a panel covers the chat, where acting would happen out of
 *   sight; there Ctrl+F, Ctrl+P and the rest keep the browser's meaning.
 * - While the quick switcher or the shortcut list is open only they answer:
 *   Escape closes and Ctrl+/ toggles the list.
 * - A plain Escape over a panel, or over a narrow screen's drawer, closes it.
 *   Most panels have no Escape of their own, so nothing else would. Whatever
 *   sits over the panel and closes on Escape itself (the lightbox, a menu, a
 *   picture's dialog) marks the key as used, and the caller acts on this one
 *   only after every handler has had the key, so that press closes only the
 *   top thing.
 * - Ctrl+F (search) and Ctrl+P (pins) work from text boxes too, since neither
 *   key means anything to a text box.
 * - Escape and Shift+Escape mark read when nothing is open over the chat that
 *   Escape would close. In a text box only the message box lets them through,
 *   and only once the composer has nothing of its own to back out of (it calls
 *   `preventDefault` when it does).
 * - The rest wait until focus is out of the text box: there Ctrl+I and Ctrl+U
 *   are italic and underline, and Alt+arrows and the typed characters belong to
 *   the text.
 */
export function globalShortcut(press: KeyPress, scene: KeyScene): GlobalShortcut | null {
  if (scene.handled) return null;
  const mod = press.ctrlKey || press.metaKey;
  const key = press.key.toLowerCase();
  // Ctrl plus a letter and nothing else, which is how most of these are pressed.
  const ctrlOnly = mod && !press.altKey && !press.shiftKey;

  if (mod && press.shiftKey && !press.altKey && (key === 'm' || key === 'd')) {
    if (!scene.inVoice) return null;
    return { action: key === 'm' ? 'mute' : 'deafen' };
  }

  if (ctrlOnly && key === 'k') return scene.panel ? null : { action: 'switcher' };

  if (scene.dialog) {
    if (press.key === 'Escape') return { action: 'close-dialog' };
    if (mod && press.key === '/') return { action: 'help' };
    return null;
  }

  const plainEscape = press.key === 'Escape' && !mod && !press.altKey && !press.shiftKey;
  if (scene.panel) return plainEscape ? { action: 'close-panel' } : null;
  if (plainEscape && scene.drawer && !scene.card) return { action: 'close-panel' };

  if (ctrlOnly && key === 'f') return { action: 'search' };
  if (ctrlOnly && key === 'p') return scene.channelOpen ? { action: 'pins' } : null;

  if (press.key === 'Escape' && !mod && !press.altKey) {
    if (scene.popover || scene.card) return null;
    if (scene.typing && !scene.inComposer) return null;
    if (press.shiftKey) return { action: 'read-all' };
    return scene.channelOpen && scene.hasNew ? { action: 'dismiss-new' } : null;
  }

  if (scene.typing) return null;

  if (mod && !press.altKey && press.key === '/') return { action: 'help' };
  if (ctrlOnly && key === 'i') return { action: 'inbox' };
  if (ctrlOnly && key === 'u') return { action: 'members' };

  if (press.altKey && !mod && (press.key === 'ArrowUp' || press.key === 'ArrowDown')) {
    return { action: 'step', direction: press.key === 'ArrowDown' ? 1 : -1, unreadOnly: press.shiftKey };
  }

  if (typesCharacter(press) && !scene.popover && scene.composerReady) return { action: 'type' };

  return null;
}
