/**
 * Runs async tasks strictly one after another, in call order, whatever their outcome.
 * WebCrypto is asynchronous; this keeps nonces, wire order and the receive counter in
 * step with the order of calls.
 */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
