import type { DestinationStream } from 'pino';

/** A pino destination that keeps every rendered line in memory (tests, privacy gate). */
export interface MemoryDestination extends DestinationStream {
  /** Rendered lines in write order, without the trailing newline. */
  lines(): string[];
}

export function createMemoryDestination(): MemoryDestination {
  const chunks: string[] = [];
  return {
    write(chunk: string): void {
      chunks.push(chunk);
    },
    lines(): string[] {
      return chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0);
    },
  };
}
