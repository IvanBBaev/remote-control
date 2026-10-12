import { parseArgs } from 'node:util';

import { toBase64Url } from '@remote-control/protocol';

import { claudeCodeAdapter } from '../adapters/claude-code/adapter.js';
import { NO_DECISION_MESSAGE } from '../adapters/claude-code/decide.js';
import { KeyStoreError } from '../adapters/file-key-store.js';
import { HookReceiverBindError, type HookReceiver } from '../adapters/hook-receiver.js';
import { DEFAULT_HOLD_SECONDS } from '../core/agent-config.js';
import { defaultConfigText } from '../core/default-config-text.js';
import { createHookDispatcher } from '../core/hook-dispatcher.js';
import {
  HooksSettingsError,
  createHooksInstaller,
  type HookStateEntry,
} from '../core/hooks-installer.js';
import { loadConfig, type LoadConfigResult } from '../core/load-config.js';
import { createPendingStore } from '../core/pending-store.js';
import { resolveRepository } from '../core/resolve-repository.js';
import type { Container } from '../container.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/** Owner-only modes for the config directory and file. */
const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
const DEFAULT_LOG_LINES = 50;
const MAX_LOG_LINES = 10_000;
const LOG_TAIL_BYTES = 1024 * 1024;
const LOG_POLL_MS = 500;
/** Random bytes of the hook bearer token (D11). */
const HOOK_TOKEN_BYTES = 32;

export const HELP_TEXT = `Usage: remotectl <command> [options]

Commands:
  run                      Start the agent in the foreground
  status                   Show configuration, allowed repositories and keys
  pair                     Pair a phone with this agent
  devices                  List paired phones
  hooks install            Install the Claude Code approval hooks
  hooks remove             Remove the Claude Code approval hooks
  hooks status             Show whether the hooks are installed
  logs [-f] [-n <lines>]   Print the agent log (-f follows it)

Options:
  -h, --help               Show this help
  -v, --version            Show the version
`;

export interface RunCliOptions {
  /** Aborted on SIGINT/SIGTERM; ends `run` and `logs --follow`. */
  readonly signal: AbortSignal;
}

class UsageError extends Error {
  override readonly name = 'UsageError';
}

type Command = (args: readonly string[], c: Container, options: RunCliOptions) => Promise<number>;

const COMMANDS: Readonly<Record<string, Command>> = {
  run: runCommand,
  status: statusCommand,
  pair: pairCommand,
  devices: devicesCommand,
  hooks: hooksCommand,
  logs: logsCommand,
};

/** Runs one CLI invocation and returns the process exit code. */
export async function runCli(
  argv: readonly string[],
  c: Container,
  options: RunCliOptions,
): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined) {
    c.output.stderr(HELP_TEXT);
    return EXIT_USAGE;
  }
  if (first === '-h' || first === '--help' || first === 'help') {
    c.output.stdout(HELP_TEXT);
    return EXIT_OK;
  }
  if (first === '-v' || first === '--version') {
    c.output.stdout(`${c.version}\n`);
    return EXIT_OK;
  }
  const command = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : undefined;
  if (command === undefined) {
    c.output.stderr(`remotectl: unknown command '${first}'\n\n${HELP_TEXT}`);
    return EXIT_USAGE;
  }
  if (rest.includes('-h') || rest.includes('--help')) {
    c.output.stdout(HELP_TEXT);
    return EXIT_OK;
  }
  try {
    return await command(rest, c, options);
  } catch (error) {
    if (error instanceof UsageError) {
      c.output.stderr(`remotectl ${first}: ${error.message}\n`);
      return EXIT_USAGE;
    }
    if (error instanceof KeyStoreError) {
      c.output.stderr(`remotectl ${first}: ${error.message}\n`);
      return EXIT_ERROR;
    }
    throw error;
  }
}

