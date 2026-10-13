import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { seededRandom } from '@remote-control/fake-claude-code';
import { toBase64Url } from '@remote-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HookReceiverBindError } from '../adapters/hook-receiver.js';
import { createRelayHttp } from '../adapters/relay-http.js';
import { createContainer, type Container } from '../container.js';
import { createPairingLock } from '../core/pairing-lock.js';
import { createFakePhone } from '../testing/fake-phone.js';
import { createFakeRelay } from '../testing/fake-relay.js';
import { manualTime, waitFor } from '../testing/manual-time.js';
import type { ProcessResult } from '../ports/process-result.js';
import type { Systemctl } from '../ports/systemctl.js';
import { AGENT_VERSION } from '../version.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, HELP_TEXT, runCli } from './main.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

const ok = (stdout = ''): Promise<ProcessResult> =>
  Promise.resolve({ code: 0, stdout, stderr: '' });

/** A user manager that knows no `remotectl.service`. */
const notInstalledSystemctl: Systemctl = {
  daemonReload: () => ok(),
  enableNow: () => ok(),
  disableNow: () => ok(),
  restart: () => ok(),
  show: () => ok('LoadState=not-found\nActiveState=inactive\n'),
  enableLinger: () => ok(),
  showLinger: () => ok('Linger=no\n'),
};

interface Harness {
  readonly c: Container;
  readonly out: () => string;
  readonly err: () => string;
  run(argv: readonly string[], signal?: AbortSignal): Promise<number>;
}

