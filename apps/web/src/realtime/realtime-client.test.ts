import { generateX25519KeyPair, webCryptoRandom } from '@remote-control/crypto';
import { DECISION_TTL_SECONDS, VERSION_TABLE } from '@remote-control/protocol';
import type {
  ApprovalRequest,
  CanonicalDecision,
  Machine,
  Question,
} from '@remote-control/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { RelayState } from '../auth/relay-api.js';
import type { PairedMachine } from '../pairing/key-store.js';
import { createManualTimer } from '../test-timer.js';
import { fromBase64 } from './envelope.js';
import { fakeSockets } from './fake-socket.js';
import type { FakeSocket } from './fake-socket.js';
import {
  bindLifecycle,
  createRealtimeClient,
  PAIRING_TIMEOUT_MS,
  POLL_INTERVAL_MS,
} from './realtime-client.js';
import { BACKOFF_MIN_MS } from './relay-socket.js';
import { createRealtimeStore, pendingRequests } from './realtime-store.js';
import { createTestAgent } from './test-agent.js';

const USER = '0d6f8a52-3c5e-4f0b-9a4e-000000000000';
const PHONE = '0d6f8a52-3c5e-4f0b-9a4e-111111111111';
const AGENT = '0d6f8a52-3c5e-4f0b-9a4e-222222222222';
const OTHER = '0d6f8a52-3c5e-4f0b-9a4e-333333333333';
const RID = '7a1b2c3d-4e5f-4a6b-8c7d-000000000001';
const RID2 = '7a1b2c3d-4e5f-4a6b-8c7d-000000000002';
const HASH = 'a'.repeat(64);

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function approval(id: string): ApprovalRequest {
  return {
    id,
    sessionId: '5e5e5e5e-0000-4000-8000-000000000001',
    requestHash: HASH,
    toolLabel: 'Run a command',
    toolName: 'Bash',
    content: 'pnpm test',
    truncated: false,
    suggestions: [],
    expiresAt: Date.UTC(2026, 9, 1, 0, 5),
    alwaysSupported: true,
  };
}

const MACHINE: Machine = {
  id: AGENT,
  name: 'Studio Mac',
  platform: 'darwin',
  agentVersion: '0.1.0',
  agents: [],
};

async function setup(options: { visible?: () => boolean; state?: () => Promise<RelayState> } = {}) {
  const timer = createManualTimer();
  const sockets = fakeSockets();
  const store = createRealtimeStore();
  const keyPair = await generateX25519KeyPair(webCryptoRandom);
  const errors: unknown[] = [];
  const agent = await createTestAgent({
    deviceId: AGENT,
    userId: USER,
    phoneDeviceId: PHONE,
    phonePublicKey: () => keyPair.publicKey,
    now: () => timer.now(),
  });
  let paired: PairedMachine[] = [
    { deviceId: AGENT, name: 'Mac', publicKey: agent.keyPair.publicKey, pairedAt: 1 },
  ];
  const state = vi.fn(
    options.state ??
      (() =>
        Promise.resolve<RelayState>({
          relayTs: timer.now() + 1_000,
          cursor: 1,
          devices: [
            {
              deviceId: AGENT,
              kind: 'agent',
              name: 'Mac',
              online: true,
              lastSeen: 42,
              revoked: false,
            },
            {
              deviceId: OTHER,
              kind: 'agent',
              name: 'x',
              online: true,
              lastSeen: null,
              revoked: false,
            },
          ],
        })),
  );
  const client = createRealtimeClient({
    url: 'wss://rc.example.test/ws',
    createSocket: sockets.create,
    timer,
    random: webCryptoRandom,
    version: '0.0.0-test',
    relay: { state },
    keyStore: { machines: () => Promise.resolve(paired) },
    identity: { userId: USER, deviceId: PHONE, keyPair },
    store,
    ...(options.visible === undefined ? {} : { isVisible: options.visible }),
    onError: (error) => errors.push(error),
  });
  /** Opens the socket with the agent online and completes KK. */
  const connect = async (socket?: FakeSocket): Promise<FakeSocket> => {
    const current = socket ?? sockets.last;
    current.open();
    current.helloOk(PHONE, timer.now() + 500, [
      { deviceId: AGENT, kind: 'agent', name: 'Mac', online: true, lastSeen: timer.now() },
    ]);
    await settle();
    await agent.acceptKk(current);
    await settle();
    return current;
  };
  return {
    timer,
    sockets,
    store,
    agent,
    client,
    errors,
    state,
    connect,
    setPaired: (machines: PairedMachine[]) => {
      paired = machines;
    },
  };
}

