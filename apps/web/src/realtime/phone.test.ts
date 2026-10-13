import { pairingFingerprint } from '@remote-control/crypto';
import { describe, expect, it, vi } from 'vitest';

import { RelayError } from '../auth/relay-api.js';
import type { RelayApi } from '../auth/relay-api.js';
import { fakeRelay } from '../auth/test-credentials.js';
import { pairingSecrets } from '../pairing/pairing-code.js';
import { PairingError, phoneNameFrom, relaySocketUrl } from './phone.js';
import { PAIRING_TIMEOUT_MS } from './realtime-client.js';
import { createTestAgent } from './test-agent.js';
import { createTestPhone } from './test-phone.js';

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
