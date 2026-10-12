// The notify-only update check (M1-08, 06 §5.3, Q7, ADR 0002): the agent tells the user
// that a newer remotectl exists and how to install it. It never spawns npm and never
// downloads anything; the only request is the npm dist-tags GET (`adapters/npm-registry`).
//
// `REMOTECTL_NO_UPDATE_CHECK=1` turns off the automatic checks (`run` every 24 h, the
// `status` line); an explicit `remotectl update` still asks the registry.
import {
  UPDATE_CHECK_INTERVAL_MS,
  cacheIsFresh,
  parseUpdateCache,
  serializeUpdateCache,
  verdict,
  type UpdateCache,
  type UpdateCheckResult,
} from '../core/update-check.js';
import type { Container, Logger } from '../container.js';
import type { TimerHandle } from '../ports/timer.js';

export const UPDATE_CACHE_FILE = 'update-check.json';
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const CACHE_DIR_MODE = 0o700;
const CACHE_FILE_MODE = 0o600;

function cachePath(c: Container): string {
  return c.pathPort.join(c.paths.cache, UPDATE_CACHE_FILE);
}

async function readCache(c: Container): Promise<UpdateCache | undefined> {
  try {
    return parseUpdateCache(await c.fs.readText(cachePath(c)));
  } catch {
    // An unreadable cache counts as absent, like a corrupt one.
    return undefined;
  }
}

async function writeCache(c: Container, cache: UpdateCache): Promise<void> {
  try {
    await c.fs.ensureDir(c.paths.cache, CACHE_DIR_MODE);
    await c.fs.writeTextAtomic(cachePath(c), serializeUpdateCache(cache), CACHE_FILE_MODE);
  } catch {
    // Best effort: the next check simply asks the registry again.
  }
}

export interface CheckOptions {
  /** Ask the registry even when checks are disabled or the cache is fresh (`update`). */
  readonly force: boolean;
}

/**
 * Compares the running version with the registry's `latest` dist-tag. A cached answer
 * younger than 24 h is reused; otherwise the registry is asked with the cached ETag. When
 * the registry cannot be reached the cached `latest` (if any) still gives a verdict.
 */
export async function checkForUpdate(
  c: Container,
  options: CheckOptions,
): Promise<UpdateCheckResult> {
  const current = c.version;
  if (c.updateCheckDisabled && !options.force) return { status: 'disabled', current };
  const cache = await readCache(c);
  const now = c.clock.now();
  if (cache !== undefined && !options.force && cacheIsFresh(cache, now)) {
    return verdict(current, cache.latest, 'cache');
  }
  const answer = await c.registry.distTags(cache?.etag);
  if (answer.status === 'ok') {
    await writeCache(
      c,
      answer.etag === undefined
        ? { checkedAt: now, latest: answer.latest }
        : { checkedAt: now, latest: answer.latest, etag: answer.etag },
    );
    return verdict(current, answer.latest, 'registry');
  }
  if (answer.status === 'not-modified' && cache !== undefined) {
    await writeCache(c, { ...cache, checkedAt: now });
    return verdict(current, cache.latest, 'registry');
  }
  return cache === undefined
    ? { status: 'unknown', current }
    : verdict(current, cache.latest, 'cache');
}

/** The `update:` line of `status`. */
export async function updateStatusLine(c: Container): Promise<string> {
  const result = await checkForUpdate(c, { force: false });
  switch (result.status) {
    case 'current':
      return `${result.current} is the latest`;
    case 'available':
      return `${result.latest} available (run \`remotectl update\`)`;
    case 'disabled':
      return 'check disabled';
    case 'unknown':
      return 'unknown (offline)';
  }
}

/** The steps to update, printed by `update`; the agent itself never runs them (ADR 0002). */
function updateNotice(current: string, latest: string): string {
  return (
    `remotectl ${latest} is available (you have ${current}). To update:\n` +
    '  npm install -g remotectl@latest\n' +
    'then, if the agent runs as a service, point the service at the new version:\n' +
    '  remotectl uninstall && remotectl install\n'
  );
}

/** `remotectl update`: always asks the registry; prints the result, installs nothing. */
export async function updateCommand(c: Container): Promise<number> {
  const result = await checkForUpdate(c, { force: true });
  if (result.status === 'available' || result.status === 'current') {
    if (result.source === 'cache') {
      c.output.stderr(
        'remotectl update: could not reach the npm registry; showing the last known answer.\n',
      );
    }
    c.output.stdout(
      result.status === 'available'
        ? updateNotice(result.current, result.latest)
        : `remotectl ${result.current} is up to date.\n`,
    );
    return result.source === 'cache' ? EXIT_ERROR : EXIT_OK;
  }
  c.output.stderr('remotectl update: could not reach the npm registry; try again later.\n');
  return EXIT_ERROR;
}

export interface UpdateChecks {
  /** Cancels the next check and waits for one in flight (it logs nothing afterwards). */
  stop(): Promise<void>;
}

/**
 * `run`: checks now and every 24 h, without blocking startup; a newer version is logged
 * as `update_available`. Nothing is scheduled when checks are disabled.
 */
export function startUpdateChecks(c: Container, logger: Logger): UpdateChecks {
  if (c.updateCheckDisabled) return { stop: () => Promise.resolve() };
  let stopped = false;
  let handle: TimerHandle | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const tick = (): void => {
    handle = undefined;
    inFlight = checkForUpdate(c, { force: false })
      .then((result) => {
        if (stopped || result.status !== 'available') return;
        logger.warn(
          { event: 'update_available', current: result.current, latest: result.latest },
          `remotectl ${result.latest} is available; run \`remotectl update\``,
        );
      })
      .catch(() => {
        // A failed check is retried at the next interval.
      })
      .finally(() => {
        if (!stopped) handle = c.timer.after(UPDATE_CHECK_INTERVAL_MS, tick);
      });
  };
  tick();
  return {
    async stop() {
      stopped = true;
      handle?.cancel();
      await inFlight;
    },
  };
}
