import { decisionHash, VERSION_TABLE } from '@remote-control/protocol';
import type { CanonicalDecision } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import { authorizeWithoutPasskey, deleteAccountWithoutPasskey } from './authorize';

function decision(kind: CanonicalDecision['kind']): CanonicalDecision {
  return {
    v: VERSION_TABLE.v,
    kind,
    request_id: 'r-1',
    request_hash: 'a'.repeat(64),
    payload: null,
    issued_at: 1_800_000_000,
    expires_at: 1_800_000_060,
    phone_device_id: 'phone',
    agent_device_id: 'agent',
  };
}

describe('authorizeWithoutPasskey', () => {
  it('sends a deny and a terminal release with their hash, unasserted', async () => {
    for (const kind of ['deny', 'terminal'] as const) {
      expect(await authorizeWithoutPasskey(decision(kind))).toEqual({
        ok: true,
        decisionHash: await decisionHash(decision(kind)),
        asserted: false,
      });
    }
  });

  it('refuses every kind that needs a passkey', async () => {
    for (const kind of ['allow', 'always', 'answer'] as const) {
      expect(await authorizeWithoutPasskey(decision(kind))).toEqual({
        ok: false,
        failure: 'cancelled',
      });
    }
  });
});

describe('deleteAccountWithoutPasskey', () => {
  it('refuses', async () => {
    expect(await deleteAccountWithoutPasskey()).toEqual({ ok: false, failure: 'cancelled' });
  });
});
