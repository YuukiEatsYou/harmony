import { tick } from 'svelte';

/** How many recently opened channels the switcher remembers. */
const recentLimit = 10;

/**
 * State for the keyboard layer: which of its two dialogs is open, and the
 * channels opened lately, which is what the quick switcher offers first.
 *
 * The recent list lives only as long as the page. It is a convenience for
 * hopping back and forth during a session, and the sidebar order it falls back
 * to after a reload is a perfectly good one.
 */
class ShortcutsState {
  panel = $state<'switcher' | 'help' | null>(null);
  recentChannelIds = $state<string[]>([]);
  /**
   * Whatever had focus before the first of these dialogs opened. Moving from
   * the switcher to the help keeps it, so closing the help still lands back
   * where the person started rather than on a switcher that no longer exists.
   */
  #returnTo: HTMLElement | null = null;

  open(panel: 'switcher' | 'help'): void {
    if (this.panel === null) {
      const focused = document.activeElement;
      this.#returnTo = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    }
    this.panel = panel;
  }

  toggle(panel: 'switcher' | 'help'): void {
    if (this.panel === panel) this.close();
    else this.open(panel);
  }

  /** Closes whichever dialog is open and hands focus back once it has gone. */
  async close(): Promise<void> {
    if (this.panel === null) return;
    this.panel = null;
    const target = this.#returnTo;
    this.#returnTo = null;
    await tick();
    // The element may have been removed meanwhile, such as a channel button
    // after a refresh, and focusing a detached node would silently do nothing.
    if (target?.isConnected) target.focus({ preventScroll: true });
  }

  /** Forgets everything, for when the chat goes away on signing out. */
  reset(): void {
    this.panel = null;
    this.#returnTo = null;
    this.recentChannelIds = [];
  }

  noteVisit(channelId: string): void {
    if (this.recentChannelIds[0] === channelId) return;
    this.recentChannelIds = [channelId, ...this.recentChannelIds.filter((id) => id !== channelId)].slice(
      0,
      recentLimit,
    );
  }
}

export const shortcuts = new ShortcutsState();

/** Whether this is an Apple keyboard, where the switcher answers to ⌘ rather than Ctrl. */
export const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** The shortcuts' modifier, named the way this keyboard prints it, for hints in tooltips. */
export const modKey = isApple ? '⌘' : 'Ctrl';

/**
 * Whether a key press belongs to a field that is being typed in. The arrows,
 * Escape, slash and the letters all mean something there already, so the
 * keyboard layer leaves most such presses alone.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'reset', 'submit', 'color', 'file'].includes(target.type);
  }
  return false;
}

/**
 * Moves focus into a dialog and keeps Tab cycling inside it, which is what
 * `aria-modal` promises assistive technology. Focus goes to the element marked
 * `data-autofocus`, or failing that the first thing that can take it. Handing
 * focus back on close is the store's job, since it knows where it came from.
 */
export function trapFocus(node: HTMLElement): { destroy: () => void } {
  const focusables = (): HTMLElement[] =>
    Array.from(
      node.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    ).filter((element) => !element.hasAttribute('disabled') && element.tabIndex !== -1);

  const initial = node.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0];
  initial?.focus();

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const list = focusables();
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  node.addEventListener('keydown', onKeydown);
  return { destroy: () => node.removeEventListener('keydown', onKeydown) };
}
