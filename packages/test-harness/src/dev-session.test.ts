import { afterEach, describe, expect, it } from 'vitest';

import { createDevSession, main, type DevSessionIo } from './dev-session.js';
import { createFakeClock } from './fake-clock.js';
import { startRelay, type HarnessRelay } from './relay.js';

/** The URL a fetch call targets, whatever form it was given in. */
function href(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function io(create: DevSessionIo['create']): DevSessionIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    create,
  };
}

describe('dev session (M4-03)', () => {
  let relay: HarnessRelay | undefined;
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it('registers with an invite and returns a session the relay accepts', async () => {
    relay = await startRelay({ clock: createFakeClock() });
    const { origin, url } = relay;
    // The harness relay listens on `url` but answers for `origin`; route one to the other.
    const routed: typeof fetch = (input, init) => fetch(href(input).replace(origin, url), init);

    const session = await createDevSession({
      relay: origin,
      inviteCode: await relay.mintInvite(),
      fetch: routed,
    });

    const check = await fetch(`${url}/api/auth/session`, {
      headers: { cookie: `__Host-rc_session=${session.token}` },
    });
    expect(check.status).toBe(200);
    expect(await check.json()).toEqual({ userId: session.userId });
  });

  it('fails on a refused invite', async () => {
    relay = await startRelay({ clock: createFakeClock() });
    const { origin, url } = relay;
    await expect(
      createDevSession({
        relay: origin,
        inviteCode: 'NOT-AN-INVITE',
        fetch: (input, init) => fetch(href(input).replace(origin, url), init),
      }),
    ).rejects.toThrow(/register\/options → 4\d\d/);
  });

  it('prints the token on stdout and nothing else', async () => {
    const run = io(() => Promise.resolve({ userId: 'u-1', token: 'tok' }));
    expect(await main(['--relay', 'http://localhost:3200', '--invite', 'X'], run)).toBe(0);
    expect(run.out).toEqual(['tok\n']);
    expect(run.err).toEqual(['dev-session: signed in as u-1\n']);
  });

  it('exits 1 when the relay refuses and 2 on bad arguments', async () => {
    const refused = io(() => Promise.reject(new Error('nope')));
    expect(await main(['--relay', 'http://x', '--invite', 'X'], refused)).toBe(1);
    expect(refused.err).toEqual(['dev-session: nope\n']);

    const create = () => Promise.reject(new Error('unreachable'));
    expect(await main(['--relay', 'http://x'], io(create))).toBe(2);
    expect(await main(['--bogus'], io(create))).toBe(2);
  });
});
