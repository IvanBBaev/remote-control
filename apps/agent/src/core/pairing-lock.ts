import type { Clock } from '../ports/clock.js';
import type { FileSystem } from '../ports/file-system.js';

/** In the data dir: while it holds, `run` keeps off the relay so `pair` owns the socket. */
export const PAIRING_LOCK_FILE = 'pairing.lock';
/** The slot lives 5 minutes; the lock a little longer, and a stale one is ignored. */
export const PAIRING_LOCK_MS = 6 * 60_000;
const LOCK_FILE_MODE = 0o600;

/**
 * The relay allows one socket per device (a new `hello` supersedes the old one, 4000).
 * `remotectl pair` takes the agent's socket for the pairing; this lock tells a running
 * agent to hold its reconnects until pairing ends (or the lock goes stale).
 */
export interface PairingLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
  held(): Promise<boolean>;
}

export function createPairingLock(fs: FileSystem, path: string, clock: Clock): PairingLock {
  return {
    acquire: () =>
      fs.writeTextAtomic(
        path,
        `${JSON.stringify({ until: clock.now() + PAIRING_LOCK_MS })}\n`,
        LOCK_FILE_MODE,
      ),
    async release() {
      await fs.remove(path);
    },
    async held() {
      const text = await fs.readText(path);
      if (text === undefined) return false;
      try {
        const until = (JSON.parse(text) as { until?: unknown }).until;
        return typeof until === 'number' && until > clock.now();
      } catch {
        return false;
      }
    },
  };
}
