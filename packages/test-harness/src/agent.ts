import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { writeClaudeShim } from '@remote-control/fake-claude-code';
import { createContainer, runCli, type Container } from 'remotectl';

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
  /** The agent's X25519 public key (after `pair` or `run` created it). */
  publicKey(): Promise<Uint8Array>;
  close(): Promise<void>;
}

const PAIRING_CODE = /Pairing code: (\S+)/;

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
  const container: Container = {
    ...real,
    // Port 0: harness agents never collide with each other or a real agent.
    startHookReceiver: (receiver) => real.startHookReceiver({ ...receiver, port: 0 }),
  };
  await mkdir(container.paths.config, { recursive: true });
  await writeFile(
    join(container.paths.config, 'config.json'),
    JSON.stringify({ relay: { url: options.relayUrl } }),
  );

  const cli = (argv: readonly string[], signal = new AbortController().signal) =>
    runCli(argv, container, { signal });
  const running: { controller: AbortController; exit: Promise<number> }[] = [];

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
    async publicKey() {
      const key = await container.keyStore.readDeviceKey();
      if (key === undefined) throw new Error('agent: no device key yet');
      return key.keyPair.publicKey;
    },
    async close() {
      for (const { controller } of running) controller.abort();
      await Promise.all(running.splice(0).map(({ exit }) => exit));
      await rm(base, { recursive: true, force: true });
    },
  };
}
