import { hostname } from 'node:os';
import { join, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createLogger, createRollingDestination } from '@remote-control/log';

import { createAgentProbe } from './adapters/agent-probe.js';
import { createClaudeCli } from './adapters/claude-code/claude-cli.js';
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
import { createNpmRegistry, type FetchFn } from './adapters/npm-registry.js';
import { nodeWebSocket } from './adapters/node-websocket.js';
import { createReadlinePrompt } from './adapters/readline-prompt.js';
import { createRelayHttp } from './adapters/relay-http.js';
import { systemClock } from './adapters/system-clock.js';
import { systemRandom } from './adapters/system-random.js';
import { systemTimer } from './adapters/system-timer.js';
import { systemSystemctl } from './adapters/systemd/systemctl.js';
import { systemSchtasks } from './adapters/windows/schtasks.js';
import type { AgentPaths } from './ports/agent-paths.js';
import type { ClaudeCli } from './ports/claude-cli.js';
import type { Clock } from './ports/clock.js';
import type { FileSystem } from './ports/file-system.js';
import type { KeyStore } from './ports/key-store.js';
import type { LogReader } from './ports/log-reader.js';
import type { Output } from './ports/output.js';
import type { PathPort } from './ports/path-port.js';
import type { Prompt } from './ports/prompt.js';
import type { Random } from './ports/random.js';
import type { Launchctl } from './ports/launchctl.js';
import type { Registry } from './ports/registry.js';
import type { RelayApi } from './ports/relay-api.js';
import type { Schtasks } from './ports/schtasks.js';
import type { ServiceHost } from './ports/service-host.js';
import type { Systemctl } from './ports/systemctl.js';
import type { Timer } from './ports/timer.js';
import type { WebSocketFactory } from './ports/web-socket.js';
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
  /** Whether a running agent answers on its published hook endpoint (M1-07). */
  agentAlive(): Promise<boolean>;
  /** Opens the rolling agent log (pino-roll, 10 MB × 5) in `paths.log`. */
  openLog(): Promise<AgentLog>;
  /** Waits `ms`; rejects with an `AbortError` when `signal` fires. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Host facts for `install` / `uninstall` (M0-24). */
  readonly service: ServiceHost;
  readonly launchctl: Launchctl;
  readonly systemctl: Systemctl;
  readonly schtasks: Schtasks;
  /** The npm registry for the notify-only update check (M1-08, Q7). */
  readonly registry: Registry;
  /**
   * `REMOTECTL_NO_UPDATE_CHECK=1`: no automatic check in `run` and `status`. An explicit
   * `remotectl update` still asks the registry.
   */
  readonly updateCheckDisabled: boolean;
  /** Outbound WebSocket to the relay (Node 22's global `WebSocket`, D13). */
  readonly webSocket: WebSocketFactory;
  /** The relay's agent HTTP API at `baseUrl`, authenticated with `token`. */
  relayApi(baseUrl: string, token: string): RelayApi;
  /** Terminal questions (the pairing fingerprint confirmation). */
  readonly prompt: Prompt;
  /** This machine's name (1..64 chars): the agent name a phone shows and the snapshot's. */
  readonly hostname: string;
  /** The `claude` CLI that starts sessions and sends follow-ups (M1-04). */
  readonly claude: ClaudeCli;
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
  readonly systemctl?: Systemctl;
  readonly schtasks?: Schtasks;
  readonly registry?: Registry;
  /** Default: Node's file system and paths (tests of another platform inject fakes). */
  readonly fs?: FileSystem;
  readonly pathPort?: PathPort;
  /** Default: `nodeWebSocket`. */
  readonly webSocket?: WebSocketFactory;
  /** `fetch` for the relay HTTP API and the agent probe; default: the global `fetch`. */
  readonly fetch?: FetchFn;
  /** Default: a readline prompt on stdin/stdout. */
  readonly prompt?: Prompt;
  /** Default: `os.hostname()`. */
  readonly hostname?: string;
  /** Default: `claude` from `PATH`, with this environment. */
  readonly claude?: ClaudeCli;
}

/** `USERDOMAIN\USERNAME` from the Windows environment, or the bare user name. */
function windowsUser(env: ContainerOptions['env']): string | undefined {
  const user = env['USERNAME'];
  if (!user) return undefined;
  const domain = env['USERDOMAIN'];
  return domain ? `${domain}\\${user}` : user;
}

/** Wires the ports to their Node adapters. Host facts are injected (tests use temp dirs). */
export function createContainer(options: ContainerOptions): Container {
  const clock = options.clock ?? systemClock;
  const random = options.random ?? systemRandom;
  const paths = envPaths(APP_NAME, options);
  const fs = options.fs ?? createNodeFileSystem(random);
  const pathPort = options.pathPort ?? nodePaths;
  const output = options.output;
  const fetchFn: FetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  const keyStore = createFileKeyStore({
    dir: paths.data,
    fs,
    paths: pathPort,
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
    pathPort,
    keyStore,
    clock,
    random,
    timer: options.timer ?? systemTimer,
    output,
    claudeConfigDir: options.env['CLAUDE_CONFIG_DIR'] || pathPort.join(options.homedir, '.claude'),
    hookSource: options.hookSource ?? fileURLToPath(new URL('./hook.cjs', import.meta.url)),
    execPath: options.execPath ?? process.execPath,
    startHookReceiver,
    agentAlive: createAgentProbe({ keyStore, fetch: fetchFn }),
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
      xdgConfigHome: options.env['XDG_CONFIG_HOME'] || posix.join(options.homedir, '.config'),
      windowsUser: windowsUser(options.env),
    },
    launchctl: options.launchctl ?? systemLaunchctl,
    systemctl: options.systemctl ?? systemSystemctl,
    schtasks: options.schtasks ?? systemSchtasks,
    registry: options.registry ?? createNpmRegistry(),
    updateCheckDisabled: options.env['REMOTECTL_NO_UPDATE_CHECK'] === '1',
    webSocket: options.webSocket ?? nodeWebSocket,
    relayApi: (baseUrl, token) =>
      createRelayHttp({
        baseUrl,
        token,
        fetch: fetchFn,
      }),
    prompt: options.prompt ?? createReadlinePrompt(),
    // The protocol's machine and pairing names are 1..64 characters.
    hostname: (options.hostname ?? hostname()).slice(0, 64) || APP_NAME,
    claude:
      options.claude ??
      createClaudeCli({
        command: 'claude',
        env: { ...options.env, HOME: options.env['HOME'] ?? options.homedir },
      }),
  };
}