describe('runCli', () => {
  let base: string;
  let hookSource: string;
  let h: Harness;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'remotectl-cli-')));
    let stdout = '';
    let stderr = '';
    // A Linux layout rooted in the temp dir: the real home is never touched.
    hookSource = join(base, 'dist', 'hook.cjs');
    await mkdir(join(base, 'dist'));
    await writeFile(hookSource, '// hook v1\n');
    const real = createContainer({
      platform: 'linux',
      // No npm registry request from a test; `update.test.ts` covers the checks.
      env: { REMOTECTL_NO_UPDATE_CHECK: '1' },
      homedir: join(base, 'home'),
      tmpdir: join(base, 'tmp'),
      output: { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
      clock: { now: () => 1_760_000_000_000 },
      hookSource,
      execPath: '/usr/local/bin/node',
      systemctl: notInstalledSystemctl,
      registry: { distTags: () => Promise.reject(new Error('no registry in this test')) },
    });
    // Port 0: tests never collide with an agent running on this machine.
    const c: Container = {
      ...real,
      startHookReceiver: (options) => real.startHookReceiver({ ...options, port: 0 }),
    };
    h = {
      c,
      out: () => stdout,
      err: () => stderr,
      run: (argv, signal = new AbortController().signal) => runCli(argv, c, { signal }),
    };
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function writeConfig(value: unknown): Promise<string> {
    await mkdir(h.c.paths.config, { recursive: true });
    const path = join(h.c.paths.config, 'config.json');
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  }

  describe('help and usage', () => {
    it('lists every command in --help', async () => {
      expect(await h.run(['--help'])).toBe(EXIT_OK);
      for (const command of [
        'run',
        'install',
        'uninstall',
        'status',
        'pair',
        'devices',
        'hooks install',
        'hooks remove',
        'hooks status',
        'logs',
        'update',
      ]) {
        expect(h.out()).toMatch(new RegExp(`^  ${command}\\b`, 'm'));
      }
      expect(await h.run(['help'])).toBe(EXIT_OK);
      expect(await h.run(['status', '-h'])).toBe(EXIT_OK);
      expect(h.out()).toBe(HELP_TEXT.repeat(3));
    });

    it('prints the version', async () => {
      expect(await h.run(['--version'])).toBe(EXIT_OK);
      expect(h.out()).toBe(`${AGENT_VERSION}\n`);
    });

    it('exits 2 without a command, on an unknown command and on bad options', async () => {
      expect(await h.run([])).toBe(EXIT_USAGE);
      expect(h.err()).toContain('Usage: remotectl');
      expect(await h.run(['launch'])).toBe(EXIT_USAGE);
      expect(h.err()).toContain("unknown command 'launch'");
      expect(await h.run(['toString'])).toBe(EXIT_USAGE);
      expect(await h.run(['status', '--verbose'])).toBe(EXIT_USAGE);
      expect(await h.run(['run', 'extra'])).toBe(EXIT_USAGE);
      expect(await h.run(['hooks'])).toBe(EXIT_USAGE);
      expect(await h.run(['hooks', 'enable'])).toBe(EXIT_USAGE);
      expect(await h.run(['logs', '-n', '0'])).toBe(EXIT_USAGE);
      expect(await h.run(['logs', '-n', 'ten'])).toBe(EXIT_USAGE);
      expect(h.err()).toContain('--lines must be an integer');
    });
  });

  describe('relay: login, pair and run (fake relay, fake phone)', () => {
    const RELAY_URL = 'ws://127.0.0.1:8787';

    function relayHarness(answer = true) {
      const time = manualTime();
      const random = seededRandom(3);
      const relay = createFakeRelay(time.clock);
      const questions: string[] = [];
      const c: Container = {
        ...h.c,
        clock: time.clock,
        timer: time.timer,
        random,
        webSocket: relay.webSocket,
        relayApi: (baseUrl, token) => createRelayHttp({ baseUrl, token, fetch: relay.fetch }),
        prompt: {
          confirm(question) {
            questions.push(question);
            return Promise.resolve(answer);
          },
        },
        hostname: 'build-box',
      };
      const run = (argv: readonly string[], signal = new AbortController().signal) =>
        runCli(argv, c, { signal });
      const login = () => run(['login', `rc-enroll:${relay.agent.token}`]);
      /** The code `pair` printed, once the slot is open. */
      async function code(): Promise<string> {
        await waitFor(() => /Pairing code: (\S+)/.test(h.out()));
        return /Pairing code: (\S+)/.exec(h.out())![1]!;
      }
      return { time, random, relay, c, run, login, code, questions };
    }

    it('login trades the enrolment token and stores relay.json owner-only', async () => {
      const r = relayHarness();
      expect(await r.run(['login'])).toBe(EXIT_USAGE);
      expect(await r.run(['login', 'a', 'b'])).toBe(EXIT_USAGE);
      expect(await r.run(['login', 'rc-enroll:x', '--user-id', 'NOT-A-UUID'])).toBe(EXIT_USAGE);
      expect(h.err()).toContain('--user-id must be the lower-case account UUID');
      // No relay configured yet.
      expect(await r.login()).toBe(EXIT_ERROR);
      expect(h.err()).toContain('no relay configured');
      await writeConfig('{');
      expect(await r.login()).toBe(EXIT_ERROR);
      await writeConfig({ relay: { url: RELAY_URL } });
      expect(await r.run(['login', 'rc-enroll:wrong'])).toBe(EXIT_ERROR);
      expect(h.err()).toContain('the relay refused the token (unauthorized)');
      expect(await r.login()).toBe(EXIT_OK);
      const stored = await h.c.keyStore.readRelayCredentials();
      expect(stored).toMatchObject({ userId: r.relay.userId });
      expect(stored!.token).not.toBe(r.relay.agent.token);
      if (process.platform !== 'win32') {
        expect((await stat(join(h.c.paths.data, 'relay.json'))).mode & 0o777).toBe(0o600);
      }
      // The enrolment token is spent.
      expect(await r.login()).toBe(EXIT_ERROR);
    });

    it('login --user-id cross-checks the account the relay reports', async () => {
      await writeConfig({ relay: { url: RELAY_URL } });
      const other = '11111111-2222-4333-8444-555555555555';
      const r = relayHarness();
      expect(await r.run(['login', `rc-enroll:${r.relay.agent.token}`, '--user-id', other])).toBe(
        EXIT_ERROR,
      );
      expect(h.err()).toContain(`belongs to account ${r.relay.userId}, not ${other}`);
      expect(await h.c.keyStore.readRelayCredentials()).toBeUndefined();
      const s = relayHarness();
      expect(
        await s.run(['login', `rc-enroll:${s.relay.agent.token}`, '--user-id', s.relay.userId]),
      ).toBe(EXIT_OK);
      expect(await h.c.keyStore.readRelayCredentials()).toMatchObject({ userId: s.relay.userId });
    });

    it('pair needs a relay and a login', async () => {
      const r = relayHarness();
      expect(await r.run(['pair'])).toBe(EXIT_ERROR);
      expect(h.err()).toContain('no relay configured');
      await writeConfig({ relay: { url: RELAY_URL } });
      expect(await r.run(['pair'])).toBe(EXIT_ERROR);
      expect(h.err()).toContain('not logged in');
      expect(await r.run(['pair', 'extra'])).toBe(EXIT_USAGE);
    });

    it('pairs a phone, then `run` gives that phone a KK session with the snapshot', async () => {
      const r = relayHarness();
      await writeConfig({ relay: { url: RELAY_URL } });
      expect(await r.login()).toBe(EXIT_OK);
      const phone = await createFakePhone(r.relay, 'Pixel', r.time.clock, r.random);
      await phone.connect();
      const pairing = r.run(['pair']);
      await phone.pair(await r.code());
      expect(await pairing).toBe(EXIT_OK);
      expect(h.out()).toContain(`QR text:      rc1:127.0.0.1:8787:${r.relay.agent.id}:`);
      expect(h.out()).toContain(`Paired with "Pixel" (${phone.device.id}).`);
      expect(r.questions).toHaveLength(1);
      expect(await h.c.keyStore.listPeers()).toEqual([phone.peer(r.time.clock.now())]);
      // The pairing lock is gone, so `run` may connect.
      await expect(stat(join(h.c.paths.data, 'pairing.lock'))).rejects.toThrow();

      const controller = new AbortController();
      const running = r.run(['run'], controller.signal);
      await vi.waitFor(() => expect(h.out()).toContain('press Ctrl-C to stop'));
      await waitFor(() => r.relay.online(r.relay.agent.id));
      const key = (await h.c.keyStore.readDeviceKey())!.keyPair;
      await phone.handshake(r.relay.agent.id, key.publicKey);
      expect(phone.of('snapshot')[0]!.machine).toMatchObject({
        id: r.relay.agent.id,
        name: 'build-box',
        platform: 'linux',
        agentVersion: AGENT_VERSION,
      });

      // M1-11: a new session and a phone decision move the local counters.
      const endpoint = JSON.parse(await readFile(join(h.c.paths.data, 'agent.json'), 'utf8')) as {
        port: number;
        token: string;
      };
      const postHook = (body: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${endpoint.port}/hook`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${endpoint.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ session_id: 's1', cwd: '/work/remote-control', ...body }),
        });
      expect((await postHook({ hook_event_name: 'SessionStart', source: 'startup' })).ok).toBe(
        true,
      );
      const answer = postHook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
      });
      await waitFor(() => phone.of('request').length > 0);
      const request = phone.of('request')[0]!.request;
      expect(request).toMatchObject({ toolLabel: 'Run a command', project: 'remote-control' });
      await phone.decide('allow', request);
      expect((await answer).status).toBe(200);
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(join(h.c.paths.data, 'stats.json'), 'utf8'))).toEqual({
          version: 1,
          projects: { 'remote-control': { approvals: 1, denials: 0, sessionsStarted: 1 } },
        });
      });
      controller.abort();
      expect(await running).toBe(EXIT_OK);
      expect(r.relay.online(r.relay.agent.id)).toBe(false);
      const log = await readFile(join(h.c.paths.log, 'agent.1.log'), 'utf8');
      expect(log).toContain('"event":"relay_ready"');
      expect(log).not.toContain('relay_disabled');
    });

    it('pair reports a declined fingerprint and stores nothing', async () => {
      const r = relayHarness(false);
      await writeConfig({ relay: { url: RELAY_URL } });
      expect(await r.login()).toBe(EXIT_OK);
      const phone = await createFakePhone(r.relay, 'Pixel', r.time.clock, r.random);
      await phone.connect();
      const pairing = r.run(['pair']);
      await phone.pair(await r.code());
      expect(await pairing).toBe(EXIT_ERROR);
      expect(h.err()).toContain('remotectl pair: declined; nothing was stored');
      expect(await h.c.keyStore.listPeers()).toEqual([]);
    });

    it('pair reports an expired code and a relay refusal', async () => {
      const r = relayHarness();
      await writeConfig({ relay: { url: RELAY_URL } });
      expect(await r.login()).toBe(EXIT_OK);
      const pairing = r.run(['pair']);
      await r.code();
      r.time.advance(5 * 60_000);
      expect(await pairing).toBe(EXIT_ERROR);
      expect(h.err()).toContain('remotectl pair: the code expired; start again');

      const refusing: Container = {
        ...r.c,
        relayApi: () => ({
          ...createRelayHttp({ baseUrl: 'http://x', token: 't', fetch: r.relay.fetch }),
          openSlot: () => Promise.resolve({ ok: false, status: 429, error: 'rate_limited' }),
        }),
      };
      expect(await runCli(['pair'], refusing, { signal: new AbortController().signal })).toBe(
        EXIT_ERROR,
      );
      expect(h.err()).toContain('the relay refused the request (rate_limited)');
    });

    it('run holds its relay connection while a pairing lock is held', async () => {
      const r = relayHarness();
      await writeConfig({ relay: { url: RELAY_URL } });
      expect(await r.login()).toBe(EXIT_OK);
      await createPairingLock(h.c.fs, join(h.c.paths.data, 'pairing.lock'), r.time.clock).acquire();
      const controller = new AbortController();
      const running = r.run(['run'], controller.signal);
      await vi.waitFor(() => expect(h.out()).toContain('press Ctrl-C to stop'));
      await delay(20);
      expect(r.relay.attempts(r.relay.agent.id)).toBe(0);
      controller.abort();
      expect(await running).toBe(EXIT_OK);
    });
  });

  describe('hooks', () => {
    const settingsPath = (): string => join(base, 'home', '.claude', 'settings.json');

    it('installs into ~/.claude, reports status and removes again', async () => {
      await mkdir(join(base, 'home', '.claude'), { recursive: true });
      const original = '{\n  "model": "opus"\n}\n';
      await writeFile(settingsPath(), original);

      expect(await h.run(['hooks', 'status'])).toBe(EXIT_OK);
      expect(h.out()).toContain(`settings:     ${settingsPath()}\n`);
      expect(h.out()).toMatch(/PermissionRequest\s+missing/);
      expect(h.out()).toContain('(missing)');
      expect(h.out()).toContain('Run `remotectl hooks install`');
      expect(h.out()).toContain('Claude Code runs hooks only in folders you have trusted');

      expect(await h.run(['hooks', 'install'])).toBe(EXIT_OK);
      expect(h.out()).toContain(`Installed the hooks in ${settingsPath()}.`);
      expect(h.out()).toMatch(/Backup: .*settings\.json\.backup-/);
      const installed = JSON.parse(await readFile(settingsPath(), 'utf8')) as {
        model: string;
        hooks: Record<
          string,
          { matcher?: string; hooks: { command: string; timeout: number }[] }[]
        >;
      };
      expect(installed.model).toBe('opus');
      const script = join(h.c.paths.data, 'hook.cjs');
      expect(installed.hooks['PermissionRequest']).toEqual([
        {
          hooks: [
            { type: 'command', command: `"/usr/local/bin/node" "${script}" 1800`, timeout: 1800 },
          ],
        },
      ]);
      expect(await readFile(script, 'utf8')).toBe('// hook v1\n');

      expect(await h.run(['hooks', 'install'])).toBe(EXIT_OK);
      expect(h.out()).toContain('Hooks already installed');

      expect(await h.run(['hooks', 'status'])).toBe(EXIT_OK);
      expect(h.out()).toMatch(/PreToolUse \(\^AskUserQuestion\$\)\s+installed/);
      expect(h.out()).toContain('Hooks are installed.');

      expect(await h.run(['hooks', 'remove'])).toBe(EXIT_OK);
      expect(h.out()).toContain(`Removed the hooks in ${settingsPath()}.`);
      expect(await readFile(settingsPath(), 'utf8')).toBe(original);
      expect(await h.run(['hooks', 'remove'])).toBe(EXIT_OK);
      expect(h.out()).toContain('No remotectl hooks in');
    });

    it('uses holdSeconds from the config', async () => {
      await writeConfig({ hooks: { holdSeconds: 600 } });
      expect(await h.run(['hooks', 'install'])).toBe(EXIT_OK);
      expect(h.out()).not.toContain('Backup:');
      expect(await readFile(settingsPath(), 'utf8')).toContain('hook.cjs\\" 600"');
    });

    it('refuses a corrupt settings.json and an invalid config', async () => {
      await mkdir(join(base, 'home', '.claude'), { recursive: true });
      await writeFile(settingsPath(), '{ "hooks": ');
      expect(await h.run(['hooks', 'install'])).toBe(EXIT_ERROR);
      expect(h.err()).toContain(`remotectl hooks install: ${settingsPath()} is not valid JSON`);
      expect(await readFile(settingsPath(), 'utf8')).toBe('{ "hooks": ');

      await writeConfig({ hooks: { holdSeconds: 1 } });
      expect(await h.run(['hooks', 'status'])).toBe(EXIT_ERROR);
      expect(h.err()).toContain('  hooks.holdSeconds: ');
    });

    it('rethrows unexpected installer errors', async () => {
      const broken: Container = {
        ...h.c,
        fs: { ...h.c.fs, readText: () => Promise.reject(new Error('disk on fire')) },
      };
      await expect(
        runCli(['hooks', 'status'], broken, { signal: new AbortController().signal }),
      ).rejects.toThrow('disk on fire');
    });
  });

  describe('run', () => {
    posixOnly('writes a default config, creates the key, logs and stops on abort', async () => {
      const controller = new AbortController();
      const running = h.run(['run'], controller.signal);
      await vi.waitFor(() => expect(h.out()).toContain('press Ctrl-C to stop'));
      controller.abort();
      expect(await running).toBe(EXIT_OK);

      const configPath = join(h.c.paths.config, 'config.json');
      expect(h.out()).toContain(`Wrote a default config to ${configPath}`);
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
        repositories: [],
        hooks: { holdSeconds: 1800 },
        agent: { onExpire: 'handoff' },
      });
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(h.c.paths.data, 'device-key.json'))).mode & 0o777).toBe(0o600);

      const log = await readFile(join(h.c.paths.log, 'agent.1.log'), 'utf8');
      const lines = log
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.map((line) => line['event'])).toEqual([
        'relay_disabled',
        'agent_start',
        'agent_stop',
      ]);
      expect(lines[0]).toMatchObject({ reason: 'no_relay_url' });
      expect(lines[1]).toMatchObject({ name: 'agent', version: AGENT_VERSION, keyCreated: true });
      expect(log).not.toContain('privateKey');
      // The hook endpoint is published owner-only, with the bound port (D11).
      const endpointPath = join(h.c.paths.data, 'agent.json');
      expect((await stat(endpointPath)).mode & 0o777).toBe(0o600);
      const endpoint = JSON.parse(await readFile(endpointPath, 'utf8')) as Record<string, unknown>;
      expect(endpoint).toMatchObject({ version: 1, generation: 1 });
      expect(endpoint['port']).toBe(lines[1]?.['hookPort']);
      expect(log).not.toContain(endpoint['token'] as string);
    });

    it('returns at once when already aborted and keeps an existing config', async () => {
      await writeConfig({ repositories: [base] });
      const controller = new AbortController();
      controller.abort();
      expect(await h.run(['run'], controller.signal)).toBe(EXIT_OK);
      expect(h.out()).not.toContain('Wrote a default config');
    });

    it('refuses to start with an invalid config', async () => {
      const path = await writeConfig({ hooks: { holdSeconds: 1 } });
      expect(await h.run(['run'])).toBe(EXIT_ERROR);
      expect(h.err()).toContain(`invalid config file ${path}`);
      expect(h.err()).toContain('  hooks.holdSeconds: ');
    });

    it('answers held hooks with {} on shutdown', async () => {
      await writeConfig({});
      const controller = new AbortController();
      const running = h.run(['run'], controller.signal);
      await vi.waitFor(() => expect(h.out()).toContain('press Ctrl-C to stop'));
      const endpoint = JSON.parse(await readFile(join(h.c.paths.data, 'agent.json'), 'utf8')) as {
        port: number;
        token: string;
      };
      const answer = fetch(`http://127.0.0.1:${endpoint.port}/hook`, {
        method: 'POST',
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's1' }),
      });
      await vi.waitFor(async () => {
        const log = await readFile(join(h.c.paths.log, 'agent.1.log'), 'utf8').catch(() => '');
        expect(log).toContain('pending_added');
      });
      controller.abort();
      const response = await answer;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{}');
      expect(await running).toBe(EXIT_OK);
      const log = await readFile(join(h.c.paths.log, 'agent.1.log'), 'utf8');
      expect(log).toContain('"outcome":"shutdown"');
      expect(log).not.toContain('session_id');
    });

    it('denies at the deadline when agent.onExpire is "deny" (D10)', async () => {
      await writeConfig({ agent: { onExpire: 'deny' } });
      const c: Container = {
        ...h.c,
        // Every hold ends at once: the deadline path without waiting 30 minutes.
        timer: {
          after: (_ms, callback) => {
            setImmediate(callback);
            return { cancel: () => undefined };
          },
        },
      };
      const controller = new AbortController();
      const running = runCli(['run'], c, { signal: controller.signal });
      await vi.waitFor(() => expect(h.out()).toContain('press Ctrl-C to stop'));
      const endpoint = JSON.parse(await readFile(join(h.c.paths.data, 'agent.json'), 'utf8')) as {
        port: number;
        token: string;
      };
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook`, {
        method: 'POST',
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's1' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: 'No decision from phone', interrupt: false },
        },
      });
      controller.abort();
      expect(await running).toBe(EXIT_OK);
      const log = await readFile(join(h.c.paths.log, 'agent.1.log'), 'utf8');
      expect(log).toContain('"outcome":"deadline"');
    });

    it('exits 1 when the hook port cannot be bound', async () => {
      await writeConfig({});
      const c: Container = {
        ...h.c,
        startHookReceiver: () =>
          Promise.reject(new HookReceiverBindError('cannot listen on 127.0.0.1:4327: EADDRINUSE')),
      };
      expect(await runCli(['run'], c, { signal: new AbortController().signal })).toBe(EXIT_ERROR);
      expect(h.err()).toContain('remotectl run: cannot listen on 127.0.0.1:4327: EADDRINUSE');
      expect(await h.c.keyStore.readHookEndpoint()).toBeUndefined();
    });

    it('rethrows unexpected receiver errors', async () => {
      await writeConfig({});
      const c: Container = {
        ...h.c,
        startHookReceiver: () => Promise.reject(new Error('boom')),
      };
      await expect(runCli(['run'], c, { signal: new AbortController().signal })).rejects.toThrow(
        'boom',
      );
    });

    it('refuses to start with a broken device key', async () => {
      await writeConfig({});
      await mkdir(h.c.paths.data, { recursive: true });
      await writeFile(join(h.c.paths.data, 'device-key.json'), '{}');
      expect(await h.run(['run'])).toBe(EXIT_ERROR);
      expect(h.err()).toContain('remotectl run: device-key.json has an invalid format');
    });
  });

  describe('status', () => {
    it('reports a missing config and no key', async () => {
      expect(await h.run(['status'])).toBe(EXIT_OK);
      expect(h.out()).toContain(`remotectl ${AGENT_VERSION}`);
      expect(h.out()).toContain('(missing; `remotectl run` writes a default)');
      expect(h.out()).toContain(`data dir:        ${h.c.paths.data}`);
      expect(h.out()).toContain('device key:      (not created yet)');
      expect(h.out()).toContain('paired devices:  0');
      expect(h.out()).toContain('service:         not installed (`remotectl install`)\n');
      expect(h.out()).toContain('update:          check disabled\n');
      expect(h.out()).toContain('local counters:  (none yet)\n');
    });

    it('shows the local counters per project (M1-11)', async () => {
      await mkdir(h.c.paths.data, { recursive: true });
      await writeFile(
        join(h.c.paths.data, 'stats.json'),
        JSON.stringify({
          version: 1,
          projects: {
            web: { approvals: 1, denials: 0, sessionsStarted: 1 },
            api: { approvals: 2, denials: 1, sessionsStarted: 0 },
          },
        }),
      );
      expect(await h.run(['status'])).toBe(EXIT_OK);
      expect(h.out()).toContain(
        'local counters:  3 approved, 1 denied, 1 session\n' +
          '  api  2 approved, 1 denied, 0 sessions\n' +
          '  web  1 approved, 0 denied, 1 session\n',
      );
    });

    it('reports the config, each repository root and the public key', async () => {
      const repo = join(base, 'repo');
      await mkdir(repo);
      await writeConfig({
        repositories: [repo, join(base, 'gone')],
        relay: { url: 'wss://relay.example.com' },
      });
      const key = await h.c.keyStore.loadOrCreateDeviceKey();
      expect(await h.run(['status'])).toBe(EXIT_OK);
      expect(h.out()).toContain('hold seconds:    1800');
      expect(h.out()).toContain('on expire:       handoff');
      expect(h.out()).toContain('relay:           wss://relay.example.com');
      expect(h.out()).toContain(`  ${repo}  ok (${repo})`);
      expect(h.out()).toContain(`  ${join(base, 'gone')}  not_found`);
      expect(h.out()).toContain(`device key:      ${toBase64Url(key.keyPair.publicKey)}`);
    });

    it('shows an empty repository list and exits 1 on an invalid config', async () => {
      await writeConfig({});
      expect(await h.run(['status'])).toBe(EXIT_OK);
      expect(h.out()).toMatch(/^repositories: {4}\(none\)$/m);
      await writeConfig('{');
      expect(await h.run(['status'])).toBe(EXIT_ERROR);
      expect(h.out()).toContain('(invalid)');
      expect(h.err()).toContain('not valid JSON');
    });
  });

  describe('devices', () => {
    it('lists paired phones', async () => {
      expect(await h.run(['devices'])).toBe(EXIT_OK);
      expect(h.out()).toBe('No paired devices.\n');
      await h.c.keyStore.addPeer({
        deviceId: '00000000-0000-4000-8000-000000000001',
        name: 'Pixel',
        publicKey: toBase64Url(new Uint8Array(32).fill(7)),
        pairedAt: Date.UTC(2026, 9, 1),
      });
      expect(await h.run(['devices'])).toBe(EXIT_OK);
      expect(h.out()).toContain(
        '00000000-0000-4000-8000-000000000001  Pixel  paired 2026-10-01T00:00:00.000Z\n',
      );
    });
  });

  describe('logs', () => {
    async function writeLog(name: string, text: string): Promise<string> {
      await mkdir(h.c.paths.log, { recursive: true });
      const path = join(h.c.paths.log, name);
      await writeFile(path, text);
      return path;
    }

    it('says so when there are no logs', async () => {
      expect(await h.run(['logs'])).toBe(EXIT_OK);
      expect(h.out()).toBe(`No logs yet in ${h.c.paths.log}.\n`);
    });

    it('prints the last lines of the newest log file', async () => {
      await writeLog('agent.2.log', 'old\n');
      await writeLog('agent.10.log', 'a\nb\nc\n');
      await writeLog('other.log', 'x\n');
      expect(await h.run(['logs', '-n', '2'])).toBe(EXIT_OK);
      expect(h.out()).toBe('b\nc\n');
    });

    it('drops a partial first line when only the tail of a large file is read', async () => {
      const line = `${'x'.repeat(99)}\n`;
      await writeLog('agent.1.log', `${line.repeat(11_000)}last\n`);
      expect(await h.run(['logs', '--lines', '10000'])).toBe(EXIT_OK);
      const printed = h.out().split('\n');
      expect(printed.at(-2)).toBe('last');
      expect(printed.slice(0, -2).every((entry) => entry === line.trimEnd())).toBe(true);
    });

    it('prints nothing for an empty log file', async () => {
      await writeLog('agent.1.log', '');
      expect(await h.run(['logs'])).toBe(EXIT_OK);
      expect(h.out()).toBe('');
    });

    it('follows appends, truncation and rotation until aborted', async () => {
      const fast: Container = {
        ...h.c,
        sleep: (_ms, signal) => delay(5, undefined, { signal }),
      };
      const controller = new AbortController();
      const following = runCli(['logs', '-f'], fast, { signal: controller.signal });
      await delay(20);
      const first = await writeLog('agent.1.log', 'one\n');
      await vi.waitFor(() => expect(h.out()).toBe('one\n'));
      await appendFile(first, 'two\n');
      await vi.waitFor(() => expect(h.out()).toBe('one\ntwo\n'));
      await writeFile(first, 'x\n');
      await vi.waitFor(() => expect(h.out()).toBe('one\ntwo\nx\n'));
      await writeLog('agent.2.log', 'rotated\n');
      await vi.waitFor(() => expect(h.out()).toBe('one\ntwo\nx\nrotated\n'));
      controller.abort();
      expect(await following).toBe(EXIT_OK);
    });

    it('returns at once when following with an aborted signal', async () => {
      await writeLog('agent.1.log', 'one\n');
      const controller = new AbortController();
      controller.abort();
      expect(await runCli(['logs', '-f'], h.c, { signal: controller.signal })).toBe(EXIT_OK);
      expect(h.out()).toBe('one\n');
    });
  });

  it('rethrows unexpected errors', async () => {
    const broken: Container = {
      ...h.c,
      keyStore: {
        ...h.c.keyStore,
        listPeers: () => Promise.reject(new Error('disk on fire')),
      },
    };
    await expect(
      runCli(['devices'], broken, { signal: new AbortController().signal }),
    ).rejects.toThrow('disk on fire');
  });
});
