import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateX25519KeyPair, pairingFingerprint } from '@remote-control/crypto';
import { seededRandom } from '@remote-control/fake-claude-code';
import {
  encodeFrame,
  HANDSHAKE_TAG,
  toBase64Url,
  VERSION_TABLE,
  type Frame,
} from '@remote-control/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLAUDE_CODE_CAPABILITIES, claudeCodeAdapter } from '../adapters/claude-code/adapter.js';
import { createFileKeyStore, PEERS_FILE } from '../adapters/file-key-store.js';
import { createNodeFileSystem, nodePaths } from '../adapters/node-file-system.js';
import { createRelayHttp } from '../adapters/relay-http.js';
import { systemRandom } from '../adapters/system-random.js';
import type { Peer } from '../ports/key-store.js';
import type { Prompt } from '../ports/prompt.js';
import type { RelayApi } from '../ports/relay-api.js';
import { createFakePhone } from '../testing/fake-phone.js';
import { createFakeRelay, FAKE_RELAY_ORIGIN, type FakeRelay } from '../testing/fake-relay.js';
import { manualTime, waitFor } from '../testing/manual-time.js';
import { normalizePairingCode, pairingPsk, slotCodeHash } from './pairing-code.js';
import { createPairingLock, PAIRING_LOCK_MS } from './pairing-lock.js';
import { runPairing, type PairingOptions } from './pairing.js';
import { createPendingStore } from './pending-store.js';
import { createRelayLink } from './relay-link.js';
import { uuidV7 } from './uuid.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

async function setup(overrides: Partial<PairingOptions> = {}, answer = true) {
  const time = manualTime();
  const random = seededRandom(5);
  const relay = createFakeRelay(time.clock);
  const deviceKey = await generateX25519KeyPair(random);
  const lines: string[] = [];
  const peers: Peer[] = [];
  const questions: string[] = [];
  const prompt: Prompt = {
    confirm(question) {
      questions.push(question);
      return Promise.resolve(answer);
    },
  };
  const controller = new AbortController();
  const api = createRelayHttp({
    baseUrl: FAKE_RELAY_ORIGIN,
    token: relay.agent.token,
    fetch: relay.fetch,
  });
  const options: PairingOptions = {
    clock: time.clock,
    random,
    timer: time.timer,
    userId: relay.userId,
    deviceKey,
    agentName: 'build-box',
    relayHost: 'relay.example',
    wsUrl: 'ws://127.0.0.1:8787/ws',
    token: relay.agent.token,
    version: '1.2.3',
    webSocket: relay.webSocket,
    api,
    prompt,
    print: (line) => lines.push(line),
    addPeer: (peer) => {
      peers.push(peer);
      return Promise.resolve();
    },
    signal: controller.signal,
    ...overrides,
  };
  const outcome = runPairing(options);
  /** The code as printed, once the slot is open. */
  async function code(): Promise<string> {
    await waitFor(() => lines.some((line) => line.startsWith('Pairing code: ')));
    return lines.find((line) => line.startsWith('Pairing code: '))!.slice('Pairing code: '.length);
  }
  return { time, random, relay, deviceKey, lines, peers, questions, controller, outcome, code };
}

