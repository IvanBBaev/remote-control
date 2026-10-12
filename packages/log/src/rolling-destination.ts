import pinoRoll from 'pino-roll';

export interface RollingDestinationOptions {
  /** Base path of the log file; pino-roll numbers it (`agent.log` → `agent.1.log`, …). */
  readonly file: string;
  /** Rotate when a file exceeds this size (`k`/`m`/`g` suffix); default `10m`. */
  readonly size?: string;
  /** Files kept in total, the active one included (≥ 2); default 5 (06 §5.4: 10 MB × 5). */
  readonly files?: number;
}

/** A rotating file destination, closed by the caller on shutdown. */
export interface RollingDestination {
  write(msg: string): void;
  end(): void;
  once(event: 'close' | 'finish' | 'ready', listener: () => void): unknown;
}

/**
 * The agent's file destination (06 §5.4): size-based rotation via pino-roll. Pass the
 * result as `destination` to `createLogger`.
 */
export async function createRollingDestination(
  options: RollingDestinationOptions,
): Promise<RollingDestination> {
  const files = options.files ?? 5;
  if (!Number.isInteger(files) || files < 2) {
    throw new RangeError('createRollingDestination: files must be an integer of at least 2.');
  }
  return pinoRoll({
    file: options.file,
    size: options.size ?? '10m',
    mkdir: true,
    // pino-roll counts files kept in addition to the active one.
    limit: { count: files - 1 },
  });
}
