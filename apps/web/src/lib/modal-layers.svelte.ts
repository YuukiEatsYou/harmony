/**
 * Dialogs that keep their open state to themselves rather than in `ui`, such as
 * a message's edit history or the "What's new" notes, register here while they
 * are open. That is what lets "is anything open over the chat", and closing it,
 * reach them too: back closes whatever is open before it changes channel, and a
 * dialog it did not know about would be left standing over a channel change.
 */
class ModalLayers {
  #open = $state.raw<Array<{ id: number; close: () => void }>>([]);
  #next = 0;

  /** How many registered dialogs are open. */
  get count(): number {
    return this.#open.length;
  }

  /**
   * Registers an open dialog with the way to close it. The returned function
   * takes it off again, for when the dialog closes by any route; an effect that
   * registers while its dialog is open can simply return it.
   */
  add(close: () => void): () => void {
    const id = ++this.#next;
    this.#open = [...this.#open, { id, close }];
    return () => {
      this.#open = this.#open.filter((layer) => layer.id !== id);
    };
  }

  /** Closes every registered dialog, the most recently opened first. */
  closeAll(): void {
    for (const layer of [...this.#open].reverse()) layer.close();
  }
}

export const modalLayers = new ModalLayers();
