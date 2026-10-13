import { pairingFingerprint } from '@remote-control/crypto';
import {
  DECISION_TTL_SECONDS,
  decisionHash,
  encodeAnswerPayload,
  requestHash,
  toBase64Url,
} from '@remote-control/protocol';
import type { ApprovalRequest, Question, Repository } from '@remote-control/protocol';
import { describe, expect, it, vi } from 'vitest';

import { RelayError } from '../auth/relay-api.js';
import type { RelayApi } from '../auth/relay-api.js';
import { fakeRelay, mockCredentials, userCancelled } from '../auth/test-credentials.js';
import { pairingSecrets } from '../pairing/pairing-code.js';
import { PairingError, phoneNameFrom, relaySocketUrl } from './phone.js';
import { PAIRING_TIMEOUT_MS } from './realtime-client.js';
import { diffKey } from './realtime-store.js';
import { createTestAgent } from './test-agent.js';
import { createTestPhone } from './test-phone.js';
import { machineUsage } from './usage-stats.js';

const USER = '0d6f8a52-3c5e-4f0b-9a4e-000000000000';
const PHONE = '0d6f8a52-3c5e-4f0b-9a4e-111111111111';
const AGENT = '0d6f8a52-3c5e-4f0b-9a4e-222222222222';
const CODE = '0123-4567-89AB';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function setup(overrides: Partial<RelayApi> = {}) {
  const { codeHash } = await pairingSecrets('0123456789AB');
  const mocks = {
    bindPhone: vi.fn(() => Promise.resolve({ deviceId: PHONE })),
    joinPairing: vi.fn((hash: string) =>
      hash === codeHash
        ? Promise.resolve({ agentDeviceId: AGENT })
        : Promise.reject(new RelayError(404, 'unknown_slot')),
    ),
    enrollAgent: vi.fn(() => Promise.resolve({ deviceId: AGENT, enrollToken: 'rc-enroll:abc' })),
  };
  const relay = fakeRelay({ ...mocks, ...overrides });
  const { phone, keyStore, sockets, timer } = createTestPhone(relay);
  const identity = await keyStore.identity();
  const agent = await createTestAgent({
    deviceId: AGENT,
    userId: USER,
    phoneDeviceId: PHONE,
    phonePublicKey: () => identity.keyPair.publicKey,
    now: () => timer.now(),
  });
  /** Connects and lets the relay accept the socket. */
  const online = async (): Promise<void> => {
    await phone.connect(USER);
    sockets.last.open();
    sockets.last.helloOk(PHONE, timer.now(), []);
    await settle();
  };
  return { timer, sockets, keyStore, mocks, agent, phone, identity, online };
}

