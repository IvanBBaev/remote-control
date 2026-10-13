import { describe, expect, it } from 'vitest';

import { accountDeletionChallenge, accountDeletionHash } from './account-deletion.js';

const USER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

describe('accountDeletionHash', () => {
  it('is the SHA-256 of the canonical deletion object', async () => {
    const expected = Buffer.from(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`{"action":"delete_account","userId":"${USER}"}`),
      ),
    );
    expect(await accountDeletionHash(USER)).toBe(expected.toString('hex'));
    expect(await accountDeletionChallenge(USER)).toBe(expected.toString('base64url'));
  });

  it('differs per account', async () => {
    expect(await accountDeletionHash(USER)).not.toBe(
      await accountDeletionHash('00000000-0000-4000-8000-000000000000'),
    );
  });
});
