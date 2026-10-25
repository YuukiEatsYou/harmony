/**
 * A handle on the composer's message field, so another part of the UI can put the
 * member back into it — replying to a message, for instance. Focus is called
 * straight from the click that asks for it rather than through a flag something
 * reacts to, because a phone only raises its keyboard for a focus call made during
 * the gesture.
 */
let field: HTMLTextAreaElement | null = null;

/** Called by the composer as its field mounts and unmounts. */
export function registerComposerField(element: HTMLTextAreaElement | null): void {
  field = element;
}

/** Moves the caret into the composer and, on a phone, opens the keyboard. */
export function focusComposer(): void {
  field?.focus();
}

/**
 * Whether the message box is on the page and can be typed into. A timed-out
 * member's box is disabled, and a key typed elsewhere should not be sent to a
 * box that would refuse it.
 */
export function composerTakesText(): boolean {
  return field !== null && field.isConnected && !field.disabled && !field.readOnly;
}

/** Whether an event's target is the message box itself. */
export function isComposerField(target: EventTarget | null): boolean {
  return field !== null && target === field;
}
