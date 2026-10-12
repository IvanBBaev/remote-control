// Security properties of the M0-06 roadmap list (ROADMAP §4 M0-06), each tagged with the
// 02 §7.1 property it implements where one exists (P1–P6; P7–P12 of 02 belong to other
// packages). fast-check drives the ones with a meaningful input space.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CryptoError,
  MAX_FRAME_BYTES,
  MAX_PLAINTEXT_BYTES,
  PADDING_BLOCK,
  sessionPrologue,
  TransportSession,
  type EnvelopeHeader,
} from './index.js';
import {
  AGENT,
  header,
  kkHandshake,
  kkSessions,
  OTHER,
  pairingStates,
  PHONE,
  staticKey,
  USER,
} from '../test/support.js';

const code = (expected: string) =>
  expect.objectContaining({ name: 'CryptoError', code: expected }) as unknown;

const RUNS = { numRuns: 25 };

function flipBit(bytes: Uint8Array, bit: number): Uint8Array {
  const out = Uint8Array.from(bytes);
  const index = Math.floor(bit / 8) % out.length;
  out[index] = (out[index] as number) ^ (1 << (bit % 8));
  return out;
}

describe('replay (P2)', () => {
  it('rejects a frame delivered twice and closes the session', async () => {
    const { phone, agent } = await kkSessions();
    const frame = await phone.encrypt(header(), Uint8Array.of(1, 2, 3));
    expect(await agent.decrypt(header(), frame)).toEqual(Uint8Array.of(1, 2, 3));
    await expect(agent.decrypt(header(), frame)).rejects.toEqual(code('decrypt_failed'));
    expect(agent.closed).toBe(true);
  });
});

describe('reorder (P2)', () => {
  it('accepts only the order n, n+1, …; any other first frame is rejected', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (skip) => {
        const { phone, agent } = await kkSessions();
        const frames = [];
        for (let i = 0; i <= skip; i++) {
          frames.push(await phone.encrypt(header({ seq: i }), Uint8Array.of(i)));
        }
        await expect(
          agent.decrypt(header({ seq: skip }), frames[skip] as Uint8Array),
        ).rejects.toEqual(code('decrypt_failed'));
        // Once rejected, even the correct next frame is refused: the session is dead.
        await expect(agent.decrypt(header({ seq: 0 }), frames[0] as Uint8Array)).rejects.toEqual(
          code('session_closed'),
        );
      }),
      RUNS,
    );
  });

  it('delivers in-order frames, also when encrypt and decrypt calls overlap', async () => {
    const { phone, agent } = await kkSessions();
    const count = 20;
    const frames = await Promise.all(
      Array.from({ length: count }, (_, i) => phone.encrypt(header({ seq: i }), Uint8Array.of(i))),
    );
    const plaintexts = await Promise.all(
      frames.map((frame, i) => agent.decrypt(header({ seq: i }), frame)),
    );
    expect(plaintexts.map((p) => p[0])).toEqual(Array.from({ length: count }, (_, i) => i));
  });
});

describe('truncation (P1)', () => {
  it('rejects any truncated or extended frame', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 600 }),
        fc.integer({ min: -2000, max: 64 }),
        async (plaintext, delta) => {
          fc.pre(delta !== 0);
          const { phone, agent } = await kkSessions();
          const frame = await phone.encrypt(header(), plaintext);
          const changed =
            delta < 0
              ? frame.subarray(0, Math.max(0, frame.length + delta))
              : Uint8Array.from([...frame, ...new Uint8Array(delta)]);
          await expect(agent.decrypt(header(), changed)).rejects.toBeInstanceOf(CryptoError);
          expect(agent.closed).toBe(true);
        },
      ),
      RUNS,
    );
  });
});

describe('cross-session (P3)', () => {
  it('rejects a frame recorded under session S when replayed under S′ of the same peers', async () => {
    const phoneStatic = await staticKey(1);
    const agentStatic = await staticKey(2);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 100, max: 1_000_000 }), async (seed) => {
        const first = await kkSessions({ phoneStatic, agentStatic, seed });
        const frame = await first.phone.encrypt(header(), Uint8Array.of(9));
        // Reconnect: a new handshake with fresh ephemerals ("rekey on reconnect").
        first.phone.close();
        const second = await kkSessions({ phoneStatic, agentStatic, seed: seed + 2 });
        expect(second.agent.handshakeHash).not.toEqual(first.agent.handshakeHash);
        await expect(second.agent.decrypt(header(), frame)).rejects.toEqual(code('decrypt_failed'));
      }),
      RUNS,
    );
  });

  it('refuses to use a session after close (the old connection cannot be revived)', async () => {
    const { phone } = await kkSessions();
    phone.close();
    await expect(phone.encrypt(header(), Uint8Array.of(1))).rejects.toEqual(code('session_closed'));
  });
});

