/**
 * Keeps an older answer from overwriting a newer one when the same list is
 * fetched again before the last fetch has come back. Reloads do overlap: a
 * reconnect, a stranger's presence and a burst of member changes can each start
 * one, and the server is free to answer them in any order.
 *
 * Each request takes a ticket as it is sent, and its answer is applied only if
 * no answer to a later request has been applied already. An older answer that
 * lands first is still welcome, since it is fresher than what is showing; it is
 * only turned away once something newer is in.
 */
export class ResponseOrder {
  #issued = 0;
  #applied = 0;

  /** Numbers a request as it is sent. */
  begin(): number {
    this.#issued += 1;
    return this.#issued;
  }

  /** Whether the answer to request `ticket` may be applied, noting it if so. */
  accept(ticket: number): boolean {
    if (ticket <= this.#applied) return false;
    this.#applied = ticket;
    return true;
  }

  /**
   * Turns away every answer still on its way, for when the store they would
   * fill has been emptied, such as on signing out.
   */
  cancel(): void {
    this.#applied = this.#issued;
  }
}