describe('phone service', () => {
  it('binds a new phone and remembers its device id', async () => {
    const t = await setup();
    await t.phone.connect(USER);
    expect(t.mocks.bindPhone).toHaveBeenCalledWith({ name: 'iPhone' });
    expect((await t.keyStore.identity()).deviceId).toBe(PHONE);
    // The same user again is the same connection.
    await t.phone.connect(USER);
    expect(t.mocks.bindPhone).toHaveBeenCalledTimes(1);
    expect(t.sockets.all).toHaveLength(1);
    expect(t.phone.client).toBeDefined();
  });

  it('re-binds with the known id, and starts over when the relay forgot it', async () => {
    const bindPhone = vi.fn((input: { name: string; deviceId?: string }) =>
      input.deviceId === undefined
        ? Promise.resolve({ deviceId: PHONE })
        : Promise.reject(new RelayError(404, 'unknown_device')),
    );
    const t = await setup({ bindPhone });
    await t.keyStore.setDeviceId('0d6f8a52-3c5e-4f0b-9a4e-999999999999');
    await t.phone.connect(USER);
    expect(bindPhone).toHaveBeenNthCalledWith(1, {
      name: 'iPhone',
      deviceId: '0d6f8a52-3c5e-4f0b-9a4e-999999999999',
    });
    expect((await t.keyStore.identity()).deviceId).toBe(PHONE);

    const kept = await setup();
    await kept.keyStore.setDeviceId(PHONE);
    await kept.phone.connect(USER);
    expect(kept.mocks.bindPhone).toHaveBeenCalledOnce();
  });

  it('lets a failed connect be retried', async () => {
    const bindPhone = vi
      .fn<RelayApi['bindPhone']>()
      .mockRejectedValueOnce(new RelayError(500, 'internal'))
      .mockResolvedValue({ deviceId: PHONE });
    const t = await setup({ bindPhone });
    await t.keyStore.setDeviceId(PHONE);
    await expect(t.phone.connect(USER)).rejects.toThrow('500');
    await t.phone.connect(USER);
    expect(t.sockets.all).toHaveLength(1);
  });

  it('retries a failed connect when the app wakes up', async () => {
    const bindPhone = vi
      .fn<RelayApi['bindPhone']>()
      .mockRejectedValueOnce(new RelayError(500, 'internal'))
      .mockRejectedValueOnce(new RelayError(500, 'internal'))
      .mockResolvedValue({ deviceId: PHONE });
    const t = await setup({ bindPhone });
    await expect(t.phone.connect(USER)).rejects.toThrow('500');
    t.phone.wake();
    // A wake while that attempt is still running does not start another.
    t.phone.wake();
    await settle();
    expect(bindPhone).toHaveBeenCalledTimes(2);
    t.phone.wake();
    await settle();
    expect(t.sockets.all).toHaveLength(1);
  });

  it('reconnects for another user and disconnects', async () => {
    const t = await setup();
    await t.phone.connect(USER);
    await t.phone.connect('0d6f8a52-3c5e-4f0b-9a4e-aaaaaaaaaaaa');
    expect(t.sockets.all).toHaveLength(2);
    expect(t.sockets.all[0]?.closed).toEqual({ code: 1000, reason: 'bye' });
    t.phone.wake();
    t.phone.disconnect();
    t.phone.wake();
    expect(t.phone.client).toBeUndefined();
    expect(t.phone.realtime.getState().connection).toBe('stopped');
  });

  it('asks the client for a diff, and says unavailable when not connected (M2-02)', async () => {
    const t = await setup();
    t.phone.diff('m1', 's1', '/a.ts');
    expect(t.phone.realtime.getState().diffs[diffKey('m1', 's1', '/a.ts')]?.status).toBe(
      'unavailable',
    );
    await t.phone.connect(USER);
    const requestDiff = vi.spyOn(t.phone.client!, 'requestDiff');
    t.phone.diff('m1', 's1', '/a.ts');
    expect(requestDiff).toHaveBeenCalledExactlyOnceWith('m1', 's1', '/a.ts');
  });

  it('pairs: join, handshake, fingerprint, then saves on confirm', async () => {
    const t = await setup();
    await t.online();
    expect(await t.phone.pairedCount()).toBe(0);
    const { psk } = await pairingSecrets('0123456789AB');
    const [pending, agentSide] = await Promise.all([
      t.phone.pair(CODE.toLowerCase()),
      (async () => {
        await settle();
        return t.agent.acceptPairing(t.sockets.last, psk, 'Studio Mac');
      })(),
    ]);
    expect(agentSide).toEqual({ name: 'iPhone' });
    expect(pending).toMatchObject({ agentDeviceId: AGENT, name: 'Studio Mac' });
    expect(pending.fingerprint).toBe(
      await pairingFingerprint(t.identity.keyPair.publicKey, t.agent.keyPair.publicKey),
    );
    expect(await t.phone.pairedCount()).toBe(0);

    await pending.confirm();
    expect(await t.keyStore.machines()).toEqual([
      {
        deviceId: AGENT,
        name: 'Studio Mac',
        publicKey: t.agent.keyPair.publicKey,
        pairedAt: t.timer.now(),
      },
    ]);
    await settle();
    expect(t.phone.realtime.getState().machines[AGENT]).toMatchObject({
      name: 'Studio Mac',
      session: 'handshaking',
    });
  });

  it('refuses a short code and pairing while offline, without using the slot', async () => {
    const t = await setup();
    await expect(t.phone.pair('0123')).rejects.toThrow('all 12 characters');
    await expect(t.phone.pair(CODE)).rejects.toThrow('Not connected');
    await t.phone.connect(USER);
    await expect(t.phone.pair(CODE)).rejects.toThrow('Not connected');
    expect(t.mocks.joinPairing).not.toHaveBeenCalled();
  });

  it.each([
    [new RelayError(404, 'unknown_slot'), 'not valid'],
    [new RelayError(410, 'expired'), 'expired'],
    [new RelayError(410, 'closed'), 'expired'],
    [new RelayError(409, 'already_joined'), 'already used'],
    [new RelayError(429, 'rate_limited', 30), 'Too many attempts'],
    [new RelayError(500, 'internal'), 'Pairing failed'],
    [new Error('network'), 'Pairing failed'],
  ])('explains a refused join: %s', async (error, message) => {
    const t = await setup({ joinPairing: () => Promise.reject(error) });
    await t.online();
    const failure = t.phone.pair(CODE);
    await expect(failure).rejects.toThrow(message);
    await expect(failure).rejects.toBeInstanceOf(PairingError);
  });

  it('pairs from the scanned QR with the same handshake', async () => {
    const t = await setup();
    await t.online();
    const { psk } = await pairingSecrets('0123456789AB');
    const [pending] = await Promise.all([
      t.phone.pairScanned(`rc1:RC.example.test:${AGENT.toUpperCase()}:${toBase64Url(psk)}`),
      (async () => {
        await settle();
        return t.agent.acceptPairing(t.sockets.last, psk, 'Studio Mac');
      })(),
    ]);
    expect(pending).toMatchObject({ agentDeviceId: AGENT, name: 'Studio Mac' });
    expect(t.mocks.joinPairing).toHaveBeenCalledOnce();
  });

  it('refuses a QR that is not a pairing code or names another relay or computer', async () => {
    const t = await setup();
    await t.online();
    const { psk } = await pairingSecrets('0123456789AB');
    const key = toBase64Url(psk);
    await expect(t.phone.pairScanned('https://example.com')).rejects.toThrow('not a pairing QR');
    await expect(t.phone.pairScanned(`rc1:evil.example:${AGENT}:${key}`)).rejects.toThrow(
      'another server (evil.example)',
    );
    expect(t.mocks.joinPairing).not.toHaveBeenCalled();
    const other = '0d6f8a52-3c5e-4f0b-9a4e-333333333333';
    const failure = t.phone.pairScanned(`rc1:rc.example.test:${other}:${key}`);
    await expect(failure).rejects.toThrow('does not match the computer');
    await expect(failure).rejects.toBeInstanceOf(PairingError);
  });

  it('explains a computer that never answers', async () => {
    const t = await setup();
    await t.online();
    const failure = t.phone.pair(CODE);
    await settle();
    t.timer.advance(PAIRING_TIMEOUT_MS);
    await expect(failure).rejects.toThrow('did not answer');
  });

  it('enrols a computer through the relay', async () => {
    const t = await setup();
    await expect(t.phone.enroll('Studio Mac')).resolves.toEqual({
      deviceId: AGENT,
      enrollToken: 'rc-enroll:abc',
    });
    expect(t.mocks.enrollAgent).toHaveBeenCalledWith('Studio Mac');
  });
});

