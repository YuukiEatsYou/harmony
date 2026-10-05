import type { User } from '@harmony/shared';

/** A rectangle in viewport coordinates, kept plain so it stays reactive. */
interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How long the pointer has to rest on a trigger before the card opens. */
const SHOW_DELAY_MS = 500;
/** How long the card lingers after the pointer leaves its trigger. */
const HIDE_DELAY_MS = 180;

/**
 * State for the single profile card a client can have open. Resting the pointer
 * on a name opens it, and clicking a member pins it so it survives moving the
 * pointer onto the card itself.
 *
 * The hover open is deliberately delayed: the member list and message avatars
 * pass under the cursor while scrolling, which fires mouseenter, so opening at
 * once put a card in the way every time. Clicking or focusing still opens it
 * immediately, because those are deliberate.
 */
class ProfileCardState {
  user = $state<User | null>(null);
  rect = $state<AnchorRect | null>(null);
  pinned = $state(false);
  #hideTimer: ReturnType<typeof setTimeout> | null = null;
  #showTimer: ReturnType<typeof setTimeout> | null = null;

  /** Opens the card next to `element` right away. */
  show(user: User, element: HTMLElement, pinned = false): void {
    this.#cancelShow();
    this.#cancelHide();
    const rect = element.getBoundingClientRect();
    this.user = user;
    this.rect = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    this.pinned = pinned;
  }

  /** Opens the card once the pointer has rested on `element` for a moment. */
  scheduleShow(user: User, element: HTMLElement): void {
    // A clicked card stays put until it is dismissed elsewhere.
    if (this.pinned) return;
    this.#cancelHide();
    // Already showing this member: keep the card where it is.
    if (this.user && this.user.id === user.id) {
      this.#cancelShow();
      return;
    }
    this.#cancelShow();
    // Do not leave a card for the previous member sitting there while we wait.
    if (this.user) this.hide();
    this.#showTimer = setTimeout(() => {
      this.#showTimer = null;
      this.show(user, element);
    }, SHOW_DELAY_MS);
  }

  /** Closes shortly, unless the card is pinned. */
  scheduleHide(): void {
    if (this.pinned) return;
    // Leaving before the delay elapses cancels the pending open.
    this.#cancelShow();
    this.#cancelHide();
    this.#hideTimer = setTimeout(() => this.hide(), HIDE_DELAY_MS);
  }

  /** Called when the pointer reaches the card, so it does not vanish en route. */
  cancelHide(): void {
    this.#cancelHide();
  }

  hide(): void {
    this.#cancelShow();
    this.#cancelHide();
    this.user = null;
    this.rect = null;
    this.pinned = false;
  }

  #cancelHide(): void {
    if (this.#hideTimer !== null) clearTimeout(this.#hideTimer);
    this.#hideTimer = null;
  }

  #cancelShow(): void {
    if (this.#showTimer !== null) clearTimeout(this.#showTimer);
    this.#showTimer = null;
  }
}

export const profileCard = new ProfileCardState();

/**
 * Whether this device has a real pointer. The small hover card is a desktop
 * affordance: on touch it never opens, and a tap opens the full viewer instead.
 */
export function hoverCapable(): boolean {
  return window.matchMedia('(hover: hover)').matches;
}
