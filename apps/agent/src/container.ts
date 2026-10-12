import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createLogger, createRollingDestination } from '@remote-control/log';

import { envPaths } from './adapters/env-paths.js';
import { createFileKeyStore } from './adapters/file-key-store.js';
import {
  type HookReceiver,
  type HookReceiverOptions,
  startHookReceiver,
} from './adapters/hook-receiver.js';
import { LOG_FILE, fileSize, newestLogFile, readRange } from './adapters/log-files.js';
import { systemLaunchctl } from './adapters/launchd/launchctl.js';
import { createNodeFileSystem, nodePaths } from './adapters/node-file-system.js';
import { systemClock } from './adapters/system-clock.js';
import { systemRandom } from './adapters/system-random.js';
import { systemTimer } from './adapters/system-timer.js';
import type { AgentPaths } from './ports/agent-paths.js';
import type { Clock } from './ports/clock.js';
import type { FileSystem } from './ports/file-system.js';
import type { KeyStore } from './ports/key-store.js';
import type { LogReader } from './ports/log-reader.js';
import type { Output } from './ports/output.js';
import type { PathPort } from './ports/path-port.js';
import type { Random } from './ports/random.js';
import type { Launchctl } from './ports/launchctl.js';
import type { ServiceHost } from './ports/service-host.js';
import type { Timer } from './ports/timer.js';
import { AGENT_VERSION } from './version.js';

/** The npm package and env-paths application name (D22). */
export const APP_NAME = 'remotectl';

export type Logger = ReturnType<typeof createLogger>;

export interface AgentLog {
  readonly logger: Logger;
  /** Flushes and closes the log file. */
  close(): Promise<void>;
}

/** Everything a command needs, wired to real or test adapters. */
export interface Container {
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly paths: AgentPaths;
  readonly fs: FileSystem;
  readonly pathPort: PathPort;
  readonly keyStore: KeyStore;
  readonly clock: Clock;
  readonly random: Random;
  readonly timer: Timer;
  readonly output: Output;
  readonly logReader: LogReader;
  /** Claude Code's config dir: `$CLAUDE_CONFIG_DIR`, else `~/.claude` (D11). */
  readonly claudeConfigDir: string;
  /** The bundled `hook.cjs` that `hooks install` copies into the data dir. */
  readonly hookSource: string;
  /** Absolute path of the Node binary that runs `hook.cjs`. */
  readonly execPath: string;
  /** Binds the loopback hook receiver; rejects with `HookReceiverBindError`. */
  startHookReceiver(options: HookReceiverOptions): Promise<HookReceiver>;
  /** Opens the rolling agent log (pino-roll, 10 MB × 5) in `paths.log`. */
  openLog(): Promise<AgentLog>;
  /** Waits `ms`; rejects with an `AbortError` when `signal` fires. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Host facts for `install` / `uninstall` (M0-24). */
  readonly service: ServiceHost;
  readonly launchctl: Launchctl;
}

export interface ContainerOptions {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
  readonly tmpdir: string;
  readonly output: Output;
  readonly clock?: Clock;
  readonly random?: Random;
  readonly timer?: Timer;
  /** Default: `hook.cjs` next to the running bundle. */
  readonly hookSource?: string;
  /** Default: `process.execPath`. */
  readonly execPath?: string;
  /** Service installer facts (M0-24); default to the running process. */
  readonly uid?: number;
  readonly scriptPath?: string;
  readonly launchctl?: Launchctl;
}

/** Wires the ports to their Node adapters. Host facts are injected (tests use temp dirs). */
export function createContainer(options: ContainerOptions): Container {
  const clock = options.clock ?? systemClock;
  const random = options.random ?? systemRandom;
  const paths = envPaths(APP_NAME, options);
  const fs = createNodeFileSystem(random);
  const output = options.output;
  const keyStore = createFileKeyStore({
    dir: paths.data,
    fs,
    paths: nodePaths,
    random,
    clock,
    enforcePermissions: options.platform !== 'win32',
    onWarning: (message) => output.stderr(`warning: ${message}\n`),
  });
  return {
    version: AGENT_VERSION,
    platform: options.platform,
    paths,
    fs,
    pathPort: nodePaths,
    keyStore,
    clock,
    random,
    timer: options.timer ?? systemTimer,
    output,
    claudeConfigDir: options.env['CLAUDE_CONFIG_DIR'] || nodePaths.join(options.homedir, '.claude'),
    hookSource: options.hookSource ?? fileURLToPath(new URL('./hook.cjs', import.meta.url)),
    execPath: options.execPath ?? process.execPath,
    startHookReceiver,
    logReader: {
      newest: () => newestLogFile(paths.log),
      size: fileSize,
      read: readRange,
    },
    async openLog() {
      await fs.ensureDir(paths.log, 0o700);
      const destination = await createRollingDestination({ file: join(paths.log, LOG_FILE) });
      const logger = createLogger({ name: 'agent', destination });
      return {
        logger,
        close: () =>
          new Promise<void>((resolve) => {
            destination.once('close', resolve);
            destination.end();
          }),
      };
    },
    sleep: (ms, signal) => delay(ms, undefined, { signal }),
    service: {
      homedir: options.homedir,
      tmpdir: options.tmpdir,
      uid: options.uid ?? process.getuid?.(),
      execPath: options.execPath ?? process.execPath,
      scriptPath: options.scriptPath ?? process.argv[1],
      pathEnv: options.env['PATH'],
    },
    launchctl: options.launchctl ?? systemLaunchctl,
  };
}