describe('phone decisions', () => {
  const REQUEST: ApprovalRequest = {
    id: '7a1b2c3d-4e5f-4a6b-8c7d-000000000001',
    sessionId: '5e5e5e5e-0000-4000-8000-000000000001',
    requestHash: 'a'.repeat(64),
    toolLabel: 'Run a command',
    toolName: 'Bash',
    content: 'pnpm test',
    truncated: false,
    suggestions: [],
    expiresAt: Date.UTC(2026, 9, 1, 0, 5),
    alwaysSupported: true,
  };

  const hexToBase64Url = (hex: string): string =>
    btoa(String.fromCharCode(...(hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16))))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');

  /** A relay that issues the challenge for the hash it was given, like the real one. */
  const assertingRelay = () => {
    let last = '';
    return {
      decisionChallenge: vi.fn((hash: string) => {
        last = hash;
        return Promise.resolve({ challenge: hexToBase64Url(hash), rpId: 'localhost' });
      }),
      decisionVerify: vi.fn(() => Promise.resolve({ decisionHash: last, verifiedUntil: 0 })),
    };
  };

  it('refuses while not connected', async () => {
    const t = await setup();
    await expect(t.phone.decide(AGENT, REQUEST, 'deny')).resolves.toEqual({
      ok: false,
      failure: 'offline',
    });
  });

  it('denies without a passkey, stamped with relay time', async () => {
    const t = await setup();
    await t.online();
    t.phone.realtime.setState({ relayOffset: 90_000 });
    const decide = vi.spyOn(t.phone.client!, 'decide');
    const result = await t.phone.decide(AGENT, REQUEST, 'deny');
    const issuedAt = Math.floor((t.timer.now() + 90_000) / 1000);
    const decision = {
      v: 1,
      kind: 'deny',
      request_id: REQUEST.id,
      request_hash: REQUEST.requestHash,
      payload: null,
      issued_at: issuedAt,
      expires_at: issuedAt + DECISION_TTL_SECONDS,
      phone_device_id: PHONE,
      agent_device_id: AGENT,
    } as const;
    expect(result).toEqual({
      ok: true,
      decisionHash: await decisionHash(decision),
      asserted: false,
    });
    expect(decide).toHaveBeenCalledWith(AGENT, decision, undefined);
  });

  it('counts a decision locally once the computer accepted it (M1-11)', async () => {
    const t = await setup();
    await t.online();
    vi.spyOn(t.phone.client!, 'decide').mockReturnValue(undefined);
    const pending = {
      machineId: AGENT,
      request: { ...REQUEST, project: 'api' },
      deadline: t.timer.now() + 60_000,
      status: 'pending',
    } as const;
    t.phone.realtime.setState({ requests: { [REQUEST.id]: pending } });
    expect(await t.phone.decide(AGENT, REQUEST, 'deny')).toMatchObject({ ok: true });
    expect(machineUsage(t.phone.usage.getState(), AGENT)).toEqual({
      approvals: 0,
      denials: 0,
      sessions: 1,
    });
    t.phone.realtime.setState({
      requests: {
        [REQUEST.id]: {
          ...pending,
          result: { t: 'decision_result', requestId: REQUEST.id, result: 'accepted' },
        },
      },
    });
    expect(t.phone.usage.getState().machines[AGENT]).toEqual({
      api: { approvals: 0, denials: 1, sessions: 1 },
    });
  });

  it('releases to the terminal without a passkey and never counts it (M1-03, M1-11)', async () => {
    const credentials = mockCredentials();
    try {
      await releaseUncounted(credentials.get);
    } finally {
      credentials.restore();
    }
  });

  async function releaseUncounted(get: ReturnType<typeof mockCredentials>['get']): Promise<void> {
    const t = await setup();
    await t.online();
    const decide = vi.spyOn(t.phone.client!, 'decide').mockReturnValue(undefined);
    const pending = {
      machineId: AGENT,
      request: { ...REQUEST, project: 'api' },
      deadline: t.timer.now() + 60_000,
      status: 'pending',
    } as const;
    t.phone.realtime.setState({ requests: { [REQUEST.id]: pending } });
    const result = await t.phone.release(AGENT, REQUEST);
    expect(result).toMatchObject({ ok: true, asserted: false });
    expect(get).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledWith(
      AGENT,
      expect.objectContaining({ kind: 'terminal', payload: null, request_id: REQUEST.id }),
      undefined,
    );
    t.phone.realtime.setState({
      requests: {
        [REQUEST.id]: {
          ...pending,
          result: { t: 'decision_result', requestId: REQUEST.id, result: 'accepted' },
        },
      },
    });
    expect(machineUsage(t.phone.usage.getState(), AGENT)).toMatchObject({
      approvals: 0,
      denials: 0,
    });
  }

  it.each(['allow', 'always'] as const)(
    'sends %s with a passkey assertion and its hash',
    async (kind) => {
      const credentials = mockCredentials();
      try {
        const relay = assertingRelay();
        const t = await setup(relay);
        await t.online();
        const decide = vi.spyOn(t.phone.client!, 'decide');
        const result = await t.phone.decide(AGENT, REQUEST, kind);
        expect(result).toMatchObject({ ok: true, asserted: true });
        expect(credentials.get).toHaveBeenCalledOnce();
        expect(decide).toHaveBeenCalledWith(
          AGENT,
          expect.objectContaining({ kind, payload: null }),
          result.ok ? result.decisionHash : 'never',
        );
      } finally {
        credentials.restore();
      }
    },
  );

  it.each([
    ['session', null],
    ['localSettings', 'localSettings'],
    ['projectSettings', 'projectSettings'],
  ] as const)('signs "Always" to %s in the payload (M2-07)', async (destination, payload) => {
    const credentials = mockCredentials();
    try {
      const t = await setup(assertingRelay());
      await t.online();
      const decide = vi.spyOn(t.phone.client!, 'decide');
      await t.phone.decide(AGENT, REQUEST, 'always', destination);
      expect(decide).toHaveBeenCalledWith(
        AGENT,
        expect.objectContaining({ kind: 'always', payload }),
        expect.any(String),
      );
    } finally {
      credentials.restore();
    }
  });

  it('sends nothing when the user cancels the passkey sheet', async () => {
    const credentials = mockCredentials();
    credentials.get.mockRejectedValueOnce(userCancelled());
    try {
      const t = await setup(assertingRelay());
      await t.online();
      const decide = vi.spyOn(t.phone.client!, 'decide');
      await expect(t.phone.decide(AGENT, REQUEST, 'allow')).resolves.toEqual({
        ok: false,
        failure: 'cancelled',
      });
      expect(decide).not.toHaveBeenCalled();
      // Disconnecting forgets the bound device id.
      t.phone.disconnect();
      await expect(t.phone.decide(AGENT, REQUEST, 'deny')).resolves.toMatchObject({ ok: false });
    } finally {
      credentials.restore();
    }
  });

  it('answers a question with the encoded payload and a passkey assertion (M1-01)', async () => {
    const credentials = mockCredentials();
    try {
      const t = await setup(assertingRelay());
      await t.online();
      const decide = vi.spyOn(t.phone.client!, 'decide');
      const question: Question = {
        id: REQUEST.id,
        sessionId: REQUEST.sessionId,
        requestHash: 'b'.repeat(64),
        expiresAt: REQUEST.expiresAt,
        questions: [{ text: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multi: false }],
      };
      const answer = { answers: [{ labels: ['A'] }], response: 'Thanks' };
      const pending = {
        machineId: AGENT,
        kind: 'question',
        request: question,
        deadline: t.timer.now() + 60_000,
        status: 'pending',
      } as const;
      t.phone.realtime.setState({ requests: { [REQUEST.id]: pending } });
      const result = await t.phone.answer(AGENT, question, answer);
      expect(result).toMatchObject({ ok: true, asserted: true });
      expect(credentials.get).toHaveBeenCalledOnce();
      expect(decide).toHaveBeenCalledWith(
        AGENT,
        expect.objectContaining({
          kind: 'answer',
          request_id: question.id,
          request_hash: question.requestHash,
          payload: encodeAnswerPayload(answer),
        }),
        result.ok ? result.decisionHash : 'never',
      );
      // An answer is neither an approval nor a denial; only the asking session counts.
      t.phone.realtime.setState({
        requests: {
          [REQUEST.id]: {
            ...pending,
            result: { t: 'decision_result', requestId: REQUEST.id, result: 'accepted' },
          },
        },
      });
      expect(machineUsage(t.phone.usage.getState(), AGENT)).toEqual({
        approvals: 0,
        denials: 0,
        sessions: 1,
      });
    } finally {
      credentials.restore();
    }
  });

  it('refuses an answer while not connected', async () => {
    const t = await setup();
    const question: Question = {
      id: REQUEST.id,
      sessionId: REQUEST.sessionId,
      requestHash: 'b'.repeat(64),
      expiresAt: 0,
      questions: [{ text: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multi: false }],
    };
    await expect(
      t.phone.answer(AGENT, question, { answers: [{ labels: ['A'] }] }),
    ).resolves.toEqual({ ok: false, failure: 'offline' });
  });

  const REPOSITORY: Repository = {
    id: 'repo-api',
    machineId: AGENT,
    name: 'api',
    path: '/Users/me/code/api',
  };

  it('starts a session with a passkey: repository id in the payload, hash over prompt and path (M1-04)', async () => {
    const credentials = mockCredentials();
    try {
      const t = await setup(assertingRelay());
      await t.online();
      t.phone.realtime.setState({ relayOffset: 90_000 });
      const command = vi.spyOn(t.phone.client!, 'command');
      const result = await t.phone.start(AGENT, REPOSITORY, 'Fix the tests');
      expect(result).toMatchObject({ ok: true, asserted: true });
      expect(credentials.get).toHaveBeenCalledOnce();
      const issuedAt = Math.floor((t.timer.now() + 90_000) / 1000);
      expect(command).toHaveBeenCalledWith(
        AGENT,
        {
          t: 'start',
          start: { machineId: AGENT, repositoryId: 'repo-api', prompt: 'Fix the tests' },
          decision: {
            v: 1,
            kind: 'start',
            request_id: result.requestId,
            request_hash: await requestHash({ prompt: 'Fix the tests', cwd: REPOSITORY.path }),
            payload: 'repo-api',
            issued_at: issuedAt,
            expires_at: issuedAt + DECISION_TTL_SECONDS,
            phone_device_id: PHONE,
            agent_device_id: AGENT,
          },
        },
        result.ok ? result.decisionHash : 'never',
      );
      // A fresh request id per start, tracked until the agent answers.
      const again = await t.phone.start(AGENT, REPOSITORY, 'Fix the tests');
      expect(again.requestId).not.toBe(result.requestId);
      expect(t.phone.realtime.getState().commands[result.requestId]).toEqual({
        machineId: AGENT,
        kind: 'start',
        target: 'repo-api',
        text: 'Fix the tests',
      });
    } finally {
      credentials.restore();
    }
  });

  it('binds a picked permission mode into the start and its hash, and sends default as none (M2-09)', async () => {
    const credentials = mockCredentials();
    try {
      const t = await setup(assertingRelay());
      await t.online();
      const command = vi.spyOn(t.phone.client!, 'command');
      await t.phone.start(AGENT, REPOSITORY, 'Plan it', 'plan');
      const [, sent] = command.mock.calls[0]!;
      expect(sent).toMatchObject({
        t: 'start',
        start: { repositoryId: 'repo-api', prompt: 'Plan it', permissionMode: 'plan' },
        decision: {
          request_hash: await requestHash({
            prompt: 'Plan it',
            cwd: REPOSITORY.path,
            permissionMode: 'plan',
          }),
        },
      });
      await t.phone.start(AGENT, REPOSITORY, 'Go', 'default');
      const [, plain] = command.mock.calls[1]!;
      expect(plain).toMatchObject({
        decision: { request_hash: await requestHash({ prompt: 'Go', cwd: REPOSITORY.path }) },
      });
      expect(plain.t === 'start' && 'permissionMode' in plain.start).toBe(false);
    } finally {
      credentials.restore();
    }
  });

  it('sends a follow-up with a passkey: text in the payload, hash over prompt and session (M1-04)', async () => {
    const credentials = mockCredentials();
    try {
      const t = await setup(assertingRelay());
      await t.online();
      const command = vi.spyOn(t.phone.client!, 'command');
      const result = await t.phone.instruct(AGENT, REQUEST.sessionId, 'Now run lint');
      expect(result).toMatchObject({ ok: true, asserted: true });
      const [machineId, message, decisionHash] = command.mock.calls[0]!;
      expect([machineId, decisionHash]).toEqual([AGENT, result.ok ? result.decisionHash : 'never']);
      expect(message).toMatchObject({
        t: 'instruct',
        instruction: { sessionId: REQUEST.sessionId, text: 'Now run lint' },
        decision: {
          kind: 'instruct',
          request_id: result.requestId,
          request_hash: await requestHash({ prompt: 'Now run lint', sessionId: REQUEST.sessionId }),
          payload: 'Now run lint',
        },
      });
    } finally {
      credentials.restore();
    }
  });

  it('sends no start or follow-up when offline or cancelled', async () => {
    const credentials = mockCredentials();
    credentials.get.mockRejectedValueOnce(userCancelled());
    try {
      const t = await setup(assertingRelay());
      await expect(t.phone.start(AGENT, REPOSITORY, 'Go')).resolves.toMatchObject({
        ok: false,
        failure: 'offline',
      });
      await t.online();
      const command = vi.spyOn(t.phone.client!, 'command');
      await expect(t.phone.instruct(AGENT, 's-1', 'Go')).resolves.toMatchObject({
        ok: false,
        failure: 'cancelled',
      });
      expect(command).not.toHaveBeenCalled();
      expect(t.phone.realtime.getState().commands).toEqual({});
    } finally {
      credentials.restore();
    }
  });

  it('schedules on its clock', async () => {
    const t = await setup();
    const callback = vi.fn();
    t.phone.after(1000, callback);
    t.timer.advance(1000);
    expect(callback).toHaveBeenCalledOnce();
  });
});

describe('phoneNameFrom', () => {
  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone'],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', 'iPad'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9)', 'Android phone'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'Phone'],
  ])('%s → %s', (userAgent, name) => {
    expect(phoneNameFrom(userAgent)).toBe(name);
  });
});

describe('relaySocketUrl', () => {
  it('uses wss next to an https page and ws next to http', () => {
    expect(relaySocketUrl({ protocol: 'https:', host: 'rc.example.com' })).toBe(
      'wss://rc.example.com/ws',
    );
    expect(relaySocketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/ws',
    );
  });
});