/** A phone that joins the slot with the right code but sends a broken XXpsk0 message. */
async function badAttempt(
  relay: FakeRelay,
  phoneToken: string,
  phoneId: string,
  code: string,
  join = true,
) {
  if (join) {
    const psk = await pairingPsk(normalizePairingCode(code)!);
    await relay.fetch(`${FAKE_RELAY_ORIGIN}/api/pairings/join`, {
      method: 'POST',
      headers: { authorization: `Bearer ${phoneToken}` },
      body: JSON.stringify({ codeHash: await slotCodeHash(psk) }),
    });
  }
  const joined = { agentDeviceId: relay.agent.id };
  let ready = false;
  const socket = relay.webSocket(
    `${FAKE_RELAY_ORIGIN}/ws`,
    { authorization: `Bearer ${phoneToken}` },
    {
      onOpen: () =>
        socket.send(
          encodeFrame({
            v: VERSION_TABLE.v,
            kind: 'hello',
            protocol: { min: 1, max: 1 },
            client: { kind: 'phone', version: 'test' },
          }),
        ),
      onMessage: (text) => {
        if ((JSON.parse(text) as Frame).kind === 'hello_ok') ready = true;
      },
      onClose: () => undefined,
    },
  );
  await waitFor(() => ready);
  const garbage = new Uint8Array(49).fill(7);
  garbage[0] = HANDSHAKE_TAG.pairing;
  const random = seededRandom(99);
  socket.send(
    encodeFrame({
      v: VERSION_TABLE.v,
      kind: 'data',
      id: uuidV7({ now: () => 1 }, random),
      from: phoneId,
      to: joined.agentDeviceId,
      session: null,
      cls: 'control',
      seq: 0,
      ts: 1,
      expiresAt: null,
      payload: Buffer.from(garbage).toString('base64'),
    }),
  );
  return socket;
}

