/**
 * Polls `predicate` on the real event loop (sockets, WebCrypto and PGlite resolve outside
 * the microtask queue) until it holds; throws `message` after `rounds` turns of `stepMs`.
 * Deadlines in the system under test stay on the fake clock; this only bounds the wait.
 */
export async function eventually(
  predicate: () => boolean,
  message: string,
  { rounds = 1_000, stepMs = 5 }: { rounds?: number; stepMs?: number } = {},
): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`eventually: ${message}`);
}