describe('peer swap (P4)', () => {
  const swaps: readonly [string, Partial<EnvelopeHeader>][] = [
    ['from/to swapped', { from: AGENT, to: PHONE }],
    ['re-addressed to another device', { to: OTHER }],
    ['fanned out (to = null)', { to: null }],
    ['moved to another session', { session: '0190a1b2-2222-7000-8000-000000000002' }],
    ['session removed', { session: null }],
  ];

  it.each(swaps)('rejects a frame whose header was %s', async (_label, change) => {
    const { phone, agent } = await kkSessions();
    const frame = await phone.encrypt(header(), Uint8Array.of(1));
    await expect(agent.decrypt(header(change), frame)).rejects.toEqual(code('decrypt_failed'));
  });

  it('rejects a frame reflected back to its sender', async () => {
    const { phone } = await kkSessions();
    const frame = await phone.encrypt(header(), Uint8Array.of(1));
    await expect(phone.decrypt(header(), frame)).rejects.toEqual(code('decrypt_failed'));
  });

  it('rejects a frame from a different peer of the same user', async () => {
    const real = await kkSessions({ phoneStatic: await staticKey(1) });
    const other = await kkSessions({ phoneStatic: await staticKey(3) });
    const frame = await other.phone.encrypt(header(), Uint8Array.of(1));
    await expect(real.agent.decrypt(header(), frame)).rejects.toEqual(code('decrypt_failed'));
  });
});

describe('wrong PSK (P6)', () => {
  it('aborts the pairing at message 1, before either static key is learned', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 32, maxLength: 32 }), async (psk) => {
        fc.pre(psk.some((byte) => byte !== 0x42));
        const { phone, agent } = await pairingStates({ phonePsk: psk });
        const message1 = await phone.writeMessage();
        await expect(agent.readMessage(message1)).rejects.toEqual(code('handshake_failed'));
        expect(agent.remoteStaticPublicKey).toBeUndefined();
        expect(phone.remoteStaticPublicKey).toBeUndefined();
        await expect(agent.writeMessage()).rejects.toEqual(code('handshake_failed'));
      }),
      RUNS,
    );
  });

  it('completes and authenticates both statics with the right PSK', async () => {
    const { phone, agent, phoneStatic, agentStatic } = await pairingStates();
    await agent.readMessage(await phone.writeMessage());
    await phone.readMessage(await agent.writeMessage());
    await agent.readMessage(await phone.writeMessage());
    expect(phone.result().remoteStaticPublicKey).toEqual(agentStatic.publicKey);
    expect(agent.result().remoteStaticPublicKey).toEqual(phoneStatic.publicKey);
  });
});

describe('wrong prologue', () => {
  it('fails a KK handshake whose ends disagree on user or devices', async () => {
    const ids = fc.constantFrom(USER, PHONE, AGENT, OTHER);
    await fc.assert(
      fc.asyncProperty(ids, ids, ids, async (userId, phoneDeviceId, agentDeviceId) => {
        const prologue = sessionPrologue({ userId, phoneDeviceId, agentDeviceId });
        fc.pre(userId !== USER || phoneDeviceId !== PHONE || agentDeviceId !== AGENT);
        await expect(kkHandshake({ phonePrologue: prologue })).rejects.toEqual(
          code('handshake_failed'),
        );
      }),
      { numRuns: 10 },
    );
  });

  it('fails an XXpsk0 pairing with a different prologue', async () => {
    const { phone, agent } = await pairingStates({ agentPrologue: Uint8Array.of(9) });
    await expect(agent.readMessage(await phone.writeMessage())).rejects.toEqual(
      code('handshake_failed'),
    );
  });
});

describe('padding (P5)', () => {
  it('gives equal frame lengths within one 256-byte bucket', async () => {
    const { phone } = await kkSessions();
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: MAX_PLAINTEXT_BYTES }),
        fc.integer({ min: 0, max: MAX_PLAINTEXT_BYTES }),
        async (a, b) => {
          const frameA = await phone.encrypt(header(), new Uint8Array(a));
          const frameB = await phone.encrypt(header(), new Uint8Array(b));
          const bucket = (n: number): number => Math.ceil((n + 4) / PADDING_BLOCK);
          expect(frameA.length === frameB.length).toBe(bucket(a) === bucket(b));
          expect((frameA.length - 16) % PADDING_BLOCK).toBe(0);
        },
      ),
      RUNS,
    );
  });

  it('round-trips any plaintext up to the limit', async () => {
    const { phone, agent } = await kkSessions();
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 2048 }), async (plaintext) => {
        expect(await agent.decrypt(header(), await phone.encrypt(header(), plaintext))).toEqual(
          plaintext,
        );
      }),
      RUNS,
    );
  });
});

