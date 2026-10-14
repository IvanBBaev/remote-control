/**
 * Polls `predicate` on the real event loop (sockets, WebCrypto and PGlite resolve outside
 * the microtask queue) until it holds; throws `message` after `rounds` turns of `stepMs`.
 * Deadlines in the system under test stay on the fake clock; this only bounds the wait.
 * The default (≥ 20 s) outlasts a loaded machine; the journey's own test timeout stays the
 * real bound on a hang.
 */
export async function eventually(
  predicate: () => boolean,
  message: string,
  { rounds = 4_000, stepMs = 5 }: { rounds?: number; stepMs?: number } = {},
): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`eventually: ${message}`);
}
