/**
 * The dynamic privacy gate (07 §5.12, I1/I2): after a journey, every text the relay kept
 * or emitted — its log lines, every database row, every push it sent — and the agent's
 * log lines must contain none of the run's canaries.
 */
export interface LeakSource {
  /** Where the lines came from, e.g. `relay-log`, `pglite`, `push`. */
  readonly name: string;
  readonly lines: readonly string[];
}

/** One canary found in one line of one source. */
export interface Leak {
  readonly canary: string;
  readonly source: string;
  readonly line: number;
}

export class PrivacyLeakError extends Error {
  constructor(readonly leaks: readonly Leak[]) {
    super(
      `privacy gate: ${String(leaks.length)} canary leak(s): ${leaks
        .map((leak) => `"${leak.canary}" in ${leak.source} line ${String(leak.line)}`)
        .join(', ')}`,
    );
    this.name = 'PrivacyLeakError';
  }
}

export function findLeaks(sources: readonly LeakSource[], canaries: readonly string[]): Leak[] {
  if (canaries.length === 0) throw new TypeError('privacy gate: no canaries to scan for');
  if (canaries.some((canary) => canary.length === 0)) {
    throw new TypeError('privacy gate: an empty canary would match every line');
  }
  const leaks: Leak[] = [];
  for (const source of sources) {
    source.lines.forEach((text, line) => {
      for (const canary of canaries) {
        if (text.includes(canary)) leaks.push({ canary, source: source.name, line });
      }
    });
  }
  return leaks;
}

/** Throws {@link PrivacyLeakError} naming every leak; passes only on a clean scan. */
export function assertNoLeaks(sources: readonly LeakSource[], canaries: readonly string[]): void {
  const leaks = findLeaks(sources, canaries);
  if (leaks.length > 0) throw new PrivacyLeakError(leaks);
}
