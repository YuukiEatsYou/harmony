/**
 * Moves an element to the end of the document body for as long as it is
 * mounted, for a layer that has to cover the whole window.
 *
 * A layer with position: fixed only covers the window while none of its
 * ancestors has a transform, a filter or will-change: transform: any of those
 * makes that ancestor the box "fixed" is measured against. Message rows have
 * both, for the hover nudge and its promotion in Firefox, so a dialog opened
 * from inside one covered that row alone, and the rest of the app stayed lit and
 * clickable around it. Moving the layer to the body takes it out from under them.
 *
 * Svelte still runs the moved element's handlers: its delegated events are also
 * listened for on the document, for exactly this kind of move.
 */
export function portal(node: HTMLElement): { destroy: () => void } {
  // Moving an element takes focus off anything inside it, and a dialog's own
  // action may already have put focus there, so it is handed straight back.
  const focused = document.activeElement;
  document.body.appendChild(node);
  if (focused instanceof HTMLElement && node.contains(focused) && document.activeElement !== focused) {
    focused.focus({ preventScroll: true });
  }
  return {
    destroy(): void {
      node.remove();
    },
  };
}
