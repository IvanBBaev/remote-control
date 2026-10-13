import {
  deriveNotificationKey,
  generateX25519KeyPair,
  openPushSummary,
} from '@remote-control/crypto';
import { seededRandom } from '@remote-control/fake-claude-code';
import {
  decodePushSummary,
  encodeAnswerPayload,
  type AlwaysDestination,
  type ApprovalRequest,
  type Envelope,
  type ProjectHistory,
  type Question,
} from '@remote-control/protocol';
import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_CODE_CAPABILITIES, claudeCodeAdapter } from '../adapters/claude-code/adapter.js';
import { decideClaudeCode } from '../adapters/claude-code/decide.js';
import type { Peer } from '../ports/key-store.js';
import { createFakePhone, type FakePhone } from '../testing/fake-phone.js';
import { createFakeRelay } from '../testing/fake-relay.js';
import { manualTime, waitFor } from '../testing/manual-time.js';
import type { LaunchResult, SessionLauncher, SessionView } from './launcher.js';
import { createPendingStore, type RegisterInput } from './pending-store.js';
import { noticeSummaryText } from './push-summary.js';
import { createRelayLink, type RelayLink, type RelayLinkOptions } from './relay-link.js';
import { NOTICE_TTL_MS } from './session-hub.js';

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

async function setup(
  names: readonly string[] = ['Pixel'],
  seed = 11,
  history?: () => Promise<readonly ProjectHistory[]>,
  alwaysDestinations?: readonly AlwaysDestination[],
  extra: Partial<RelayLinkOptions> = {},
) {
  const time = manualTime();
  const random = seededRandom(seed);
  const relay = createFakeRelay(time.clock);
  const deviceKey = await generateX25519KeyPair(random);
  const logs: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const phones: FakePhone[] = [];
  for (const name of names) phones.push(await createFakePhone(relay, name, time.clock, random));
  let peers: readonly Peer[] = phones.map((phone) => phone.peer(1));
  const ref: { link?: RelayLink } = {};
  /** Every adapter `decide` call: the only path that counts approvals/denials (M1-11). */
  const decided: string[] = [];
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
    decide: (request, decision) => {
      decided.push(decision.behavior);
      return claudeCodeAdapter.decide(request, decision);
    },
    machine: { name: 'mac', platform: 'darwin', agentVersion: '1.2.3' },
    capabilities: [CLAUDE_CODE_CAPABILITIES],
    url: 'ws://127.0.0.1:8787/ws',
    token: relay.agent.token,
    version: '1.2.3',
    webSocket: relay.webSocket,
    log: (event, fields) => logs.push({ event, fields }),
    ...(history === undefined ? {} : { history }),
    ...(alwaysDestinations === undefined ? {} : { alwaysDestinations }),
    ...extra,
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
    decided,
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

  describe('"Always" destinations (M2-07, D24)', () => {
    const suggesting = () =>
      permission('npm test', {
        payload: {
          ...permission().payload,
          permission_suggestions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
              behavior: 'allow',
              destination: 'projectSettings',
            },
          ],
        },
      });

    it('AC: a destination outside `always.destinations` is rejected and never emitted', async () => {
      const t = await setup(['Pixel'], 11, undefined, ['session', 'localSettings']);
      const [phone] = t.phones as [FakePhone];
      await t.open(phone);
      const registration = t.store.register(suggesting());
      const request = await t.requestOn(phone, registration.request.id);
      expect(request.alwaysDestinations).toEqual(['session', 'localSettings']);

      await phone.decide('always', request, { decision: { payload: 'projectSettings' } });
      expect(await t.resultOn(phone)).toMatchObject({ result: 'rejected', reason: 'wrong_kind' });
      expect(t.decided).toEqual([]);
      expect(t.store.get(request.id)).toBe(registration.request);

      await phone.decide('always', request, { decision: { payload: 'localSettings' } });
      expect(await t.resultOn(phone, 2)).toMatchObject({ result: 'accepted' });
      const settled = await registration.settled;
      const text = JSON.stringify(settled);
      expect(text).toContain('"destination":"localSettings"');
      expect(text).not.toMatch(/projectSettings|"destination":"session"/);
    });

    it('sends the session only, and refuses settings, with the default setting', async () => {
      const t = await setup();
      const [phone] = t.phones as [FakePhone];
      await t.open(phone);
      const registration = t.store.register(suggesting());
      const request = await t.requestOn(phone, registration.request.id);
      expect(request).not.toHaveProperty('alwaysDestinations');

      await phone.decide('always', request, { decision: { payload: 'localSettings' } });
      expect(await t.resultOn(phone)).toMatchObject({ result: 'rejected', reason: 'wrong_kind' });
      await phone.decide('always', request);
      expect(await t.resultOn(phone, 2)).toMatchObject({ result: 'accepted' });
      const text = JSON.stringify(await registration.settled);
      expect(text).toContain('"destination":"session"');
      expect(text).not.toMatch(/localSettings|projectSettings/);
    });
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

  it('answers an instruct or start sent as a plain decision with unsupported', async () => {
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
    expect(await t.resultOn(first)).toMatchObject({ result: 'accepted' });
    await waitFor(() => second.of('resolved').length === 1);
    expect(second.of('resolved')[0]).toMatchObject({ outcome: 'terminal' });
    // A release never builds a hook decision, so it counts as neither approval nor denial.
    expect(t.decided).toEqual([]);
    // The winner already knows; a second decision on the released request is late.
    expect(first.of('resolved')).toEqual([]);
    await second.decide('allow', await t.requestOn(second, registration.request.id));
    expect(await t.resultOn(second)).toMatchObject({ reason: 'already_resolved' });
  });

  it('tells the phones `resolved terminal` when `remotectl pause` hands a request back', async () => {
    const t = await setup();
    const [phone] = t.phones as [FakePhone];
    await t.open(phone);
    const registration = t.store.register(permission());
    await t.requestOn(phone, registration.request.id);
    t.store.releaseAll('paused');
    await expect(registration.settled).resolves.toEqual({ type: 'handoff', reason: 'paused' });
    await waitFor(() => phone.of('resolved').length === 1);
    expect(phone.of('resolved')[0]).toMatchObject({ outcome: 'terminal' });
    expect(t.decided).toEqual([]);
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

  describe('turn notices (M2-08)', () => {
    const stop = { hook_event_name: 'Stop', session_id: 's1', cwd: '/home/me/shop' };

    it('AC: pushes a sealed notice to every phone without a session; the body is ciphertext', async () => {
      const t = await setup(['Pixel', 'iPhone', 'iPad']);
      const [live, idle, offline] = t.phones as [FakePhone, FakePhone, FakePhone];
      await t.open(live);
      await idle.connect();
      const before = t.relay.routed.length;
      const now = t.time.clock.now();
      t.link.hub.notice(noticeSummaryText(stop, 'finished'));
      await t.link.hub.idle();
      const notices = t.relay.routed.slice(before);
      expect(notices.map((e) => e.to).sort()).toEqual([idle.device.id, offline.device.id].sort());
      for (const notice of notices) {
        expect(notice).toMatchObject({
          cls: 'request',
          payload: '',
          expiresAt: now + NOTICE_TTL_MS,
        });
      }
      await waitFor(() => idle.doorbells.length === 1);
      expect(t.relay.undelivered).toEqual([expect.objectContaining({ to: offline.device.id })]);
      const expected = { v: 1, p: 'shop', l: 'Turn finished', k: 'finished' };
      expect(await pushSummaryOf(offline, t.deviceKey.publicKey, t.relay.undelivered[0]!)).toEqual(
        expected,
      );
      const rung = notices.find((e) => e.to === idle.device.id)!;
      expect(await pushSummaryOf(idle, t.deviceKey.publicKey, rung)).toEqual(expected);
      for (const needle of ['shop', 'Turn finished', 'finished']) {
        expect(plaintextLeaks(notices, needle)).toBe(false);
      }
    });

    it('sends nothing to a phone it cannot seal for — no generic "Approval needed" push', async () => {
      const t = await setup(['Pixel']);
      const [phone] = t.phones as [FakePhone];
      t.setPeers([{ ...phone.peer(1), publicKey: '!!' }]);
      t.link.hub.relayReady(t.agentId, []);
      await t.link.hub.idle();
      const before = t.relay.routed.length;
      t.link.hub.notice(noticeSummaryText(stop, 'finished'));
      await t.link.hub.idle();
      expect(t.relay.routed.length).toBe(before);
      expect(t.relay.undelivered).toEqual([]);
    });
  });

  describe('history (M2-06)', () => {
    const entry = (project: string, toolCalls: number): ProjectHistory => ({
      project,
      sessions: 1,
      toolCalls,
      approvals: 2,
      denials: 0,
      activeMs: 60_000,
      lastActiveAt: 5,
    });

    it('AC: sends the history after the snapshot and again when it changes', async () => {
      let current: ProjectHistory[] = [entry('secret-shop', 1)];
      const t = await setup(['Pixel', 'iPhone'], 11, () => Promise.resolve(current));
      const [first, second] = t.phones as [FakePhone, FakePhone];
      t.link.hub.historyChanged();
      await t.link.hub.idle();
      await t.open(first);
      await t.open(second);
      await waitFor(() => second.of('history').length === 1);
      expect(first.of('history')).toEqual([{ t: 'history', projects: current }]);
      const order = first.messages.map((m) => m.message.t);
      expect(order.indexOf('snapshot')).toBeLessThan(order.indexOf('history'));
      current = [entry('secret-shop', 2)];
      t.link.hub.historyChanged();
      await t.link.hub.idle();
      for (const phone of [first, second]) {
        await waitFor(() => phone.of('history').length === 2);
        expect(phone.of('history')[1]!.projects).toEqual(current);
      }
      expect(plaintextLeaks(t.relay.routed, 'secret-shop')).toBe(false);
    });

    it('skips a history it cannot read and sends nothing without the option', async () => {
      const t = await setup(['Pixel'], 11, () => Promise.reject(new Error('disk')));
      const [phone] = t.phones as [FakePhone];
      await t.open(phone);
      await waitFor(() => phone.of('snapshot').length === 1);
      expect(t.logs).toContainEqual({ event: 'history_unavailable', fields: {} });
      expect(phone.of('history')).toEqual([]);
      const plain = await setup(['Pixel'], 12);
      const [other] = plain.phones as [FakePhone];
      await plain.open(other);
      plain.link.hub.historyChanged();
      await plain.link.hub.idle();
      await waitFor(() => other.of('snapshot').length === 1);
      expect(other.of('history')).toEqual([]);
    });
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

    it('AC: "Reply in terminal" releases a question with no decision (M1-03)', async () => {
      const t = await setup(['Pixel', 'iPhone']);
      const [first, second] = t.phones as [FakePhone, FakePhone];
      await t.open(first);
      await t.open(second);
      const registration = t.store.register(askUserQuestion());
      const question = await t.questionOn(first, registration.request.id);
      await first.decide('terminal', question);
      expect(await t.resultOn(first)).toMatchObject({ result: 'accepted' });
      await expect(registration.settled).resolves.toEqual({
        type: 'handoff',
        reason: 'released',
      });
      await waitFor(() => second.of('resolved').length === 1);
      expect(second.of('resolved')[0]).toMatchObject({ outcome: 'terminal' });
      expect(t.decided).toEqual([]);
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
  describe('start and instruct (M1-04)', () => {
    const REPO = { id: 'f'.repeat(32), name: 'app', path: '/work/app' };
    const SESSION = '5b7c1e2a-9d3f-4e8a-b6c4-2f1d0e9a8b7c';
    const LIVE: SessionView = {
      id: SESSION,
      repositoryId: REPO.id,
      state: 'working',
      statusText: 'Working',
      name: 'rc-app-00000000',
      followUp: true,
    };

    function fakeLauncher(sessions: SessionView[] = []) {
      let finish: ((result: LaunchResult) => void) | undefined;
      const launcher = {
        repositories: vi.fn(() => Promise.resolve([REPO])),
        sessions: vi.fn(() => Promise.resolve(sessions)),
        canFollowUp: vi.fn((id: string) => Promise.resolve(id === SESSION)),
        start: vi.fn<SessionLauncher['start']>(
          () => new Promise<LaunchResult>((resolve) => (finish = resolve)),
        ),
        instruct: vi.fn<SessionLauncher['instruct']>(() =>
          Promise.resolve({ ok: true, sessionId: SESSION }),
        ),
      };
      return { launcher, sessions, finish: (result: LaunchResult) => finish!(result) };
    }

    async function launching(followUps = true, sessions: SessionView[] = []) {
      const fake = fakeLauncher(sessions);
      const t = await setup(['Pixel'], 11, undefined, undefined, {
        launcher: fake.launcher,
        capabilities: [
          { ...CLAUDE_CODE_CAPABILITIES, startSession: true, instructions: followUps },
        ],
      });
      const [phone] = t.phones as [FakePhone];
      await t.open(phone);
      return { ...t, ...fake, phone };
    }

    it('lists the repositories and the launcher sessions in the snapshot', async () => {
      const t = await launching(true, [LIVE]);
      const [snapshot] = t.phone.of('snapshot');
      expect(snapshot!.repositories).toEqual([{ ...REPO, machineId: t.agentId }]);
      expect(snapshot!.sessions).toEqual([
        expect.objectContaining({ ...LIVE, machineId: t.agentId, agent: 'claude-code' }),
      ]);
      // A session with a request shown is waiting for approval.
      t.store.register(permission('npm test', { sessionId: SESSION }));
      t.link.hub.sessionsChanged();
      await waitFor(() => t.phone.of('snapshot').length === 2);
      expect(t.phone.of('snapshot')[1]!.sessions[0]).toMatchObject({
        id: SESSION,
        state: 'waiting',
        statusText: 'Waiting for approval',
        name: 'rc-app-00000000',
      });
    });

    it('AC: starts a session after the D7 checks and replies with its id (J10)', async () => {
      const t = await launching();
      const start = { machineId: t.agentId, repositoryId: REPO.id, prompt: 'fix the build' };
      await t.phone.start(start, REPO.path);
      await waitFor(() => t.launcher.start.mock.calls.length === 1);
      expect(t.launcher.start).toHaveBeenCalledWith(REPO.id, 'fix the build');
      // The phone's queue is free while `claude` runs: a request still reaches it.
      const registration = t.store.register(permission());
      await t.requestOn(t.phone, registration.request.id);
      expect(t.phone.of('decision_result')).toEqual([]);
      t.finish({ ok: true, sessionId: SESSION });
      expect(await t.resultOn(t.phone)).toMatchObject({ result: 'accepted', sessionId: SESSION });
      expect(t.logs.map((entry) => entry.event)).toContain('command_accepted');
      expect(JSON.stringify(t.logs)).not.toContain('fix the build');
    });

    it('replies accepted without an id, and passes a launch refusal on', async () => {
      const t = await launching();
      const start = { machineId: t.agentId, repositoryId: REPO.id, prompt: 'go' };
      await t.phone.start(start, REPO.path);
      await waitFor(() => t.launcher.start.mock.calls.length === 1);
      t.finish({ ok: true });
      const accepted = await t.resultOn(t.phone);
      expect(accepted).toMatchObject({ result: 'accepted' });
      expect(accepted).not.toHaveProperty('sessionId');
      await t.phone.start(start, REPO.path);
      await waitFor(() => t.launcher.start.mock.calls.length === 2);
      t.finish({ ok: false, reason: 'start_failed' });
      expect(await t.resultOn(t.phone, 2)).toMatchObject({
        result: 'rejected',
        reason: 'start_failed',
      });
    });

    it('AC: refuses an unknown repository without a launch (J11)', async () => {
      const t = await launching();
      const start = { machineId: t.agentId, repositoryId: '0'.repeat(32), prompt: 'go' };
      await t.phone.start(start, '/elsewhere');
      expect(await t.resultOn(t.phone)).toMatchObject({
        result: 'rejected',
        reason: 'not_allowed',
      });
      expect(t.launcher.start).not.toHaveBeenCalled();
      expect(t.logs).toContainEqual({
        event: 'command_rejected',
        fields: expect.objectContaining({ reason: 'not_allowed' }) as unknown,
      });
    });

    it('rejects a start for another machine, a prompt the hash does not cover, and a replay', async () => {
      const t = await launching();
      const start = { machineId: t.agentId, repositoryId: REPO.id, prompt: 'go' };
      await t.phone.start({ ...start, machineId: t.phone.device.id }, REPO.path);
      expect(await t.resultOn(t.phone)).toMatchObject({ reason: 'wrong_peer' });
      await t.phone.start(start, '/other/path');
      expect(await t.resultOn(t.phone, 2)).toMatchObject({ reason: 'hash_mismatch' });
      await t.phone.start(start, REPO.path, { decision: { payload: 'x'.repeat(32) } });
      expect(await t.resultOn(t.phone, 3)).toMatchObject({ reason: 'wrong_kind' });
      const requestId = '00000000-0000-4000-8000-0000000000aa';
      await t.phone.start(start, REPO.path, { decision: { request_id: requestId } });
      await waitFor(() => t.launcher.start.mock.calls.length === 1);
      t.finish({ ok: true });
      await t.resultOn(t.phone, 4);
      await t.phone.start(start, REPO.path, { decision: { request_id: requestId } });
      expect(await t.resultOn(t.phone, 5)).toMatchObject({ reason: 'already_resolved' });
      // A used id is forgotten once its decision expired.
      const now = Math.floor(t.time.clock.now() / 1000);
      await t.phone.start(start, REPO.path, {
        decision: { issued_at: now - 299, expires_at: now + 1 },
      });
      await waitFor(() => t.launcher.start.mock.calls.length === 2);
      t.finish({ ok: true });
      await t.resultOn(t.phone, 6);
      t.time.advance(2_000);
      await t.phone.start(start, REPO.path, {
        decision: { issued_at: now - 400, expires_at: now - 100 },
      });
      expect(await t.resultOn(t.phone, 7)).toMatchObject({ reason: 'expired' });
      expect(t.launcher.start).toHaveBeenCalledTimes(2);
    });

    it('rejects a start the relay did not verify', async () => {
      const t = await launching();
      const start = { machineId: t.agentId, repositoryId: REPO.id, prompt: 'go' };
      t.relay.verified.add('c'.repeat(64));
      await t.phone.start(start, REPO.path, { envelopeHash: 'c'.repeat(64) });
      expect(await t.resultOn(t.phone)).toMatchObject({ reason: 'unverified' });
    });

    it('AC: sends a follow-up to a session that takes one (J9)', async () => {
      const t = await launching();
      await t.phone.instruct(SESSION, 'now the tests');
      expect(await t.resultOn(t.phone)).toMatchObject({ result: 'accepted', sessionId: SESSION });
      expect(t.launcher.instruct).toHaveBeenCalledWith(SESSION, 'now the tests');
      await t.phone.instruct('11111111-1111-4111-8111-111111111111', 'x');
      expect(await t.resultOn(t.phone, 2)).toMatchObject({
        result: 'rejected',
        reason: 'follow_up_unsupported',
      });
      expect(t.launcher.instruct).toHaveBeenCalledTimes(1);
    });

    it('answers unsupported when the CLI is too old for follow-ups or there is no launcher', async () => {
      const t = await launching(false);
      await t.phone.instruct(SESSION, 'x');
      expect(await t.resultOn(t.phone)).toMatchObject({ reason: 'unsupported' });

      const bare = await setup();
      const [phone] = bare.phones as [FakePhone];
      await bare.open(phone);
      expect(phone.of('snapshot')[0]).not.toHaveProperty('repositories');
      await phone.start({ machineId: bare.agentId, repositoryId: REPO.id, prompt: 'go' }, '/r');
      await phone.instruct(SESSION, 'x');
      expect(await bare.resultOn(phone)).toMatchObject({ reason: 'unsupported' });
      expect(await bare.resultOn(phone, 2)).toMatchObject({ reason: 'unsupported' });
      // Nothing to tell without a phone session.
      bare.link.hub.sessionsChanged();
    });

    it('re-sends the snapshot when sessions change, only to live phones', async () => {
      const t = await launching(true, []);
      t.sessions.push(LIVE);
      t.link.hub.sessionsChanged();
      await waitFor(() => t.phone.of('snapshot').length === 2);
      expect(t.phone.of('snapshot')[1]!.sessions.map((session) => session.id)).toEqual([SESSION]);
    });
  });
});
