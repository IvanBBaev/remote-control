import { afterEach, describe, expect, it } from 'vitest';

import { memoryPasskeyKeys, storagePasskeyKeys } from './passkey-keys.js';
import type { PasskeyKeys } from './passkey-keys.js';

const PASSKEY = { id: 'cred-1', publicKey: 'spki-1', rpId: 'rc.test' };

afterEach(() => {
  window.localStorage.clear();
});

describe.each([
  ['storagePasskeyKeys', () => storagePasskeyKeys(() => window.localStorage)],
  ['memoryPasskeyKeys', () => memoryPasskeyKeys()],
] as const)('%s', (_name, create: () => PasskeyKeys) => {
  it('keeps each account its own keys', () => {
    const keys = create();
    keys.add('user-1', PASSKEY);
    keys.add('user-2', { ...PASSKEY, id: 'cred-2' });
    expect(keys.list('user-1')).toEqual([PASSKEY]);
    expect(keys.list('user-2')).toEqual([{ ...PASSKEY, id: 'cred-2' }]);
    expect(keys.list('user-3')).toEqual([]);
  });

  it('replaces a re-added credential and keeps the 16 newest', () => {
    const keys = create();
    for (let i = 0; i < 20; i++) keys.add('user-1', { ...PASSKEY, id: `cred-${i}` });
    keys.add('user-1', { ...PASSKEY, id: 'cred-19', publicKey: 'spki-new' });
    const listed = keys.list('user-1');
    expect(listed).toHaveLength(16);
    expect(listed[0]?.id).toBe('cred-4');
    expect(listed.at(-1)).toEqual({ ...PASSKEY, id: 'cred-19', publicKey: 'spki-new' });
  });
});

describe('storagePasskeyKeys', () => {
  it('survives a reload', () => {
    storagePasskeyKeys(() => window.localStorage).add('user-1', PASSKEY);
    expect(storagePasskeyKeys(() => window.localStorage).list('user-1')).toEqual([PASSKEY]);
  });

  it('drops what does not parse', () => {
    window.localStorage.setItem(
      'rc.auth.passkeys',
      JSON.stringify({ 'user-1': [{ id: 'x' }], 'user-2': [PASSKEY] }),
    );
    const keys = storagePasskeyKeys(() => window.localStorage);
    expect(keys.list('user-1')).toEqual([]);
    expect(keys.list('user-2')).toEqual([PASSKEY]);
    window.localStorage.setItem('rc.auth.passkeys', '{not json');
    expect(keys.list('user-2')).toEqual([]);
  });

  it('is a no-op without storage or when it throws', () => {
    const missing = storagePasskeyKeys(() => undefined);
    missing.add('user-1', PASSKEY);
    expect(missing.list('user-1')).toEqual([]);
    const blocked = storagePasskeyKeys(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(() => blocked.add('user-1', PASSKEY)).not.toThrow();
    expect(blocked.list('user-1')).toEqual([]);
  });
});
