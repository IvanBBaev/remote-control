import {
  deriveNotificationKey,
  generateX25519KeyPair,
  openPushSummary,
} from '@remote-control/crypto';
import { seededRandom } from '@remote-control/fake-claude-code';
import {
  decodePushSummary,
  encodeAnswerPayload,
  type ApprovalRequest,
  type Envelope,
  type Question,
} from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE_CAPABILITIES, claudeCodeAdapter } from '../adapters/claude-code/adapter.js';
import { decideClaudeCode } from '../adapters/claude-code/decide.js';
import type { Peer } from '../ports/key-store.js';
import { createFakePhone, type FakePhone } from '../testing/fake-phone.js';
import { createFakeRelay } from '../testing/fake-relay.js';
import { manualTime, waitFor } from '../testing/manual-time.js';
import { createPendingStore, type RegisterInput } from './pending-store.js';
import { createRelayLink, type RelayLink } from './relay-link.js';

const HOOK_TIMEOUT_MS = 600_000;

function permission(command = 'npm test', overrides: Partial<RegisterInput> = {}): RegisterInput {
  return {
    sessionId: 's1',
    kind: 'permission',
    fingerprint: `Bash\0${command}`,
    payload: {
      hook_event_name: 'PermissionRequest',
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command },
    },
    hookTimeoutMs: HOOK_TIMEOUT_MS,
    ...overrides,
  };
}

const QUESTION_INPUT = {
  questions: [
    {
      question: 'Which CANARY-q1 framework?',
      header: 'Framework',
      options: [
        { label: 'React', description: 'Component library' },
        { label: 'Vue', description: 'Progressive framework' },
      ],
      multiSelect: false,
    },
  ],
};

function askUserQuestion(): RegisterInput {
  return {
    sessionId: 's1',
    kind: 'question',
    fingerprint: `AskUserQuestion\0${JSON.stringify(QUESTION_INPUT)}`,
    payload: {
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      cwd: '/Users/me/remote-control',
      tool_name: 'AskUserQuestion',
      tool_input: QUESTION_INPUT,
    },
    hookTimeoutMs: HOOK_TIMEOUT_MS,
  };
}

async function setup(names: readonly string[] = ['Pixel'], seed = 11) {
  const time = manualTime();
  const random = seededRandom(seed);
  const relay = createFakeRelay(time.clock);
  const deviceKey = await generateX25519KeyPair(random);
  const logs: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const phones: FakePhone[] = [];
  for (const name of names) phones.push(await createFakePhone(relay, name, time.clock, random));
  let peers: readonly Peer[] = phones.map((phone) => phone.peer(1));
  const ref: { link?: RelayLink } = {};
  const store = createPendingStore({
    clock: time.clock,
    timer: time.timer,
    random,
    onEvent: (event) => ref.link?.hub.pendingEvent(event),
  });
  const link = (ref.link = createRelayLink({
    clock: time.clock,
    random,
    timer: time.timer,
    userId: relay.userId,
    deviceKey,
    store,
    listPeers: () => Promise.resolve(peers),
    decide: (request, decision) => claudeCodeAdapter.decide(request, decision),
    machine: { name: 'mac', platform: 'darwin', agentVersion: '1.2.3' },
    capabilities: [CLAUDE_CODE_CAPABILITIES],
    url: 'ws://127.0.0.1:8787/ws',
    token: relay.agent.token,
    version: '1.2.3',
    webSocket: relay.webSocket,
    log: (event, fields) => logs.push({ event, fields }),
  }));
  const started = link;
  started.start();
  await waitFor(() => started.client.ready);
  await started.hub.idle();
  const agentId = relay.agent.id;

  async function open(phone: FakePhone): Promise<void> {
    await phone.connect();
    await phone.handshake(agentId, deviceKey.publicKey);
    await started.hub.idle();
  }

  /** Waits until `phone` holds a request message for `id`; returns the latest one. */
  async function requestOn(phone: FakePhone, id: string): Promise<ApprovalRequest> {
    await waitFor(() => phone.of('request').some((m) => m.request.id === id));
    return phone
      .of('request')
      .filter((m) => m.request.id === id)
      .at(-1)!.request;
  }

  /** Waits until `phone` holds a question message for `id`; returns the latest one. */
  async function questionOn(phone: FakePhone, id: string): Promise<Question> {
    await waitFor(() => phone.of('question').some((m) => m.question.id === id));
    return phone
      .of('question')
      .filter((m) => m.question.id === id)
      .at(-1)!.question;
  }

  async function resultOn(phone: FakePhone, count = 1) {
    await waitFor(() => phone.of('decision_result').length >= count);
    return phone.of('decision_result')[count - 1]!;
  }

  return {
    time,
    random,
    relay,
    store,
    link: started,
    phones,
    logs,
    agentId,
    deviceKey,
    open,
    requestOn,
    questionOn,
    resultOn,
    setPeers: (list: readonly Peer[]) => (peers = list),
  };
}