describe('max frame', () => {
  it('sends the largest plaintext in one frame of at most 64 KiB', async () => {
    const { phone, agent } = await kkSessions();
    const plaintext = new Uint8Array(MAX_PLAINTEXT_BYTES).fill(7);
    const frame = await phone.encrypt(header(), plaintext);
    expect(frame.length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(await agent.decrypt(header(), frame)).toEqual(plaintext);
  });

  it('refuses a larger plaintext without closing the session', async () => {
    const { phone } = await kkSessions();
    await expect(phone.encrypt(header(), new Uint8Array(MAX_PLAINTEXT_BYTES + 1))).rejects.toEqual(
      code('frame_too_large'),
    );
    expect(phone.closed).toBe(false);
  });

  it('rejects an incoming frame over 64 KiB and closes the session', async () => {
    const { agent } = await kkSessions();
    await expect(agent.decrypt(header(), new Uint8Array(MAX_FRAME_BYTES + 1))).rejects.toEqual(
      code('frame_too_large'),
    );
    expect(agent.closed).toBe(true);
  });
});

describe('nonce exhaustion', () => {
  it('stops at the message limit and forces a re-handshake', async () => {
    const { phone, agent } = await kkSessions({ messageLimit: 3 });
    for (let i = 0; i < 3; i++) {
      await agent.decrypt(
        header({ seq: i }),
        await phone.encrypt(header({ seq: i }), Uint8Array.of(i)),
      );
    }
    await expect(phone.encrypt(header({ seq: 3 }), Uint8Array.of(3))).rejects.toEqual(
      code('nonce_exhausted'),
    );
    expect(phone.closed).toBe(true);
    await expect(agent.decrypt(header({ seq: 3 }), new Uint8Array(272))).rejects.toEqual(
      code('nonce_exhausted'),
    );
    expect(agent.closed).toBe(true);
  });
});

describe('AAD tamper (P1)', () => {
  it('rejects any single-bit change of the ciphertext', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 300 }), fc.nat(), async (plaintext, bit) => {
        const { phone, agent } = await kkSessions();
        const frame = await phone.encrypt(header(), plaintext);
        await expect(agent.decrypt(header(), flipBit(frame, bit))).rejects.toEqual(
          code('decrypt_failed'),
        );
        expect(agent.closed).toBe(true);
      }),
      RUNS,
    );
  });

  it('rejects any change to a header field (the AAD)', async () => {
    const change = fc.oneof(
      fc.nat().map((seq) => ({ seq: seq + 1 })),
      fc.integer({ min: 1, max: 2 ** 40 }).map((ts) => ({ ts: 1_760_000_000_000 + ts })),
      fc.integer({ min: 0, max: 2 ** 40 }).map((expiresAt) => ({ expiresAt })),
      fc.constantFrom('reply', 'command', 'event', 'control').map((cls) => ({ cls }) as const),
      fc.uuid().map((id) => ({ id })),
      fc.uuid().map((replyTo) => ({ replyTo })),
    );
    await fc.assert(
      fc.asyncProperty(change, async (overrides) => {
        fc.pre(!('id' in overrides) || overrides.id !== header().id);
        const { phone, agent } = await kkSessions();
        const frame = await phone.encrypt(header(), Uint8Array.of(5));
        await expect(agent.decrypt(header(overrides), frame)).rejects.toEqual(
          code('decrypt_failed'),
        );
      }),
      RUNS,
    );
  });

  it('rejects a frame whose counter differs from the receiver’s (strict nonce)', async () => {
    const { phone, agent } = await kkSessions();
    await phone.encrypt(header(), Uint8Array.of(0)); // frame 0 never delivered
    const frame1 = await phone.encrypt(header(), Uint8Array.of(1));
    await expect(agent.decrypt(header(), frame1)).rejects.toEqual(code('decrypt_failed'));
  });
});

describe('revocation', () => {
  it('rejects a KK handshake from a phone whose static key is no longer trusted', async () => {
    const revokedPhone = await staticKey(1);
    const currentPhone = await staticKey(5);
    await expect(
      kkHandshake({ phoneStatic: revokedPhone, agentExpectsPhone: currentPhone.publicKey }),
    ).rejects.toEqual(code('handshake_failed'));
  });

  it('rejects queued and later frames once the session is closed', async () => {
    const { phone, agent } = await kkSessions();
    const frames = [
      await phone.encrypt(header(), Uint8Array.of(0)),
      await phone.encrypt(header(), Uint8Array.of(1)),
    ];
    const first = agent.decrypt(header(), frames[0] as Uint8Array);
    agent.close(); // revoked while frame 0 is still queued
    await expect(first).rejects.toEqual(code('session_closed'));
    await expect(agent.decrypt(header(), frames[1] as Uint8Array)).rejects.toEqual(
      code('session_closed'),
    );
  });

  it('exposes the authenticated peer key and handshake hash of the session', async () => {
    const phoneStatic = await staticKey(1);
    const { phone, agent } = await kkHandshake({ phoneStatic });
    const session = TransportSession.fromHandshake(agent);
    expect(session.remoteStaticPublicKey).toEqual(phoneStatic.publicKey);
    expect(session.handshakeHash).toEqual(phone.handshakeHash);
    const anonymous = TransportSession.fromHandshake({
      ...agent,
      remoteStaticPublicKey: undefined,
    });
    expect(anonymous.remoteStaticPublicKey).toBeUndefined();
  });
});
