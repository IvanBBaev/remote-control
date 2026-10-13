import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { writeClaudeShim } from '@remote-control/fake-claude-code';
import { createLogger, createMemoryDestination } from '@remote-control/log';
import { createContainer, runCli, type Container } from 'remotectl';
import { DEFAULT_HOOK_TIMEOUT_SECONDS, runHook } from 'remotectl/hook';

import { eventually } from './eventually.js';
import type { FakeClock } from './fake-clock.js';

export interface StartAgentOptions {
  /** `ws://127.0.0.1:<port>`: the relay the agent's config names. */
  readonly relayUrl: string;
  readonly clock: FakeClock;
  /** The machine name the phone sees (the snapshot's `machine.name`). */
  readonly name: string;
  /** Answer to the pairing fingerprint question (default: yes). */
  readonly confirm?: boolean;
}

export interface PairingRun {
  /** The code `remotectl pair` printed, once the slot is open. */
  readonly code: Promise<string>;
  /** The command's exit code. */
  readonly done: Promise<number>;
}

/** What `hook.cjs` printed for one hook event; it always exits 0 (D10, D11). */
export interface HookResult {
  /** Stdout verbatim: the agent's JSON answer, or `''` when the hook fell through. */
  readonly stdout: string;
  /** The answer parsed; `undefined` for empty stdout. */
  readonly output: Readonly<Record<string, unknown>> | undefined;
}

export interface HarnessAgent {
  /** The temp root: `home/`, `tmp/` and `bin/` (the `claude` shim on `PATH`). */
  readonly base: string;
  readonly container: Container;
  /** Everything the CLI printed so far. */
  stdout(): string;
  stderr(): string;
  /** `remotectl login rc-enroll:<token> --user-id <uuid>`; throws on a non-zero exit. */
  login(enrollToken: string, userId: string): Promise<void>;
  /** `remotectl pair` in the background. */
  pair(): PairingRun;
  /** `remotectl run` in the background, until `stop` or `close`. */
  run(): Promise<void>;
  /** Stops `remotectl run` (Ctrl-C) and waits for it to exit. */
  stop(): Promise<void>;
  /**
   * Fires one hook event the way Claude Code runs `hook.cjs [T]`: the hook's own logic
   * (`runHook`) in process, reading `agent.json` from the data directory. `T` defaults to
   * Claude Code's 600 s; the agent holds a blocking request until `T − 10 s` on the
   * fake clock.
   */
  fire(input: Readonly<Record<string, unknown>>, timeoutSeconds?: number): Promise<HookResult>;
  /** Every agent log line (JSON), for canary scans and the decision log. */
  logs(): string[];
  /** The agent's X25519 public key (after `pair` or `run` created it). */
  publicKey(): Promise<Uint8Array>;
  close(): Promise<void>;
}

const PAIRING_CODE = /Pairing code: (\S+)/;
/** The file `hook.cjs` reads next to itself (D11). */
const AGENT_ENDPOINT_FILE = 'agent.json';

/**
 * The agent in process (07 §5.6): the real `remotectl` CLI and container on a temp HOME
 * (Linux layout), the shared fake clock as its `Clock` and `Timer`, the hook listener on
 * loopback port 0, and `fake-claude` on `PATH` as `claude`.
 */
export async function startAgent(options: StartAgentOptions): Promise<HarnessAgent> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rc-harness-agent-')));
  const bin = join(base, 'bin');
  writeClaudeShim(bin);
  const hookSource = join(base, 'dist', 'hook.cjs');
  await mkdir(join(base, 'dist'));
  await writeFile(hookSource, '// harness hook\n');
  let out = '';
  let err = '';
  const real = createContainer({
    platform: 'linux',
    env: {
      REMOTECTL_NO_UPDATE_CHECK: '1',
      PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
    },
    homedir: join(base, 'home'),
    tmpdir: join(base, 'tmp'),
    output: { stdout: (text) => (out += text), stderr: (text) => (err += text) },
    clock: options.clock,
    timer: options.clock,
    hookSource,
    registry: { distTags: () => Promise.reject(new Error('no registry in the harness')) },
    prompt: { confirm: () => Promise.resolve(options.confirm ?? true) },
    hostname: options.name,
  });
  const destination = createMemoryDestination();
  const container: Container = {
    ...real,
    // Port 0: harness agents never collide with each other or a real agent.
    startHookReceiver: (receiver) => real.startHookReceiver({ ...receiver, port: 0 }),
    // Captured in memory instead of the rolling file, for the privacy gate (07 §5.12).
    openLog: () =>
      Promise.resolve({
        logger: createLogger({ name: 'agent', destination }),
        close: () => Promise.resolve(),
      }),
  };
  await mkdir(container.paths.config, { recursive: true });
  await writeFile(
    join(container.paths.config, 'config.json'),
    JSON.stringify({ relay: { url: options.relayUrl } }),
  );

  const cli = (argv: readonly string[], signal = new AbortController().signal) =>
    runCli(argv, container, { signal });
  const running: { controller: AbortController; exit: Promise<number> }[] = [];
  const stop = async () => {
    for (const { controller } of running) controller.abort();
    await Promise.all(running.splice(0).map(({ exit }) => exit));
  };

  return {
    base,
    container,
    stdout: () => out,
    stderr: () => err,
    async login(enrollToken, userId) {
      const code = await cli(['login', enrollToken, '--user-id', userId]);
      if (code !== 0) throw new Error(`remotectl login exited ${String(code)}: ${err}`);
    },
    pair() {
      const done = cli(['pair']);
      const code = eventually(() => PAIRING_CODE.test(out), 'no pairing code printed').then(
        () => PAIRING_CODE.exec(out)![1]!,
      );
      return { code, done };
    },
    async run() {
      const controller = new AbortController();
      running.push({ controller, exit: cli(['run'], controller.signal) });
      await eventually(() => out.includes('press Ctrl-C to stop'), '`run` did not start');
    },
    stop,
    async fire(input, timeoutSeconds = DEFAULT_HOOK_TIMEOUT_SECONDS) {
      let stdout = '';
      await runHook({
        argv: [String(timeoutSeconds)],
        readStdin: () => Promise.resolve(JSON.stringify(input)),
        readEndpoint: () => readFile(join(container.paths.data, AGENT_ENDPOINT_FILE), 'utf8'),
        write: (text) => {
          stdout += text;
          return Promise.resolve();
        },
      });
      return {
        stdout,
        output:
          stdout === '' ? undefined : (JSON.parse(stdout) as Readonly<Record<string, unknown>>),
      };
    },
    logs: () => destination.lines(),
    async publicKey() {
      const key = await container.keyStore.readDeviceKey();
      if (key === undefined) throw new Error('agent: no device key yet');
      return key.keyPair.publicKey;
    },
    async close() {
      await stop();
      await rm(base, { recursive: true, force: true });
    },
  };
}