function decision(timerNow: number, kind: CanonicalDecision['kind'] = 'allow'): CanonicalDecision {
  const issuedAt = Math.floor(timerNow / 1000);
  return {
    v: VERSION_TABLE.v,
    kind,
    request_id: RID,
    request_hash: HASH,
    payload: null,
    issued_at: issuedAt,
    expires_at: issuedAt + DECISION_TTL_SECONDS,
    phone_device_id: PHONE,
    agent_device_id: AGENT,
  };
}

describe('realtime client', () => {
  it('opens a KK session per machine and decrypts agent messages into the store', async () => {
    const t = await setup();
    await t.client.start();
    expect(t.store.getState().machines[AGENT]).toMatchObject({ name: 'Mac', session: 'none' });
    const socket = t.sockets.last;
    socket.open();
    socket.helloOk(PHONE, t.timer.now() + 500, [
      { deviceId: AGENT, kind: 'agent', name: 'Mac', online: true, lastSeen: 7 },
      { deviceId: OTHER, kind: 'agent', name: 'Unpaired', online: true, lastSeen: 1 },
    ]);
    await settle();
    expect(t.store.getState()).toMatchObject({
      connection: 'open',
      relayOffset: 500,
      confirmedAt: t.timer.now() + 500,
    });
    expect(t.store.getState().machines[AGENT]).toMatchObject({
      online: true,
      lastSeen: 7,
      session: 'handshaking',
    });
    // One KK message, to the paired machine only.
    expect(socket.of('data').map((frame) => frame.to)).toEqual([AGENT]);

    await t.agent.acceptKk(socket);
    await settle();
    expect(t.store.getState().machines[AGENT]?.session).toBe('open');

    await t.agent.send(socket, { t: 'request', request: approval(RID), ttlMs: 60_000 }, 'request');
    await t.agent.send(socket, { t: 'snapshot', machine: MACHINE, sessions: [], pending: [RID] });
    await settle();
    const state = t.store.getState();
    expect(state.machines[AGENT]).toMatchObject({ name: 'Studio Mac', machine: MACHINE });
    expect(pendingRequests(state)).toEqual([
      {
        machineId: AGENT,
        request: approval(RID),
        deadline: t.timer.now() + 60_000,
        status: 'pending',
      },
    ]);
    // Every data frame from the agent is acked: msg2, request, snapshot.
    expect(socket.of('ack').flatMap((ack) => ack.ids)).toHaveLength(3);
    expect(t.errors).toEqual([]);
  });

  it('applies snapshots, resolutions, expiries and decision results', async () => {
    const t = await setup();
    await t.client.start();
    const socket = await t.connect();
    await t.agent.send(socket, { t: 'request', request: approval(RID), ttlMs: 60_000 });
    await t.agent.send(socket, { t: 'request', request: approval(RID2), ttlMs: 60_000 });
    await t.agent.send(socket, { t: 'snapshot', machine: MACHINE, sessions: [], pending: [RID2] });
    await settle();
    expect(Object.keys(t.store.getState().requests)).toEqual([RID2]);

    await t.agent.send(socket, { t: 'decision_result', requestId: RID2, result: 'accepted' });
    await t.agent.send(socket, { t: 'resolved', requestId: RID2, outcome: 'allow' });
    await settle();
    expect(t.store.getState().requests[RID2]).toMatchObject({
      status: 'resolved',
      outcome: 'allow',
      result: { result: 'accepted' },
    });

    await t.agent.send(socket, { t: 'request', request: approval(RID), ttlMs: 1_000 });
    await t.agent.send(socket, { t: 'expired', requestId: RID });
    // Updates for a request the phone never saw change nothing.
    await t.agent.send(socket, { t: 'expired', requestId: '7a1b2c3d-4e5f-4a6b-8c7d-0000000000ff' });
    await settle();
    expect(t.store.getState().requests[RID]?.status).toBe('expired');
    expect(Object.keys(t.store.getState().requests)).toHaveLength(2);
  });

  it('stores a question as a question view and resolves it as answered (M1-01)', async () => {
    const t = await setup();
    await t.client.start();
    const socket = await t.connect();
    const question: Question = {
      id: RID,
      sessionId: '5e5e5e5e-0000-4000-8000-000000000001',
      requestHash: HASH,
      expiresAt: 0,
      questions: [{ text: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multi: false }],
    };
    await t.agent.send(socket, { t: 'question', question, ttlMs: 30_000 });
    await settle();
    expect(t.store.getState().requests[RID]).toEqual({
      machineId: AGENT,
      kind: 'question',
      request: question,
      deadline: t.timer.now() + 30_000,
      status: 'pending',
    });
    await t.agent.send(socket, { t: 'resolved', requestId: RID, outcome: 'answer' });
    await settle();
    expect(t.store.getState().requests[RID]).toMatchObject({
      kind: 'question',
      status: 'resolved',
      outcome: 'answer',
    });
  });

  it('ignores doorbells, unknown senders and frames outside a session', async () => {
    const t = await setup();
    await t.client.start();
    const socket = t.sockets.last;
    socket.open();
    socket.helloOk(PHONE, t.timer.now(), []);
    await settle();
    socket.receive(t.agent.envelope('request', new Uint8Array(0)));
    // Ciphertext before any session, a KK reply nobody asked for, an unknown tag.
    socket.receive(t.agent.envelope('event', new Uint8Array([1, 2, 3])));
    socket.receive(t.agent.envelope('control', new Uint8Array([0x01, 9, 9])));
    socket.receive(t.agent.envelope('control', new Uint8Array([0x02, 9, 9])));
    socket.receive(t.agent.envelope('control', new Uint8Array([0x7f])));
    socket.receive({ ...t.agent.envelope('event', new Uint8Array([1])), from: OTHER });
    socket.receive({ v: 1, kind: 'presence', deviceId: OTHER, online: true, at: t.timer.now() });
    await settle();
    expect(t.store.getState().requests).toEqual({});
    expect(t.store.getState().machines[AGENT]?.session).toBe('none');
    expect(t.errors).toEqual([]);
  });

  it('re-handshakes after a frame fails to decrypt', async () => {
    const t = await setup();
    await t.client.start();
    const socket = await t.connect();
    const kkBefore = socket.of('data').length;
    socket.receive(t.agent.envelope('event', new Uint8Array(64)));
    await settle();
    expect(t.errors).toHaveLength(1);
    expect(t.store.getState().machines[AGENT]?.session).toBe('handshaking');
    expect(socket.of('data').length).toBe(kkBefore + 1);
  });

  it('follows agent presence: offline drops the session, online runs KK again', async () => {
    const t = await setup();
    await t.client.start();
    const socket = await t.connect();
    const at = t.timer.now() + 900;
    socket.receive({ v: 1, kind: 'presence', deviceId: AGENT, online: false, at });
    await settle();
    expect(t.store.getState().machines[AGENT]).toMatchObject({
      online: false,
      lastSeen: at,
      session: 'none',
    });
    expect(t.store.getState().confirmedAt).toBe(at);

    socket.receive({ v: 1, kind: 'presence', deviceId: AGENT, online: true, at: at + 1 });
    await settle();
    expect(t.store.getState().machines[AGENT]?.session).toBe('handshaking');
    await t.agent.acceptKk(socket);
    await settle();
    expect(t.store.getState().machines[AGENT]?.session).toBe('open');
  });

  it('records the relay offset from pongs', async () => {
    const t = await setup();
    await t.client.start();
    const socket = await t.connect();
    socket.receive({ v: 1, kind: 'pong', t: t.timer.now(), relayTs: t.timer.now() - 2_000 });
    await settle();
    expect(t.store.getState()).toMatchObject({
      relayOffset: -2_000,
      confirmedAt: t.timer.now() - 2_000,
    });
  });

  describe('decisions', () => {
    it('queues until the session opens, then sends with the decision hash', async () => {
      const t = await setup();
      await t.client.start();
      const made = decision(t.timer.now());
      t.client.decide(AGENT, made, HASH);
      await settle();
      const socket = await t.connect();
      const commands = socket.of('data').filter((frame) => frame.cls === 'command');
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ to: AGENT, from: PHONE, decisionHash: HASH });
      await expect(t.agent.read(commands[0]!)).resolves.toEqual({ t: 'decision', decision: made });
    });

    it('re-sends an unacked decision on the next session with a new envelope', async () => {
      const t = await setup();
      await t.client.start();
      const first = await t.connect();
      t.client.decide(AGENT, decision(t.timer.now(), 'deny'));
      await settle();
      const sent = first.of('data').filter((frame) => frame.cls === 'command');
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toHaveProperty('decisionHash');

      first.onclose?.({});
      expect(t.store.getState().machines[AGENT]?.session).toBe('none');
      t.timer.advance(BACKOFF_MIN_MS);
      const second = await t.connect(t.sockets.last);
      const resent = second.of('data').filter((frame) => frame.cls === 'command');
      expect(resent).toHaveLength(1);
      expect(resent[0]?.id).not.toBe(sent[0]?.id);
      await expect(t.agent.read(resent[0]!)).resolves.toMatchObject({ decision: { kind: 'deny' } });

      // The agent's ack retires it: a third session sends nothing.
      second.receive({ v: 1, kind: 'ack', ids: [resent[0]!.id] });
      await settle();
      second.onclose?.({});
      t.timer.advance(BACKOFF_MIN_MS);
      const third = await t.connect(t.sockets.last);
      expect(third.of('data').filter((frame) => frame.cls === 'command')).toEqual([]);
    });

    it('drops decisions that expired, were answered, or the relay refused', async () => {
      const t = await setup();
      await t.client.start();
      const socket = await t.connect();
      await t.agent.send(socket, { t: 'request', request: approval(RID), ttlMs: 60_000 });
      await settle();

      t.client.decide(AGENT, decision(t.timer.now()), HASH);
      await settle();
      const [command] = socket.of('data').filter((frame) => frame.cls === 'command');
      socket.receive({ v: 1, kind: 'ack', ids: ['01a0f4c2-c400-7fff-bfff-ffffffffffff'] });
      socket.receive({ v: 1, kind: 'error', code: 'unverified', ref: command!.id, message: 'no' });
      await settle();
      expect(t.store.getState().requests[RID]?.relayError).toBe('unverified');

      // An answered decision is not re-sent.
      t.client.decide(AGENT, decision(t.timer.now()), HASH);
      await settle();
      await t.agent.send(socket, {
        t: 'decision_result',
        requestId: RID,
        result: 'rejected',
        reason: 'too_late',
      });
      await settle();
      socket.onclose?.({});
      t.timer.advance(BACKOFF_MIN_MS);
      let next = await t.connect(t.sockets.last);
      expect(next.of('data').filter((frame) => frame.cls === 'command')).toEqual([]);

      // One past its `expires_at` is dropped instead of sent.
      t.client.decide(AGENT, decision(t.timer.now() - (DECISION_TTL_SECONDS + 1) * 1000));
      await settle();
      next.onclose?.({});
      t.timer.advance(BACKOFF_MIN_MS);
      next = await t.connect(t.sockets.last);
      expect(next.of('data').filter((frame) => frame.cls === 'command')).toEqual([]);
    });

    it('drops a decision when the agent resolves or expires its request', async () => {
      const t = await setup();
      await t.client.start();
      t.client.decide(AGENT, decision(t.timer.now()), HASH);
      t.client.decide(AGENT, { ...decision(t.timer.now()), request_id: RID2 }, HASH);
      // Another machine's queue is untouched by this machine's session.
      t.client.decide(OTHER, {
        ...decision(t.timer.now()),
        request_id: '7a1b2c3d-4e5f-4a6b-8c7d-0000000000ff',
      });
      const socket = t.sockets.last;
      socket.open();
      socket.helloOk(PHONE, t.timer.now(), [
        { deviceId: AGENT, kind: 'agent', name: 'Mac', online: true, lastSeen: 1 },
      ]);
      await settle();
      // Messages ahead of the flush cannot exist: msg2 flushes. So retire them first.
      await t.agent.acceptKk(socket);
      await settle();
      await t.agent.send(socket, { t: 'resolved', requestId: RID, outcome: 'withdrawn' });
      await t.agent.send(socket, { t: 'expired', requestId: RID2 });
      await settle();
      expect(socket.of('data').filter((frame) => frame.cls === 'command')).toHaveLength(2);
      socket.onclose?.({});
      t.timer.advance(BACKOFF_MIN_MS);
      const next = await t.connect(t.sockets.last);
      expect(next.of('data').filter((frame) => frame.cls === 'command')).toEqual([]);
    });
  });

  describe('polling', () => {
    it('polls /api/state every 15 s after two failed attempts, while visible', async () => {
      let visible = true;
      const t = await setup({ visible: () => visible });
      await t.client.start();
      t.sockets.last.onerror?.({});
      expect(t.store.getState()).toMatchObject({ failures: 1, polling: false });
      t.timer.advance(BACKOFF_MIN_MS);
      t.sockets.last.onclose?.({});
      expect(t.store.getState()).toMatchObject({ failures: 2, polling: true });
      await settle();
      expect(t.state).toHaveBeenCalledTimes(1);
      expect(t.store.getState()).toMatchObject({
        relayOffset: 1_000,
        confirmedAt: t.timer.now() + 1_000,
      });
      expect(t.store.getState().machines[AGENT]).toMatchObject({ online: true, lastSeen: 42 });
      expect(t.store.getState().machines[OTHER]).toBeUndefined();

      visible = false;
      t.timer.advance(POLL_INTERVAL_MS);
      await settle();
      expect(t.state).toHaveBeenCalledTimes(1);
      visible = true;
      t.timer.advance(POLL_INTERVAL_MS);
      await settle();
      expect(t.state).toHaveBeenCalledTimes(2);

      // wake polls at once; a socket that opens ends polling.
      t.client.wake();
      await settle();
      expect(t.state).toHaveBeenCalledTimes(3);
      const socket = t.sockets.last;
      socket.open();
      socket.helloOk(PHONE, t.timer.now(), []);
      await settle();
      expect(t.store.getState().polling).toBe(false);
      t.timer.advance(POLL_INTERVAL_MS);
      await settle();
      expect(t.state).toHaveBeenCalledTimes(3);
    });

    it('keeps polling through relay errors and keeps a known last-seen', async () => {
      let fail = true;
      const t = await setup({
        state: () =>
          fail
            ? Promise.reject(new Error('offline'))
            : Promise.resolve({
                relayTs: 5,
                cursor: 1,
                devices: [
                  {
                    deviceId: AGENT,
                    kind: 'agent',
                    name: 'Mac',
                    online: false,
                    lastSeen: null,
                    revoked: false,
                  },
                ],
              }),
      });
      await t.client.start();
      t.store.setState((state) => ({
        machines: { ...state.machines, [AGENT]: { ...state.machines[AGENT]!, lastSeen: 3 } },
      }));
      t.sockets.last.onclose?.({});
      t.timer.advance(BACKOFF_MIN_MS);
      t.sockets.last.onclose?.({});
      await settle();
      expect(t.errors).toEqual([new Error('offline')]);
      fail = false;
      t.timer.advance(POLL_INTERVAL_MS);
      await settle();
      expect(t.store.getState().machines[AGENT]).toMatchObject({ online: false, lastSeen: 3 });
      t.client.stop();
      expect(t.store.getState()).toMatchObject({ polling: false, connection: 'stopped' });
    });
  });

  describe('pairing', () => {
    it('runs the XXpsk0 initiator and returns the agent key and name', async () => {
      const t = await setup();
      t.setPaired([]);
      await t.client.start();
      const socket = t.sockets.last;
      socket.open();
      socket.helloOk(PHONE, t.timer.now(), []);
      await settle();
      const psk = webCryptoRandom.bytes(32);
      const result = t.client.pair(AGENT, psk, 'Pixel');
      await settle();
      const [phoneSide, agentSide] = await Promise.all([
        result,
        t.agent.acceptPairing(socket, psk, 'Studio Mac'),
      ]);
      expect(agentSide).toEqual({ name: 'Pixel' });
      expect(phoneSide.name).toBe('Studio Mac');
      expect(phoneSide.publicKey).toEqual(t.agent.keyPair.publicKey);
      expect(phoneSide.handshakeHash).toHaveLength(32);

      // Saving the pairing and reloading opens a session with the new machine at once.
      t.setPaired([
        { deviceId: AGENT, name: 'Studio Mac', publicKey: phoneSide.publicKey, pairedAt: 2 },
      ]);
      await t.client.reloadMachines();
      await settle();
      expect(t.store.getState().machines[AGENT]?.session).toBe('handshaking');
      await t.agent.acceptKk(socket);
      await settle();
      expect(t.store.getState().machines[AGENT]?.session).toBe('open');
    });

    it('fails without a socket, when replaced, on timeout or a wrong code, and on stop', async () => {
      const t = await setup();
      t.setPaired([]);
      await t.client.start();
      const psk = webCryptoRandom.bytes(32);
      await expect(t.client.pair(AGENT, psk, 'Pixel')).rejects.toThrow('Not connected');
      const socket = t.sockets.last;
      socket.open();
      socket.helloOk(PHONE, t.timer.now(), []);
      await settle();

      const replaced = t.client.pair(AGENT, psk, 'Pixel');
      await settle();
      const timedOut = t.client.pair(AGENT, psk, 'Pixel');
      await expect(replaced).rejects.toThrow('replaced');
      await settle();
      // A wrong code fails on the agent, which then never answers.
      await expect(
        t.agent.acceptPairing(socket, webCryptoRandom.bytes(32), 'Mac'),
      ).rejects.toThrow();
      t.timer.advance(PAIRING_TIMEOUT_MS);
      await expect(timedOut).rejects.toThrow('did not answer');

      // The unanswered heartbeat dropped the socket meanwhile; wake reconnects.
      t.client.wake();
      t.sockets.last.open();
      t.sockets.last.helloOk(PHONE, t.timer.now(), []);
      await settle();
      const stopped = t.client.pair(AGENT, psk, 'Pixel');
      await settle();
      t.client.stop();
      await expect(stopped).rejects.toThrow('stopped');
      // A late timer for a finished pairing does nothing.
      t.timer.advance(PAIRING_TIMEOUT_MS);
    });

    it('fails when the reply cannot go out', async () => {
      const t = await setup();
      t.setPaired([]);
      await t.client.start();
      const socket = t.sockets.last;
      socket.open();
      socket.helloOk(PHONE, t.timer.now(), []);
      await settle();
      const psk = webCryptoRandom.bytes(32);
      const result = t.client.pair(AGENT, psk, 'Pixel');
      await settle();
      // msg2 arrives, then the socket refuses msg3.
      const send = socket.send.bind(socket);
      vi.spyOn(socket, 'send').mockImplementation((data) => {
        if (data.includes('"cls":"control"')) throw new Error('closed');
        send(data);
      });
      const agentSide = t.agent.acceptPairing(socket, psk, 'Mac').catch(() => undefined);
      await expect(result).rejects.toThrow('closed');
      await agentSide;
    });
  });

  it('forgets a machine that is no longer paired, with its requests', async () => {
    const t = await setup();
    await t.client.start();
    const socket = await t.connect();
    await t.agent.send(socket, { t: 'request', request: approval(RID), ttlMs: 60_000 });
    await settle();
    t.setPaired([]);
    await t.client.reloadMachines();
    expect(t.store.getState().machines).toEqual({});
    expect(t.store.getState().requests).toEqual({});
    // Its frames are ignored from now on.
    await t.agent.send(socket, { t: 'request', request: approval(RID2), ttlMs: 60_000 });
    await settle();
    expect(t.store.getState().requests).toEqual({});
  });

  it('starts once and decodes base64 payloads it sent', async () => {
    const t = await setup();
    await t.client.start();
    await t.client.start();
    expect(t.sockets.all).toHaveLength(1);
    const socket = t.sockets.last;
    socket.open();
    socket.helloOk(PHONE, t.timer.now(), [
      { deviceId: AGENT, kind: 'agent', name: 'Mac', online: true, lastSeen: 1 },
    ]);
    await settle();
    const [kk] = socket.of('data');
    expect(fromBase64(kk!.payload)[0]).toBe(0x01);
  });
});

describe('bindLifecycle', () => {
  it('wakes on visible, pageshow and online, and unbinds', () => {
    const wake = vi.fn();
    const doc = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
    doc.visibilityState = 'hidden';
    const win = new EventTarget();
    const unbind = bindLifecycle({ wake }, { document: doc, window: win });
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(wake).not.toHaveBeenCalled();
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('pageshow'));
    win.dispatchEvent(new Event('online'));
    expect(wake).toHaveBeenCalledTimes(3);
    unbind();
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('online'));
    expect(wake).toHaveBeenCalledTimes(3);
  });
});