describe('runPairing (fake relay, fake phone)', () => {
  it('prints the code and the rc1: QR text, shows the fingerprint and stores the phone', async () => {
    const t = await setup();
    const phone = await createFakePhone(t.relay, 'Pixel', t.time.clock, t.random);
    await phone.connect();
    const code = await t.code();
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const psk = await pairingPsk(normalizePairingCode(code)!);
    expect(t.lines).toContain(
      `QR text:      rc1:relay.example:${t.relay.agent.id}:${toBase64Url(psk)}`,
    );
    const paired = await phone.pair(code);
    expect(paired).toMatchObject({ agentDeviceId: t.relay.agent.id, name: 'build-box' });
    expect(paired.agentPublicKey).toEqual(t.deviceKey.publicKey);
    const outcome = await t.outcome;
    const fingerprint = await pairingFingerprint(phone.keyPair.publicKey, t.deviceKey.publicKey);
    expect(outcome).toEqual({
      status: 'paired',
      peer: phone.peer(t.time.clock.now()),
      fingerprint,
    });
    expect(t.peers).toEqual([phone.peer(t.time.clock.now())]);
    expect(t.questions).toEqual([`Does the phone show ${fingerprint}?`]);
    expect(t.lines).toContain(`Phone "Pixel" wants to pair. Fingerprint: ${fingerprint}`);
    // The relay never saw the PSK or the code (I3).
    const needle = toBase64Url(psk);
    expect(
      t.relay.routed.some((envelope) =>
        Buffer.from(envelope.payload, 'base64').toString('latin1').includes(needle),
      ),
    ).toBe(false);
    expect(t.relay.online(t.relay.agent.id)).toBe(false);
    expect(t.time.active()).toBe(0);
  });

  it('declines when the user says no and cancels the slot', async () => {
    const t = await setup({}, false);
    const phone = await createFakePhone(t.relay, 'Pixel', t.time.clock, t.random);
    await phone.connect();
    await phone.pair(await t.code());
    expect(await t.outcome).toEqual({ status: 'declined' });
    expect(t.peers).toEqual([]);
  });

  it('aborts after the third failed handshake (the relay closes the slot)', async () => {
    const t = await setup();
    const phone = t.relay.addPhone('Mallory');
    const code = await t.code();
    for (let i = 1; i <= 3; i++) {
      const socket = await badAttempt(t.relay, phone.token, phone.id, code);
      if (i < 3) await waitFor(() => t.lines.includes(`Pairing handshake failed (${i} of 3).`));
      socket.close(1000, 'bye');
    }
    expect(await t.outcome).toEqual({ status: 'failed', reason: 'attempts' });
    expect(t.lines).toContain('Pairing handshake failed (3 of 3).');
    expect(t.peers).toEqual([]);
  });

  it('ignores pairing messages from a phone that did not join the slot', async () => {
    const t = await setup();
    const stranger = t.relay.addPhone('Stranger');
    const socket = await badAttempt(t.relay, stranger.token, stranger.id, await t.code(), false);
    await waitFor(() => t.relay.routed.some((envelope) => envelope.from === stranger.id));
    t.time.advance(5 * 60_000);
    expect(await t.outcome).toEqual({ status: 'failed', reason: 'expired' });
    expect(t.lines.some((line) => line.startsWith('Pairing handshake failed'))).toBe(false);
    socket.close(1000, 'bye');
  });

  it('gives up when the slot expires', async () => {
    const t = await setup();
    await t.code();
    t.time.advance(5 * 60_000);
    expect(await t.outcome).toEqual({ status: 'failed', reason: 'expired' });
  });

  it('stops on abort, before and after the slot opens', async () => {
    const early = new AbortController();
    early.abort();
    const before = await setup({ signal: early.signal });
    expect(await before.outcome).toEqual({ status: 'failed', reason: 'aborted' });

    const t = await setup();
    await t.code();
    t.controller.abort();
    expect(await t.outcome).toEqual({ status: 'failed', reason: 'aborted' });
  });

  it('aborts while waiting for hello_ok', async () => {
    const time = manualTime();
    const relay = createFakeRelay(time.clock);
    relay.silent = true;
    const controller = new AbortController();
    const t = await setup({ signal: controller.signal, webSocket: relay.webSocket });
    await waitFor(() => relay.attempts(relay.agent.id) === 1);
    controller.abort();
    expect(await t.outcome).toEqual({ status: 'failed', reason: 'aborted' });
  });

  it('reports relay refusals', async () => {
    const refusing = (error: string): RelayApi => ({
      rotateToken: () => Promise.resolve({ ok: false, status: 500, error }),
      openSlot: () => Promise.resolve({ ok: false, status: 409, error }),
      slotStatus: () => Promise.resolve({ ok: false, status: 500, error }),
      completeSlot: () => Promise.resolve({ ok: false, status: 500, error }),
      failSlot: () => Promise.resolve({ ok: false, status: 500, error }),
      cancelSlot: () => Promise.resolve({ ok: true, value: null }),
    });
    const busy = await setup({ api: refusing('code_in_use') });
    expect(await busy.outcome).toEqual({
      status: 'failed',
      reason: 'relay',
      detail: 'code_in_use',
    });
    const limited = await setup({ api: refusing('rate_limited') });
    expect(await limited.outcome).toEqual({
      status: 'failed',
      reason: 'relay',
      detail: 'rate_limited',
    });
  });

  it('reports a failed fail/complete call', async () => {
    const holder: { api?: RelayApi } = {};
    const wrap = (relay: FakeRelay, broken: 'failSlot' | 'completeSlot'): RelayApi => {
      const real = createRelayHttp({
        baseUrl: FAKE_RELAY_ORIGIN,
        token: relay.agent.token,
        fetch: relay.fetch,
      });
      return {
        ...real,
        [broken]: () => Promise.resolve({ ok: false, status: 503, error: 'unavailable' }),
      };
    };
    // completeSlot refused
    const time = manualTime();
    const relay = createFakeRelay(time.clock);
    holder.api = wrap(relay, 'completeSlot');
    const random = seededRandom(5);
    const t = await setup({
      api: holder.api,
      clock: time.clock,
      timer: time.timer,
      random,
      userId: relay.userId,
      token: relay.agent.token,
      webSocket: relay.webSocket,
    });
    const phone = await createFakePhone(relay, 'Pixel', time.clock, random);
    await phone.connect();
    await phone.pair(await t.code());
    expect(await t.outcome).toEqual({ status: 'failed', reason: 'relay', detail: 'unavailable' });

    // failSlot refused
    const time2 = manualTime();
    const relay2 = createFakeRelay(time2.clock);
    const t2 = await setup({
      api: wrap(relay2, 'failSlot'),
      clock: time2.clock,
      timer: time2.timer,
      userId: relay2.userId,
      token: relay2.agent.token,
      webSocket: relay2.webSocket,
    });
    const mallory = relay2.addPhone('Mallory');
    await badAttempt(relay2, mallory.token, mallory.id, await t2.code());
    expect(await t2.outcome).toEqual({ status: 'failed', reason: 'relay', detail: 'unavailable' });
  });
});