function plaintextLeaks(routed: readonly Envelope[], needle: string): boolean {
  return routed.some((envelope) =>
    [envelope.payload, envelope.pushBlob ?? ''].some((field) =>
      Buffer.from(field, 'base64').toString('latin1').includes(needle),
    ),
  );
}

/** Opens an envelope's push summary as `phone` would (D5). */
async function pushSummaryOf(phone: FakePhone, agentPublicKey: Uint8Array, envelope: Envelope) {
  const opened = await deriveNotificationKey(phone.keyPair.privateKey, agentPublicKey, [
    'decrypt',
  ]).then((key) => openPushSummary(key, envelope.id, Buffer.from(envelope.pushBlob!, 'base64')));
  return decodePushSummary(new TextDecoder().decode(opened));
}

describe('relay link (fake relay, fake phones)', () => {
  it('sends hello with the package and protocol version and becomes ready', async () => {
    const t = await setup();
    expect(t.relay.online(t.agentId)).toBe(true);
    expect(t.logs).toContainEqual({
      event: 'relay_ready',
      fields: { device_id: t.agentId, protocol: 1 },
    });
  });

  it('hands a new phone session the pending set and a snapshot', async () => {
    const t = await setup();
    const registration = t.store.register(permission());
    const [phone] = t.phones as [FakePhone];
    await t.open(phone);
    const request = await t.requestOn(phone, registration.request.id);
    expect(request).toMatchObject({
      toolName: 'Bash',
      content: 'npm test',
      expiresAt: registration.request.deadline,
    });
    const snapshot = phone.of('snapshot')[0]!;
    expect(snapshot.machine).toMatchObject({ id: t.agentId, name: 'mac', platform: 'darwin' });
    expect(snapshot.pending).toEqual([registration.request.id]);
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({ id: 's1', state: 'waiting', machineId: t.agentId }),
    ]);
    expect(t.link.hub.sessions()).toEqual([phone.device.id]);
  });

  it('AC: a pending request survives a reconnect and is re-sent', async () => {
    const t = await setup();
    const [phone] = t.phones as [FakePhone];
    await t.open(phone);
    const registration = t.store.register(permission());
    const first = phone.messages.length;
    await t.requestOn(phone, registration.request.id);
    const ttlBefore = phone.of('request').at(-1)!.ttlMs;

    t.relay.disconnect(t.agentId, 1012);
    await waitFor(() => !t.link.client.ready);
    expect(t.link.hub.sessions()).toEqual([]);
    // The agent stays up and reconnects after the jittered backoff (≤ 1 s on the first try).
    t.time.advance(1_000);
    await waitFor(() => t.link.client.ready);
    expect(t.relay.attempts(t.agentId)).toBe(2);

    await phone.handshake(t.agentId, t.deviceKey.publicKey);
    await t.link.hub.idle();
    const resent = phone.messages.slice(first + 1).filter((r) => r.message.t === 'request');
    expect(resent).toHaveLength(1);
    expect(resent[0]!.envelope.cls).toBe('event');
    const ttlAfter = phone.of('request').at(-1)!.ttlMs;
    expect(ttlAfter).toBe(ttlBefore - 1_000);

    // The re-sent request is still decidable.
    await phone.decide('allow', phone.of('request').at(-1)!.request);
    expect(await t.resultOn(phone)).toMatchObject({ result: 'accepted' });
    await expect(registration.settled).resolves.toEqual({
      type: 'decided',
      response: claudeCodeAdapter.decide(registration.request, { behavior: 'allow' }),
    });
  });

  it('re-sends a request registered while the relay link was down', async () => {
    const t = await setup();
    const [phone] = t.phones as [FakePhone];
    await t.open(phone);
    t.relay.disconnect(t.agentId);
    await waitFor(() => !t.link.client.ready);
    const registration = t.store.register(permission());
    t.time.advance(1_000);
    await waitFor(() => t.link.client.ready);
    await phone.handshake(t.agentId, t.deviceKey.publicKey);
    expect((await t.requestOn(phone, registration.request.id)).id).toBe(registration.request.id);
  });

  it('AC: a late decision is rejected and the deadline follows the onExpire path', async () => {
    const t = await setup();
    const [phone] = t.phones as [FakePhone];
    await t.open(phone);
    const registration = t.store.register(permission('rm -rf build', { hookTimeoutMs: 60_000 }));
    const request = await t.requestOn(phone, registration.request.id);

    // The store's deadline is T − 10 s: the request expires before the hook does.
    t.time.advance(50_000);
    await expect(registration.settled).resolves.toEqual({ type: 'handoff', reason: 'deadline' });
    await waitFor(() => phone.of('expired').length === 1);
    expect(phone.of('expired')[0]).toEqual({ t: 'expired', requestId: request.id });

    await phone.decide('allow', request);
    expect(await t.resultOn(phone)).toEqual({
      t: 'decision_result',
      requestId: request.id,
      result: 'rejected',
      reason: 'already_resolved',
    });
  });

  it('rejects a decision past its own expiry', async () => {
    const t = await setup();
    const [phone] = t.phones as [FakePhone];
    await t.open(phone);
    const registration = t.store.register(permission());
    const request = await t.requestOn(phone, registration.request.id);
    const issued = Math.floor(t.time.clock.now() / 1000) - 400;
    await phone.decide('deny', request, {
      decision: { issued_at: issued, expires_at: issued + 300 },
    });
    expect(await t.resultOn(phone)).toMatchObject({ result: 'rejected', reason: 'expired' });
    expect(t.store.get(request.id)).toBeDefined();
  });

  it('AC: a decision with a wrong hash is rejected', async () => {
    const t = await setup();
    const [phone] = t.phones as [FakePhone];
    await t.open(phone);
    const registration = t.store.register(permission());
    const request = await t.requestOn(phone, registration.request.id);

    await phone.decide('allow', request, { decision: { request_hash: 'b'.repeat(64) } });
    expect(await t.resultOn(phone)).toEqual({
      t: 'decision_result',
      requestId: request.id,
      result: 'rejected',
      reason: 'hash_mismatch',
    });
    expect(t.store.get(request.id)).toBe(registration.request);

    // The right hash still decides it: nothing was consumed by the rejected attempt.
    await phone.decide('deny', request);
    expect(await t.resultOn(phone, 2)).toMatchObject({ result: 'accepted' });
    await expect(registration.settled).resolves.toMatchObject({ type: 'decided' });
  });

  it('rejects a command whose envelope hash is not the decision hash (unverified)', async () => {
    const t = await setup();
    const [phone] = t.phones as [FakePhone];
    await t.open(phone);
    const registration = t.store.register(permission());
    const request = await t.requestOn(phone, registration.request.id);
    const forged = 'c'.repeat(64);
    t.relay.verified.add(forged);
    await phone.decide('allow', request, { envelopeHash: forged });
    expect(await t.resultOn(phone)).toMatchObject({ result: 'rejected', reason: 'unverified' });
    expect(t.store.get(request.id)).toBeDefined();
  });

  it('answers instruct and start with unsupported until M1-04', async () => {
    const t = await setup();
    const [phone] = t.phones as [FakePhone];
    await t.open(phone);
    const registration = t.store.register(permission());
    const request = await t.requestOn(phone, registration.request.id);
    await phone.decide('instruct', request, { decision: { payload: 'run the tests' } });
    await phone.decide('start', request, { decision: { payload: 'repo-1' } });
    expect(await t.resultOn(phone)).toMatchObject({ result: 'rejected', reason: 'unsupported' });
    expect(await t.resultOn(phone, 2)).toMatchObject({ result: 'rejected', reason: 'unsupported' });
    expect(t.store.get(request.id)).toBeDefined();
  });

  it('AC: two phones — the first decision wins and the second phone gets resolved', async () => {
    const t = await setup(['Pixel', 'iPhone']);
    const [first, second] = t.phones as [FakePhone, FakePhone];
    await t.open(first);
    await t.open(second);
    const registration = t.store.register(permission());
    const request = await t.requestOn(first, registration.request.id);
    await t.requestOn(second, registration.request.id);

    await first.decide('allow', request);
    expect(await t.resultOn(first)).toMatchObject({ result: 'accepted' });
    await waitFor(() => second.of('resolved').length === 1);
    expect(second.of('resolved')[0]).toEqual({
      t: 'resolved',
      requestId: request.id,
      outcome: 'allow',
    });
    // The winner already knows; it gets no `resolved`.
    await t.link.hub.idle();
    expect(first.of('resolved')).toEqual([]);

    await second.decide('deny', await t.requestOn(second, request.id));
    expect(await t.resultOn(second)).toMatchObject({
      result: 'rejected',
      reason: 'already_resolved',
    });
    await expect(registration.settled).resolves.toEqual({
      type: 'decided',
      response: claudeCodeAdapter.decide(registration.request, { behavior: 'allow' }),
    });
  });

  it('applies exactly one of two concurrent decisions (decide-once)', async () => {
    const t = await setup(['Pixel', 'iPhone']);
    const [first, second] = t.phones as [FakePhone, FakePhone];
    await t.open(first);
    await t.open(second);
    const registration = t.store.register(permission());
    const request = await t.requestOn(first, registration.request.id);
    await t.requestOn(second, registration.request.id);

    await Promise.all([first.decide('allow', request), second.decide('deny', request)]);
    const results = [await t.resultOn(first), await t.resultOn(second)];
    expect(results.filter((r) => r.result === 'accepted')).toHaveLength(1);
    expect(results.filter((r) => r.result === 'rejected')).toEqual([
      expect.objectContaining({ reason: 'already_resolved' }),
    ]);
  });

  it('ends a terminal decision as a release and tells the other phones', async () => {
    const t = await setup(['Pixel', 'iPhone']);
    const [first, second] = t.phones as [FakePhone, FakePhone];
    await t.open(first);
    await t.open(second);
    const registration = t.store.register(permission());
    const request = await t.requestOn(first, registration.request.id);
    await first.decide('terminal', request);
    await expect(registration.settled).resolves.toEqual({ type: 'handoff', reason: 'released' });
    await waitFor(() => second.of('resolved').length === 1);
    expect(second.of('resolved')[0]).toMatchObject({ outcome: 'terminal' });
  });

  it('tells the phones when a request is withdrawn by its hook', async () => {
    const t = await setup();
    const [phone] = t.phones as [FakePhone];
    await t.open(phone);
    const registration = t.store.register(permission());
    await t.requestOn(phone, registration.request.id);
    registration.cancel('disconnected');
    await waitFor(() => phone.of('resolved').length === 1);
    expect(phone.of('resolved')[0]).toMatchObject({ outcome: 'withdrawn' });
  });

  it('keeps a duplicate re-registration pending on the phone', async () => {
    const t = await setup();
    const [phone] = t.phones as [FakePhone];
    await t.open(phone);
    const registration = t.store.register(permission());
    await t.requestOn(phone, registration.request.id);
    const again = t.store.register(permission());
    expect(again.duplicate).toBe(true);
    await waitFor(() => phone.of('request').length === 2);
    await t.link.hub.idle();
    expect(phone.of('resolved')).toEqual([]);
    expect(phone.doorbells).toEqual([]);
  });

  it('rings a doorbell for paired phones without a session; offline ones go to the relay sink', async () => {
    const t = await setup(['Pixel', 'iPhone']);
    const [online, offline] = t.phones as [FakePhone, FakePhone];
    await online.connect();
    const registration = t.store.register(permission());
    await waitFor(() => online.doorbells.length === 1);
    expect(online.doorbells[0]).toMatchObject({
      cls: 'request',
      payload: '',
      expiresAt: registration.request.deadline,
    });
    await t.link.hub.idle();
    expect(t.relay.undelivered).toEqual([
      expect.objectContaining({ to: offline.device.id, cls: 'request', payload: '' }),
    ]);
  });

  it('AC: doorbells and requests carry a push summary only the phone can open (D5)', async () => {
    const t = await setup(['Pixel', 'iPhone']);
    const [online, offline] = t.phones as [FakePhone, FakePhone];
    await t.open(online);
    const registration = t.store.register(
      permission('API_KEY=abc pnpm deploy', {
        payload: {
          hook_event_name: 'PermissionRequest',
          session_id: 's1',
          tool_name: 'Bash',
          tool_input: { command: 'API_KEY=abc pnpm deploy' },
          cwd: '/home/me/shop',
        },
      }),
    );
    await t.requestOn(online, registration.request.id);
    await t.link.hub.idle();
    const expected = {
      v: 1,
      p: 'shop',
      l: 'Run a command',
      s: 'API_KEY=*** pnpm deploy',
      r: registration.request.id,
    };
    const [doorbell] = t.relay.undelivered;
    expect(doorbell).toMatchObject({ to: offline.device.id, cls: 'request', payload: '' });
    expect(await pushSummaryOf(offline, t.deviceKey.publicKey, doorbell!)).toEqual(expected);
    const live = t.relay.routed.find((e) => e.to === online.device.id && e.cls === 'request')!;
    expect(await pushSummaryOf(online, t.deviceKey.publicKey, live)).toEqual(expected);
    // Bound to its envelope and its phone: no other push or phone can open it.
    await expect(
      pushSummaryOf(online, t.deviceKey.publicKey, { ...live, id: doorbell!.id }),
    ).rejects.toThrow();
    await expect(pushSummaryOf(offline, t.deviceKey.publicKey, live)).rejects.toThrow();
  });

  it('sends a request without a push summary to a phone that is no longer paired', async () => {
    const t = await setup(['Pixel']);
    const [phone] = t.phones as [FakePhone];
    await t.open(phone);
    t.setPeers([]);
    t.link.hub.relayReady(t.agentId, []);
    const registration = t.store.register(permission());
    await t.requestOn(phone, registration.request.id);
    const request = t.relay.routed.find((e) => e.cls === 'request')!;
    expect(request.pushBlob).toBeUndefined();
  });

  it('never routes plaintext: the relay sees ciphertext and empty doorbells only (I1–I3)', async () => {
    const t = await setup(['Pixel', 'iPhone']);
    const [phone] = t.phones as [FakePhone];
    await t.open(phone);
    const registration = t.store.register(permission('cat secret-file.txt'));
    const request = await t.requestOn(phone, registration.request.id);
    await phone.decide('deny', request);
    await t.resultOn(phone);
    await t.link.hub.idle();
    expect(t.relay.routed.length).toBeGreaterThan(4);
    for (const needle of ['secret-file', 'Bash', 'decision', 'snapshot', registration.request.id]) {
      expect(plaintextLeaks(t.relay.routed, needle)).toBe(false);
    }
  });

  it('refuses a handshake from a phone that is not paired, and picks up a new peer', async () => {
    const t = await setup(['Pixel', 'Stranger']);
    const [paired, stranger] = t.phones as [FakePhone, FakePhone];
    t.setPeers([paired.peer(1)]);
    await stranger.connect();
    const handshake = stranger.handshake(t.agentId, t.deviceKey.publicKey);
    await expect(handshake).rejects.toThrow('waitFor');
    expect(t.logs).toContainEqual({
      event: 'handshake_refused',
      fields: { phone_device_id: stranger.device.id, reason: 'not_paired' },
    });

    // Paired meanwhile (`remotectl pair`): the hub re-reads peers.json at every handshake.
    t.setPeers([paired.peer(1), stranger.peer(2)]);
    await stranger.handshake(t.agentId, t.deviceKey.publicKey);
    expect(t.link.hub.sessions()).toEqual([stranger.device.id]);
  });

  it('drops a handshake that does not verify and a command without a session', async () => {
    const t = await setup();
    const [phone] = t.phones as [FakePhone];
    await phone.connect();
    const base = {
      v: 1 as const,
      kind: 'data' as const,
      id: '01890000-0000-7000-8000-000000000001',
      from: phone.device.id,
      to: t.agentId,
      session: null,
      seq: 0,
      ts: t.time.clock.now(),
      expiresAt: null,
    };
    t.link.hub.envelope({
      ...base,
      cls: 'control',
      payload: Buffer.from([1, 2, 3]).toString('base64'),
    });
    t.link.hub.envelope({ ...base, cls: 'command', payload: 'AAAA' });
    // Neither a handshake tag nor a command: ignored.
    t.link.hub.envelope({ ...base, cls: 'control', payload: Buffer.from([9]).toString('base64') });
    t.link.hub.envelope({ ...base, cls: 'event', payload: 'AAAA' });
    t.link.hub.envelope({ ...base, to: phone.device.id, cls: 'command', payload: 'AAAA' });
    await t.link.hub.idle();
    expect(t.logs.map((l) => l.event)).toEqual(
      expect.arrayContaining(['handshake_failed', 'decision_rejected']),
    );
    expect(t.logs.find((l) => l.event === 'decision_rejected')!.fields).toEqual({
      phone_device_id: phone.device.id,
      reason: 'no_session',
    });
    expect(t.link.hub.sessions()).toEqual([]);
  });

  it('ends a session whose command does not decrypt, and one whose phone went offline', async () => {
    const t = await setup(['Pixel', 'iPhone']);
    const [first, second] = t.phones as [FakePhone, FakePhone];
    await t.open(first);
    await t.open(second);
    t.link.hub.envelope({
      v: 1,
      kind: 'data',
      id: '01890000-0000-7000-8000-000000000002',
      from: first.device.id,
      to: t.agentId,
      session: null,
      cls: 'command',
      seq: 99,
      ts: t.time.clock.now(),
      expiresAt: null,
      payload: Buffer.from('garbage-ciphertext-long-enough').toString('base64'),
    });
    await t.link.hub.idle();
    expect(t.link.hub.sessions()).toEqual([second.device.id]);

    second.disconnect();
    await waitFor(() => t.link.hub.sessions().length === 0);
    expect(
      t.logs.filter((l) => l.event === 'session_closed').map((l) => l.fields['reason']),
    ).toEqual(['decrypt_failed', 'offline']);
  });

  it('a new handshake from the same phone replaces its session', async () => {
    const t = await setup();
    const [phone] = t.phones as [FakePhone];
    await t.open(phone);
    await phone.handshake(t.agentId, t.deviceKey.publicKey);
    await t.link.hub.idle();
    expect(t.link.hub.sessions()).toEqual([phone.device.id]);
    expect(t.logs.filter((l) => l.event === 'session_closed')).toEqual([
      { event: 'session_closed', fields: { phone_device_id: phone.device.id, reason: 'replaced' } },
    ]);
    const registration = t.store.register(permission());
    const request = await t.requestOn(phone, registration.request.id);
    await phone.decide('allow', request);
    expect(await t.resultOn(phone)).toMatchObject({ result: 'accepted' });
  });

  it('refuses a decision for an unknown request and a message it cannot parse', async () => {
    const t = await setup();
    const [phone] = t.phones as [FakePhone];
    await t.open(phone);
    const registration = t.store.register(permission());
    const request = await t.requestOn(phone, registration.request.id);
    await phone.decide('allow', { ...request, id: '0189aaaa-0000-7000-8000-000000000000' });
    expect(await t.resultOn(phone)).toMatchObject({ reason: 'unknown_request' });
    await phone.decide('allow', request, { decision: { phone_device_id: t.agentId } });
    expect(await t.resultOn(phone, 2)).toMatchObject({ reason: 'wrong_peer' });
  });

  describe('questions (M1-01)', () => {
    const answer = encodeAnswerPayload({ answers: [{ labels: ['React'] }] });

    it('AC: answers a question with the answered tool input, and the other phones learn it', async () => {
      const t = await setup(['Pixel', 'iPhone']);
      const [first, second] = t.phones as [FakePhone, FakePhone];
      await t.open(first);
      await t.open(second);
      const registration = t.store.register(askUserQuestion());
      const question = await t.questionOn(first, registration.request.id);
      expect(question).toMatchObject({
        project: 'remote-control',
        questions: [{ text: 'Which CANARY-q1 framework?', header: 'Framework', multi: false }],
      });
      expect(first.of('question').at(-1)!.ttlMs).toBe(HOOK_TIMEOUT_MS - 10_000);

      await first.decide('answer', question, { decision: { payload: answer } });
      expect(await t.resultOn(first)).toMatchObject({ result: 'accepted' });
      // The hook output is exactly the decide module's answer (its own test pins the bytes).
      await expect(registration.settled).resolves.toEqual({
        type: 'decided',
        response: decideClaudeCode(registration.request, {
          behavior: 'answer',
          answer: { answers: { 'Which CANARY-q1 framework?': 'React' } },
        }),
      });
      await expect(registration.settled).resolves.toMatchObject({
        response: {
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
        },
      });
      await waitFor(() => second.of('resolved').length === 1);
      expect(second.of('resolved')[0]).toMatchObject({ outcome: 'answer' });
      expect(plaintextLeaks(t.relay.routed, 'CANARY-q1')).toBe(false);
    });

    it('hands a question to a new session with the pending set', async () => {
      const t = await setup();
      const registration = t.store.register(askUserQuestion());
      const [phone] = t.phones as [FakePhone];
      await t.open(phone);
      await t.questionOn(phone, registration.request.id);
      expect(phone.of('snapshot')[0]!.pending).toEqual([registration.request.id]);
    });

    it('denies a question like any other request', async () => {
      const t = await setup();
      const [phone] = t.phones as [FakePhone];
      await t.open(phone);
      const registration = t.store.register(askUserQuestion());
      const question = await t.questionOn(phone, registration.request.id);
      await phone.decide('deny', question);
      expect(await t.resultOn(phone)).toMatchObject({ result: 'accepted' });
      await expect(registration.settled).resolves.toMatchObject({
        response: { hookSpecificOutput: { permissionDecision: 'deny' } },
      });
    });

    it('rejects an answer that does not fit, then accepts a fitting one', async () => {
      const t = await setup();
      const [phone] = t.phones as [FakePhone];
      await t.open(phone);
      const registration = t.store.register(askUserQuestion());
      const question = await t.questionOn(phone, registration.request.id);
      const unknown = encodeAnswerPayload({ answers: [{ labels: ['Angular'] }] });
      await phone.decide('answer', question, { decision: { payload: unknown } });
      expect(await t.resultOn(phone)).toMatchObject({ reason: 'invalid_answer' });
      await phone.decide('answer', question, { decision: { payload: 'not json' } });
      expect(await t.resultOn(phone, 2)).toMatchObject({ reason: 'invalid_answer' });
      await phone.decide('allow', question);
      expect(await t.resultOn(phone, 3)).toMatchObject({ reason: 'wrong_kind' });
      expect(t.store.get(question.id)).toBe(registration.request);

      await phone.decide('answer', question, { decision: { payload: answer } });
      expect(await t.resultOn(phone, 4)).toMatchObject({ result: 'accepted' });
    });

    it('AC: an answer decision for a Bash request is rejected (wrong_kind)', async () => {
      const t = await setup();
      const [phone] = t.phones as [FakePhone];
      await t.open(phone);
      const registration = t.store.register(permission());
      const request = await t.requestOn(phone, registration.request.id);
      await phone.decide('answer', request, { decision: { payload: answer } });
      expect(await t.resultOn(phone)).toMatchObject({ result: 'rejected', reason: 'wrong_kind' });
      expect(t.store.get(request.id)).toBe(registration.request);
    });

    it('keeps a question the phone cannot show with the terminal', async () => {
      const t = await setup();
      const [phone] = t.phones as [FakePhone];
      await t.open(phone);
      const input = askUserQuestion();
      const registration = t.store.register({
        ...input,
        payload: { ...input.payload, tool_input: { questions: [] } },
      });
      await t.link.hub.idle();
      expect(phone.of('question')).toEqual([]);
      expect(t.store.get(registration.request.id)).toBe(registration.request);
    });
  });
});