function parse(
  args: readonly string[],
  config: Parameters<typeof parseArgs>[0] = {},
): ReturnType<typeof parseArgs> {
  try {
    return parseArgs({ ...config, args: [...args], strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function noArguments(args: readonly string[]): void {
  parse(args);
}

function reportInvalidConfig(
  c: Container,
  loaded: Extract<LoadConfigResult, { status: 'invalid' }>,
): void {
  c.output.stderr(`remotectl: invalid config file ${loaded.path}\n`);
  for (const error of loaded.errors) c.output.stderr(`  ${error}\n`);
}

/** Largest delay a Node timer accepts. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Blocks until `signal` aborts. A pending timer (not a bare promise) keeps the event
 * loop alive while nothing else does yet.
 */
async function waitForAbort(c: Container, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await c.sleep(MAX_TIMER_MS, signal);
    } catch {
      // Aborted; the loop condition ends the wait.
    }
  }
}

async function runCommand(
  args: readonly string[],
  c: Container,
  options: RunCliOptions,
): Promise<number> {
  noArguments(args);
  let loaded = await loadConfig(c.paths.config, c.fs, c.pathPort);
  if (loaded.status === 'missing') {
    await c.fs.ensureDir(c.paths.config, CONFIG_DIR_MODE);
    await c.fs.writeTextAtomic(loaded.path, defaultConfigText(), CONFIG_FILE_MODE);
    c.output.stdout(
      `Wrote a default config to ${loaded.path}; add repository paths to "repositories".\n`,
    );
    loaded = await loadConfig(c.paths.config, c.fs, c.pathPort);
  }
  if (loaded.status !== 'ok') {
    if (loaded.status === 'invalid') reportInvalidConfig(c, loaded);
    return EXIT_ERROR;
  }
  const { config } = loaded;
  const key = await c.keyStore.loadOrCreateDeviceKey();
  const log = await c.openLog();
  const store = createPendingStore({
    clock: c.clock,
    timer: c.timer,
    random: c.random,
    onEvent: (event) => {
      // Ids, kinds and outcomes only: hook payloads never reach the log.
      const { id, kind, sessionId } = event.request;
      if (event.type === 'added') {
        log.logger.info({
          event: 'pending_added',
          id,
          kind,
          sessionId,
          duplicate: event.duplicate,
        });
      } else {
        const outcome = event.outcome.type === 'decided' ? 'decided' : event.outcome.reason;
        log.logger.info({ event: 'pending_removed', id, kind, sessionId, outcome });
      }
    },
  });
  const handler = createHookDispatcher({
    store,
    onEvent: (input) => log.logger.debug({ event: 'hook', hook: input.hook_event_name }),
    ...(config.agent.onExpire === 'deny'
      ? {
          onDeadline: (request) =>
            claudeCodeAdapter.decide(request, { behavior: 'deny', message: NO_DECISION_MESSAGE }),
        }
      : {}),
  });
  const token = toBase64Url(c.random.bytes(HOOK_TOKEN_BYTES));
  let receiver: HookReceiver | undefined;
  try {
    receiver = await c.startHookReceiver({
      port: config.hooks.port,
      token,
      handler,
      defaultHookTimeoutMs: config.hooks.holdSeconds * 1000,
    });
    // Published only after the bind succeeded: a second agent never overwrites it.
    const endpoint = await c.keyStore.publishHookEndpoint({ port: receiver.port, token });
    log.logger.info(
      {
        event: 'agent_start',
        version: c.version,
        repositories: config.repositories.length,
        keyCreated: key.created,
        hookPort: endpoint.port,
        generation: endpoint.generation,
      },
      'agent started',
    );
    c.output.stdout(
      `remotectl ${c.version} running; hooks on 127.0.0.1:${endpoint.port}; press Ctrl-C to stop.\n`,
    );
    await waitForAbort(c, options.signal);
    log.logger.info({ event: 'agent_stop' }, 'agent stopped');
  } catch (error) {
    if (!(error instanceof HookReceiverBindError)) throw error;
    log.logger.error({ event: 'hook_bind_failed', port: config.hooks.port }, error.message);
    c.output.stderr(`remotectl run: ${error.message}\n`);
    return EXIT_ERROR;
  } finally {
    // Held hooks get `{}` (handoff) instead of a dropped connection.
    store.releaseAll('shutdown');
    await receiver?.close();
    await log.close();
  }
  return EXIT_OK;
}

async function statusCommand(args: readonly string[], c: Container): Promise<number> {
  noArguments(args);
  const out = (line: string): void => c.output.stdout(`${line}\n`);
  out(`remotectl ${c.version}`);
  const loaded = await loadConfig(c.paths.config, c.fs, c.pathPort);
  let exitCode = EXIT_OK;
  if (loaded.status === 'missing') {
    out(`config:          ${loaded.path} (missing; \`remotectl run\` writes a default)`);
  } else if (loaded.status === 'invalid') {
    out(`config:          ${loaded.path} (invalid)`);
    reportInvalidConfig(c, loaded);
    exitCode = EXIT_ERROR;
  } else {
    const { config } = loaded;
    out(`config:          ${loaded.path}`);
    out(`hold seconds:    ${config.hooks.holdSeconds}`);
    out(`on expire:       ${config.agent.onExpire}`);
    if (config.relay?.url !== undefined) out(`relay:           ${config.relay.url}`);
    out(`repositories:    ${config.repositories.length === 0 ? '(none)' : ''}`.trimEnd());
    for (const root of config.repositories) {
      const result = await resolveRepository([root], root, c.pathPort);
      out(`  ${root}  ${result.allowed ? `ok (${result.realPath})` : result.reason}`);
    }
  }
  out(`data dir:        ${c.paths.data}`);
  out(`log dir:         ${c.paths.log}`);
  const key = await c.keyStore.readDeviceKey();
  out(
    `device key:      ${key === undefined ? '(not created yet)' : toBase64Url(key.keyPair.publicKey)}`,
  );
  out(`paired devices:  ${(await c.keyStore.listPeers()).length}`);
  return exitCode;
}

function pairCommand(args: readonly string[], c: Container): Promise<number> {
  noArguments(args);
  c.output.stderr('remotectl pair: pairing is not available in this version yet.\n');
  return Promise.resolve(EXIT_ERROR);
}

async function devicesCommand(args: readonly string[], c: Container): Promise<number> {
  noArguments(args);
  const peers = await c.keyStore.listPeers();
  if (peers.length === 0) {
    c.output.stdout('No paired devices.\n');
    return EXIT_OK;
  }
  for (const peer of peers) {
    c.output.stdout(
      `${peer.deviceId}  ${peer.name}  paired ${new Date(peer.pairedAt).toISOString()}\n`,
    );
  }
  return EXIT_OK;
}

const HOOK_ACTIONS = new Set(['install', 'remove', 'status']);

/** Hooks run only in folders Claude Code trusts (04 §2.6). */
export const TRUST_HINT =
  'Claude Code runs hooks only in folders you have trusted: open each repository once\n' +
  'with `claude` and accept the trust prompt. Sessions started before an install pick\n' +
  'up the hooks after a restart (or a review in `/hooks`).\n';

function describeHook(entry: HookStateEntry): string {
  const name = entry.matcher === undefined ? entry.event : `${entry.event} (${entry.matcher})`;
  return `  ${name.padEnd(34)}${entry.state}`;
}

async function hooksCommand(args: readonly string[], c: Container): Promise<number> {
  const [action, ...rest] = args;
  if (action === undefined || !HOOK_ACTIONS.has(action)) {
    throw new UsageError('expected one of: install, remove, status');
  }
  noArguments(rest);
  const loaded = await loadConfig(c.paths.config, c.fs, c.pathPort);
  if (loaded.status === 'invalid') {
    reportInvalidConfig(c, loaded);
    return EXIT_ERROR;
  }
  const installer = createHooksInstaller({
    fs: c.fs,
    paths: c.pathPort,
    clock: c.clock,
    settingsDir: c.claudeConfigDir,
    dataDir: c.paths.data,
    hookSource: c.hookSource,
    execPath: c.execPath,
    holdSeconds: loaded.status === 'ok' ? loaded.config.hooks.holdSeconds : DEFAULT_HOLD_SECONDS,
  });
  const out = (line: string): void => c.output.stdout(`${line}\n`);
  try {
    if (action === 'status') {
      const status = await installer.status();
      out(`settings:     ${status.settingsPath}${status.settingsExists ? '' : ' (missing)'}`);
      out(`hook script:  ${status.scriptPath} (${status.script})`);
      for (const entry of status.hooks) out(describeHook(entry));
      const complete =
        status.script === 'current' && status.hooks.every((entry) => entry.state === 'installed');
      out(
        complete
          ? 'Hooks are installed.'
          : 'Run `remotectl hooks install` to install or update them.',
      );
      c.output.stdout(`\n${TRUST_HINT}`);
      return EXIT_OK;
    }
    const change = action === 'install' ? await installer.install() : await installer.remove();
    if (!change.changed) {
      out(
        action === 'install'
          ? `Hooks already installed in ${change.settingsPath}.`
          : `No remotectl hooks in ${change.settingsPath}.`,
      );
    } else {
      out(`${action === 'install' ? 'Installed' : 'Removed'} the hooks in ${change.settingsPath}.`);
      if (change.backupPath !== undefined) out(`Backup: ${change.backupPath}`);
    }
    if (action === 'install') c.output.stdout(`\n${TRUST_HINT}`);
    return EXIT_OK;
  } catch (error) {
    if (!(error instanceof HooksSettingsError)) throw error;
    c.output.stderr(`remotectl hooks ${action}: ${error.message}\n`);
    return EXIT_ERROR;
  }
}

function parseLineCount(value: unknown): number {
  if (value === undefined) return DEFAULT_LOG_LINES;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LOG_LINES) {
    throw new UsageError(`--lines must be an integer from 1 to ${MAX_LOG_LINES}`);
  }
  return n;
}

async function logsCommand(
  args: readonly string[],
  c: Container,
  options: RunCliOptions,
): Promise<number> {
  const { values } = parse(args, {
    options: {
      follow: { type: 'boolean', short: 'f' },
      lines: { type: 'string', short: 'n' },
    },
  });
  const lines = parseLineCount(values['lines']);
  const follow = values['follow'] === true;
  let file = await c.logReader.newest();
  let offset = 0;
  if (file === undefined) {
    if (!follow) {
      c.output.stdout(`No logs yet in ${c.paths.log}.\n`);
      return EXIT_OK;
    }
  } else {
    const size = await c.logReader.size(file);
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const text = await c.logReader.read(file, start, size);
    const all = text.split('\n');
    if (all.at(-1) === '') all.pop();
    // A chunk that starts mid-file may begin with a partial line.
    if (start > 0) all.shift();
    const tail = all.slice(-lines);
    if (tail.length > 0) c.output.stdout(`${tail.join('\n')}\n`);
    offset = size;
  }
  while (follow && !options.signal.aborted) {
    try {
      await c.sleep(LOG_POLL_MS, options.signal);
    } catch {
      break;
    }
    const newest = await c.logReader.newest();
    if (newest !== file) {
      file = newest;
      offset = 0;
    }
    if (file === undefined) continue;
    const size = await c.logReader.size(file);
    if (size < offset) offset = 0;
    if (size > offset) {
      c.output.stdout(await c.logReader.read(file, offset, size));
      offset = size;
    }
  }
  return EXIT_OK;
}