describe('AC: remotectl pair against the test relay produces a usable peers.json', () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'remotectl-pair-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('pairs, writes peers.json, and the phone then opens a KK session through the relay', async () => {
    const dir = join(base, 'data');
    const time = manualTime();
    const random = seededRandom(21);
    const relay = createFakeRelay(time.clock);
    const keys = createFileKeyStore({
      dir,
      fs: createNodeFileSystem(systemRandom),
      paths: nodePaths,
      random,
      clock: time.clock,
      enforcePermissions: process.platform !== 'win32',
    });
    const deviceKey = (await keys.loadOrCreateDeviceKey()).keyPair;
    const phone = await createFakePhone(relay, 'Pixel', time.clock, random);
    await phone.connect();
    const t = await setup({
      clock: time.clock,
      timer: time.timer,
      random,
      userId: relay.userId,
      deviceKey,
      token: relay.agent.token,
      webSocket: relay.webSocket,
      api: createRelayHttp({
        baseUrl: FAKE_RELAY_ORIGIN,
        token: relay.agent.token,
        fetch: relay.fetch,
      }),
      addPeer: (peer) => keys.addPeer(peer),
    });
    await phone.pair(await t.code());
    expect(await t.outcome).toMatchObject({ status: 'paired' });
    expect(await keys.listPeers()).toEqual([phone.peer(time.clock.now())]);
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, PEERS_FILE))).mode & 0o777).toBe(0o600);
    }

    // `remotectl run` with that peers.json: the phone's KK handshake is accepted.
    const store = createPendingStore({ clock: time.clock, timer: time.timer, random });
    const link = createRelayLink({
      clock: time.clock,
      random,
      timer: time.timer,
      userId: relay.userId,
      deviceKey,
      store,
      listPeers: () => keys.listPeers(),
      decide: (request, decision) => claudeCodeAdapter.decide(request, decision),
      machine: { name: 'mac', platform: 'darwin', agentVersion: '1.2.3' },
      capabilities: [CLAUDE_CODE_CAPABILITIES],
      url: 'ws://127.0.0.1:8787/ws',
      token: relay.agent.token,
      version: '1.2.3',
      webSocket: relay.webSocket,
    });
    link.start();
    await waitFor(() => link.client.ready);
    await phone.handshake(relay.agent.id, deviceKey.publicKey);
    expect(phone.of('snapshot')).toHaveLength(1);
    link.stop();
  });
});

describe('createPairingLock', () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'remotectl-lock-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  posixOnly('holds for six minutes, is written 0600 and releases', async () => {
    const time = manualTime();
    const path = join(base, 'pairing.lock');
    const lock = createPairingLock(createNodeFileSystem(systemRandom), path, time.clock);
    expect(await lock.held()).toBe(false);
    await lock.acquire();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await lock.held()).toBe(true);
    time.advance(PAIRING_LOCK_MS);
    expect(await lock.held()).toBe(false);
    await lock.acquire();
    await lock.release();
    expect(await lock.held()).toBe(false);
  });

  it('treats an unreadable lock as not held', async () => {
    const fs = createNodeFileSystem(systemRandom);
    const path = join(base, 'pairing.lock');
    const lock = createPairingLock(fs, path, manualTime().clock);
    await fs.writeTextAtomic(path, 'not json', 0o600);
    expect(await lock.held()).toBe(false);
    await fs.writeTextAtomic(path, '{"until":"later"}', 0o600);
    expect(await lock.held()).toBe(false);
  });
});
