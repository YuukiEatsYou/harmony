import type { Message } from '@harmony/shared';

/**
 * The one message being edited, and its draft. The message list draws the edit
 * box, but the composer starts edits too (the Up arrow in an empty message box
 * edits your last message, as on Discord), so the state lives here rather than
 * in either component. Only one message is ever edited at a time: starting
 * another replaces it, the way clicking Edit on a second message always has.
 */
class MessageEditState {
  /** The message whose edit box is open, or null. */
  id = $state<string | null>(null);
  /** The text in the edit box. */
  draft = $state('');
  /** Set by start until the edit box has been focused once. */
  #fresh = false;

  start(message: Message): void {
    this.id = message.id;
    this.draft = message.content;
    this.#fresh = true;
  }

  stop(): void {
    this.id = null;
    this.draft = '';
    this.#fresh = false;
  }

  /**
   * Whether the edit was just started, which an edit box asks once as it
   * appears. Its row can also be rebuilt later, when the list reloads, and then
   * it must not pull focus out of wherever the member is typing.
   */
  takeFresh(): boolean {
    const fresh = this.#fresh;
    this.#fresh = false;
    return fresh;
  }
}

export const messageEdit = new MessageEditState();
