import { webCryptoRandom } from '@remote-control/crypto';
import { toBase64Url, type Random } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import type { StoredPasskey } from '../ports/account-store.js';
import { encodeCbor } from '../testing/cbor.js';
import { SoftwareAuthenticator } from '../testing/software-authenticator.js';
import { createScryptSecretHasher } from './scrypt-secret-hasher.js';
import { createSimpleWebAuthn } from './simple-webauthn.js';

const RP = { id: 'rc.example.test', origin: 'https://rc.example.test', name: 'remote-control' };
const zeros: Random = { bytes: (n) => new Uint8Array(n) };

describe('createScryptSecretHasher', () => {
  const hasher = createScryptSecretHasher(webCryptoRandom);

  it('hashes with a random salt and verifies only the same secret', async () => {
    const first = await hasher.hash('secret');
    const second = await hasher.hash('secret');
    expect(first).toMatch(/^scrypt\$N=32768,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('secret');
    expect(await hasher.verify('secret', first)).toBe(true);
    expect(await hasher.verify('Secret', first)).toBe(false);
  });

  it('takes the salt from the Random port', async () => {
    const fixed = createScryptSecretHasher(zeros);
    expect(await fixed.hash('a')).toBe(await fixed.hash('a'));
  });

  it('rejects malformed encodings without throwing', async () => {
    const good = await hasher.hash('secret');
    const [salt, key] = good.split('$').slice(2);
    for (const encoded of [
      '',
      `scrypt$N=16384,r=8,p=1$${salt}$${key}`,
      `scrypt$N=32768,r=8,p=1$${salt}`,
      `scrypt$N=32768,r=8,p=1$${salt}$${key}$extra`,
      `scrypt$N=32768,r=8,p=1$${salt}$${key!.slice(4)}`,
      `scrypt$N=32768,r=8,p=1$sa+lt$${key}`,
      `scrypt$N=32768,r=8,p=1$${salt}$ke/y`,
    ]) {
      expect(await hasher.verify('secret', encoded)).toBe(false);
    }
  });
});

describe('createSimpleWebAuthn', () => {
  const webauthn = createSimpleWebAuthn(RP);

  it('returns null for responses it cannot read or verify', async () => {
    const authenticator = new SoftwareAuthenticator(RP.id, RP.origin);
    const options = await webauthn.registrationOptions({
      userId: new Uint8Array(16),
      userName: 'remote-control',
      challenge: new Uint8Array(32),
      excludeCredentialIds: ['AAAA'],
    });
    expect(options.excludeCredentials).toEqual([{ id: 'AAAA', type: 'public-key' }]);
    const response = await authenticator.create(options);
    expect(webauthn.challengeOf(response)).toBe(options.challenge);
    const notJson = toBase64Url(new TextEncoder().encode('not json'));
    expect(
      webauthn.challengeOf({
        ...response,
        response: { ...response.response, clientDataJSON: notJson },
      }),
    ).toBeNull();
    const numeric = toBase64Url(new TextEncoder().encode('{"challenge":1}'));
    expect(
      webauthn.challengeOf({
        ...response,
        response: { ...response.response, clientDataJSON: numeric },
      }),
    ).toBeNull();
    expect(await webauthn.verifyRegistration(response, 'other-challenge')).toBeNull();

    const passkey = await webauthn.verifyRegistration(response, options.challenge);
    expect(passkey).not.toBeNull();
    const stored: StoredPasskey = {
      ...passkey!,
      userId: '00000000-0000-0000-0000-000000000000',
      webauthnUserId: options.user.id,
      transports: ['internal'],
    };
    const login = await webauthn.authenticationOptions(new Uint8Array(32).fill(1));
    const assertion = await authenticator.get(login);
    expect(await webauthn.verifyAuthentication(assertion, 'other', stored)).toBeNull();
    expect(await webauthn.verifyAuthentication(assertion, login.challenge, stored)).toEqual({
      newCounter: 1,
      backedUp: true,
    });
  });
});

describe('SoftwareAuthenticator', () => {
  it('throws when asked for a credential it does not hold', async () => {
    const authenticator = new SoftwareAuthenticator(RP.id, RP.origin, false);
    const options = await createSimpleWebAuthn(RP).authenticationOptions(new Uint8Array(32));
    await expect(authenticator.get(options)).rejects.toThrow(/no credential/);
    expect(authenticator.credentialCount).toBe(0);
  });
});

describe('encodeCbor', () => {
  it('encodes every length class and negative ints', () => {
    expect([...encodeCbor(-1)]).toEqual([0x20]);
    expect([...encodeCbor(500)]).toEqual([0x19, 0x01, 0xf4]);
    expect(encodeCbor(new Uint8Array(0x10000))).toHaveLength(0x10000 + 5);
    expect([...encodeCbor(new Uint8Array(0x10000)).slice(0, 5)]).toEqual([0x5a, 0, 1, 0, 0]);
    expect([...encodeCbor({ a: 'b' })]).toEqual([0xa1, 0x61, 0x61, 0x61, 0x62]);
  });
});
