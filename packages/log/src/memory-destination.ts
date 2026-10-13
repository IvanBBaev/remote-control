import type { DestinationStream } from 'pino';

/** A pino destination that keeps every rendered line in memory (tests, privacy gate). */
export interface MemoryDestination extends DestinationStream {
  /** Rendered lines in write order, without the trailing newline. */
  lines(): string[];
  /** Like {@link lines}, then forgets them (long runs that must not grow, M1-15). */
  take(): string[];
}

export function createMemoryDestination(): MemoryDestination {
  const chunks: string[] = [];
  const lines = (): string[] =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0);
  return {
    write(chunk: string): void {
      chunks.push(chunk);
    },
    lines,
    take(): string[] {
      const taken = lines();
      chunks.length = 0;
      return taken;
    },
  };
}
