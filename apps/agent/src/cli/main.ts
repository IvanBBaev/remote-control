import { parseArgs } from 'node:util';

import { toBase64Url } from '@remote-control/protocol';

import { CLAUDE_CODE_CAPABILITIES, claudeCodeAdapter } from '../adapters/claude-code/adapter.js';
import { NO_DECISION_MESSAGE } from '../adapters/claude-code/decide.js';
import { KeyStoreError } from '../adapters/file-key-store.js';
import { createFilePauseStore, type PauseStore } from '../adapters/file-pause-store.js';
import { createFileStatsStore, type StatsStore } from '../adapters/file-stats-store.js';
import { HookReceiverBindError, type HookReceiver } from '../adapters/hook-receiver.js';
import { DEFAULT_HOLD_SECONDS } from '../core/agent-config.js';
import { projectName } from '../core/approval-view.js';
import { defaultConfigText } from '../core/default-config-text.js';
import { createHookDispatcher } from '../core/hook-dispatcher.js';
import { createLauncher, FOLLOW_UP_MIN_VERSION, versionAtLeast } from '../core/launcher.js';
import {
  HooksSettingsError,
  createHooksInstaller,
  type HookStateEntry,
} from '../core/hooks-installer.js';
import { loadConfig, type LoadConfigResult } from '../core/load-config.js';
import { createPairingLock, PAIRING_LOCK_FILE } from '../core/pairing-lock.js';
import { runPairing, type PairingOutcome } from '../core/pairing.js';
import { isPaused, parseDuration, pauseAt, pauseStatusText } from '../core/pause-state.js';
import { createPauseWatch } from '../core/pause-watch.js';
import { createPendingStore } from '../core/pending-store.js';
import { noticeKind, noticeSummaryText } from '../core/push-summary.js';
import { createRelayLink, type RelayLink } from '../core/relay-link.js';
import { relayEndpoints } from '../core/relay-url.js';
import { resolveRepository } from '../core/resolve-repository.js';
import { createSessionRegistry } from '../core/session-registry.js';
import {
  createActivityTracker,
  decisionStat,
  formatStats,
  statsHistory,
  type StatDelta,
} from '../core/usage-stats.js';
import type { Container } from '../container.js';
import { installService, serviceStatusLine, uninstallService } from './service.js';
import { startUpdateChecks, updateCommand, updateStatusLine } from './update.js';

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
  install [--dry-run]      Run the agent as a login service (launchd, systemd --user,
                           Task Scheduler)
  uninstall [--dry-run]    Stop and remove the login service
  status                   Show configuration, allowed repositories and keys
  login <rc-enroll:token> [--user-id <uuid>]
                           Store the relay credentials from the enrolment token
  pair                     Pair a phone with this agent
  devices                  List paired phones
  hooks install            Install the Claude Code approval hooks
  hooks remove             Remove the Claude Code approval hooks
  hooks status             Show whether the hooks are installed
  logs [-f] [-n <lines>]   Print the agent log (-f follows it)
  update                   Check npm for a newer remotectl (never installs it)
  pause [--for <duration>] Hand every request straight back to the terminal; nothing
                           reaches the phones (duration: 30m, 2h, 1d; default: until
                           \`remotectl resume\`)
  resume                   End a pause

Options:
  -h, --help               Show this help
  -v, --version            Show the version

Environment:
  REMOTECTL_NO_UPDATE_CHECK=1   No automatic update check in \`run\` and \`status\`
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
  login: loginCommand,
  pair: pairCommand,
  devices: devicesCommand,
  hooks: hooksCommand,
  logs: logsCommand,
  install: installCommand,
  uninstall: uninstallCommand,
  update: updateCliCommand,
  pause: pauseCommand,
  resume: resumeCommand,
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
  const credentials = await c.keyStore.readRelayCredentials();
  const log = await c.openLog();
  const updates = startUpdateChecks(c, log.logger);
  const stats = openStats(c, (message) =>
    log.logger.warn({ event: 'stats_write_failed' }, message),
  );
  const activity = createActivityTracker();
  let link: RelayLink | undefined;
  /** Counts `delta`; a phone hears of it unless only a tool call was added (M2-06). */
  const count = (cwd: unknown, delta: StatDelta): void => {
    void stats.record(projectName(cwd), delta).then(() => {
      if (Object.keys(delta).some((field) => field !== 'toolCalls')) link?.hub.historyChanged();
    });
  };
  // `remotectl pause` is re-read per blocking hook (and polled while requests are held),
  // so a running agent follows pause and resume without a restart.
  const pauseStore = openPause(c);
  const paused = async (): Promise<boolean> => isPaused(await pauseStore.read(), c.clock.now());
  const pending: { changed?: () => void } = {};
  const store = createPendingStore({
    clock: c.clock,
    timer: c.timer,
    random: c.random,
    onEvent: (event) => {
      link?.hub.pendingEvent(event);
      pending.changed?.();
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
  const pauseWatch = createPauseWatch({ store, timer: c.timer, paused });
  pending.changed = () => pauseWatch.pendingChanged();
  // Sessions on this machine, from hooks and the CLI roster (M1-04, 04 §5.3).
  const sessions = createSessionRegistry({
    clock: c.clock,
    timer: c.timer,
    cli: c.claude,
    onChange: () => link?.hub.sessionsChanged(),
  });
  const handler = createHookDispatcher({
    store,
    paused,
    onEvent: (input) => {
      log.logger.debug({ event: 'hook', hook: input.hook_event_name });
      const cwd = input['cwd'];
      if (typeof cwd === 'string') {
        sessions.observe(input.session_id, cwd, input.hook_event_name === 'SessionEnd');
      }
      const delta = activity.observe(input, c.clock.now());
      if (delta !== undefined) count(cwd, delta);
      const notice = noticeKind(input, config.notifications);
      if (notice !== undefined) link?.hub.notice(noticeSummaryText(input, notice));
    },
    ...(config.agent.onExpire === 'deny'
      ? {
          onDeadline: (request) =>
            claudeCodeAdapter.decide(request, { behavior: 'deny', message: NO_DECISION_MESSAGE }),
        }
      : {}),
  });
  if (config.relay !== undefined && credentials !== undefined) {
    const endpoints = relayEndpoints(config.relay.url);
    const lock = createPairingLock(c.fs, c.pathPort.join(c.paths.data, PAIRING_LOCK_FILE), c.clock);
    // Follow-ups need `--resume <id> --bg` to keep the session id (04 §2.8).
    const claudeVersion = await c.claude.version();
    const followUps = versionAtLeast(claudeVersion, FOLLOW_UP_MIN_VERSION);
    log.logger.info({ event: 'claude_cli', version: claudeVersion ?? null, followUps });
    const launcher = createLauncher({
      roots: config.repositories,
      paths: c.pathPort,
      cli: c.claude,
      registry: sessions,
      random: c.random,
      followUps,
      // Ids and codes only, never a prompt or a path (I3).
      log: (event, fields) => log.logger.info({ ...fields, event }),
    });
    link = createRelayLink({
      clock: c.clock,
      random: c.random,
      timer: c.timer,
      userId: credentials.userId,
      deviceKey: key.keyPair,
      store,
      listPeers: () => c.keyStore.listPeers(),
      decide: (request, decision) => {
        const field = decisionStat(decision.behavior);
        if (field !== undefined) count(request.payload['cwd'], { [field]: 1 });
        return claudeCodeAdapter.decide(request, decision);
      },
      machine: {
        name: c.hostname,
        platform: snapshotPlatform(c.platform),
        agentVersion: c.version,
      },
      capabilities: [{ ...CLAUDE_CODE_CAPABILITIES, startSession: true, instructions: followUps }],
      launcher,
      alwaysDestinations: config.always.destinations,
      history: async () => statsHistory(await stats.read()),
      url: endpoints.ws,
      token: credentials.token,
      version: c.version,
      webSocket: c.webSocket,
      // `remotectl pair` owns the device's relay socket while it runs.
      canConnect: async () => !(await lock.held()),
      // Event names, ids and codes only (I3).
      log: (event, fields) => log.logger.info({ ...fields, event }),
    });
  } else {
    log.logger.info({
      event: 'relay_disabled',
      reason: config.relay === undefined ? 'no_relay_url' : 'not_logged_in',
    });
  }
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
    link?.start();
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
    link?.stop();
    sessions.close();
    pauseWatch.stop();
    // Held hooks get `{}` (handoff) instead of a dropped connection.
    store.releaseAll('shutdown');
    await receiver?.close();
    await updates.stop();
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
  out(`pause:           ${pauseStatusText(await openPause(c).read(), c.clock.now())}`);
  const [statsHead, ...statsProjects] = formatStats(await openStats(c, () => undefined).read());
  out(`local counters:  ${statsHead!}`);
  for (const line of statsProjects) out(line);
  out(`service:         ${await serviceStatusLine(c)}`);
  out(`update:          ${await updateStatusLine(c)}`);
  return exitCode;
}

/** The local usage counters (M1-11): this computer only, never sent to the relay (I1/I3). */
function openStats(c: Container, onWarning: (message: string) => void): StatsStore {
  return createFileStatsStore({
    dir: c.paths.data,
    fs: c.fs,
    paths: c.pathPort,
    clock: c.clock,
    onWarning,
  });
}

/** The `remotectl pause` switch (M1-03) in the data directory. */
function openPause(c: Container): PauseStore {
  return createFilePauseStore({ dir: c.paths.data, fs: c.fs, paths: c.pathPort });
}

/**
 * `remotectl pause [--for <duration>]` (M1-03): a running agent hands every blocking hook
 * straight back to the terminal (D10 handoff) and sends nothing to the phones.
 */
async function pauseCommand(args: readonly string[], c: Container): Promise<number> {
  const { values } = parse(args, { options: { for: { type: 'string' } } });
  let durationMs: number | undefined;
  if (values.for !== undefined) {
    durationMs = parseDuration(String(values.for));
    if (durationMs === undefined) {
      throw new UsageError(
        `invalid duration '${String(values.for)}' (use minutes, hours or days: 30m, 2h, 1d; at most 30d)`,
      );
    }
  }
  const state = pauseAt(c.clock.now(), durationMs);
  await openPause(c).write(state);
  c.output.stdout(
    `Paused: requests go straight to the terminal; nothing reaches your phones` +
      `${state.until === null ? ' until `remotectl resume`' : ` until ${new Date(state.until).toISOString()}`}.\n`,
  );
  return EXIT_OK;
}

/** `remotectl resume` (M1-03): ends a pause; requests reach the phones again. */
async function resumeCommand(args: readonly string[], c: Container): Promise<number> {
  noArguments(args);
  const pause = openPause(c);
  const was = isPaused(await pause.read(), c.clock.now());
  await pause.clear();
  c.output.stdout(was ? 'Resumed: requests reach your phones again.\n' : 'Not paused.\n');
  return EXIT_OK;
}

/** The snapshot's platform (D-protocol `Machine.platform`); other Unixes report `linux`. */
function snapshotPlatform(platform: NodeJS.Platform): 'darwin' | 'linux' | 'win32' {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux';
}

const ENROLL_PREFIX = 'rc-enroll:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The relay URL from a valid config, or an error message. */
async function relayUrl(c: Container): Promise<string | undefined> {
  const loaded = await loadConfig(c.paths.config, c.fs, c.pathPort);
  if (loaded.status === 'invalid') {
    reportInvalidConfig(c, loaded);
    return undefined;
  }
  if (loaded.status === 'ok' && loaded.config.relay !== undefined) return loaded.config.relay.url;
  c.output.stderr(`remotectl: no relay configured; set "relay": { "url": … } in ${loaded.path}\n`);
  return undefined;
}

/**
 * `remotectl login <rc-enroll:token> [--user-id <uuid>]`: trades the one-time enrolment
 * token for a fresh agent token (the enrolment token stops working) and stores it with
 * the account id the relay reports in `relay.json` (0600). `--user-id` is an optional
 * cross-check: when given, it must match the relay's answer.
 */
async function loginCommand(args: readonly string[], c: Container): Promise<number> {
  const { values, positionals } = parse(args, {
    allowPositionals: true,
    options: { 'user-id': { type: 'string' } },
  });
  const [enroll, ...extra] = positionals;
  if (enroll === undefined || extra.length > 0) {
    throw new UsageError('expects exactly one enrolment token');
  }
  const expected = values['user-id'];
  if (expected !== undefined && (typeof expected !== 'string' || !UUID_PATTERN.test(expected))) {
    throw new UsageError('--user-id must be the lower-case account UUID');
  }
  const url = await relayUrl(c);
  if (url === undefined) return EXIT_ERROR;
  const token = enroll.startsWith(ENROLL_PREFIX) ? enroll.slice(ENROLL_PREFIX.length) : enroll;
  const rotated = await c.relayApi(relayEndpoints(url).http, token).rotateToken();
  if (!rotated.ok) {
    c.output.stderr(`remotectl login: the relay refused the token (${rotated.error})\n`);
    return EXIT_ERROR;
  }
  const { token: agentToken, userId } = rotated.value;
  if (expected !== undefined && expected !== userId) {
    c.output.stderr(
      `remotectl login: the token belongs to account ${userId}, not ${expected}; nothing stored, ask for a new enrolment token\n`,
    );
    return EXIT_ERROR;
  }
  await c.keyStore.writeRelayCredentials({ token: agentToken, userId });
  c.output.stdout('Logged in; relay credentials stored. Run `remotectl pair` next.\n');
  return EXIT_OK;
}

const PAIRING_FAILURES: Readonly<Record<string, string>> = {
  attempts: 'three failed handshakes; the pairing slot is closed. Start again',
  expired: 'the code expired; start again',
  aborted: 'cancelled',
  relay: 'the relay refused the request',
};

function describePairing(outcome: Exclude<PairingOutcome, { status: 'paired' }>): string {
  if (outcome.status === 'declined') return 'declined; nothing was stored';
  const text = PAIRING_FAILURES[outcome.reason]!;
  return outcome.detail === undefined ? text : `${text} (${outcome.detail})`;
}

async function pairCommand(
  args: readonly string[],
  c: Container,
  options: RunCliOptions,
): Promise<number> {
  noArguments(args);
  const url = await relayUrl(c);
  if (url === undefined) return EXIT_ERROR;
  const credentials = await c.keyStore.readRelayCredentials();
  if (credentials === undefined) {
    c.output.stderr('remotectl pair: not logged in; run `remotectl login` first\n');
    return EXIT_ERROR;
  }
  const key = await c.keyStore.loadOrCreateDeviceKey();
  const endpoints = relayEndpoints(url);
  const lock = createPairingLock(c.fs, c.pathPort.join(c.paths.data, PAIRING_LOCK_FILE), c.clock);
  await lock.acquire();
  let outcome: PairingOutcome;
  try {
    outcome = await runPairing({
      clock: c.clock,
      random: c.random,
      timer: c.timer,
      userId: credentials.userId,
      deviceKey: key.keyPair,
      agentName: c.hostname,
      relayHost: endpoints.host,
      wsUrl: endpoints.ws,
      token: credentials.token,
      version: c.version,
      webSocket: c.webSocket,
      api: c.relayApi(endpoints.http, credentials.token),
      prompt: c.prompt,
      print: (line) => c.output.stdout(`${line}\n`),
      addPeer: (peer) => c.keyStore.addPeer(peer),
      signal: options.signal,
    });
  } finally {
    await lock.release();
  }
  if (outcome.status === 'paired') {
    c.output.stdout(`Paired with "${outcome.peer.name}" (${outcome.peer.deviceId}).\n`);
    return EXIT_OK;
  }
  c.output.stderr(`remotectl pair: ${describePairing(outcome)}\n`);
  return EXIT_ERROR;
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

function installCommand(args: readonly string[], c: Container): Promise<number> {
  const { values } = parse(args, { options: { 'dry-run': { type: 'boolean' } } });
  return installService(c, { dryRun: values['dry-run'] === true });
}

function uninstallCommand(args: readonly string[], c: Container): Promise<number> {
  const { values } = parse(args, { options: { 'dry-run': { type: 'boolean' } } });
  return uninstallService(c, { dryRun: values['dry-run'] === true });
}

function updateCliCommand(args: readonly string[], c: Container): Promise<number> {
  noArguments(args);
  return updateCommand(c);
}
