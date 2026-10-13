import { afterEach, describe, expect, it } from 'vitest';

import type { KeyStore } from '../ports/key-store.js';
import { createAgentProbe } from './agent-probe.js';
import { startHookReceiver, type HookReceiver } from './hook-receiver.js';

const TOKEN = 'probe-token-0123456789';

function keyStore(endpoint: { port: number; token: string } | undefined | Error): KeyStore {
  return {
    readHookEndpoint: () =>
      endpoint instanceof Error
        ? Promise.reject(endpoint)
        : Promise.resolve(endpoint === undefined ? undefined : { ...endpoint, generation: 1 }),
  } as Partial<KeyStore> as KeyStore;
}

const globalFetch = (url: string, init?: RequestInit) => fetch(url, init);

describe('createAgentProbe (M1-07)', () => {
  let receiver: HookReceiver | undefined;

  afterEach(async () => {
    await receiver?.close();
    receiver = undefined;
  });

  async function start(): Promise<number> {
    receiver = await startHookReceiver({
      port: 0,
      token: TOKEN,
      defaultHookTimeoutMs: 1_000,
      handler: () => Promise.resolve({ status: 204 }),
    });
    return receiver.port;
  }

  it('reads a running agent as alive through the global fetch', async () => {
    const port = await start();
    const probe = createAgentProbe({
      keyStore: keyStore({ port, token: TOKEN }),
      fetch: globalFetch,
    });
    expect(await probe()).toBe(true);
  });

  it('reads a wrong token as not running', async () => {
    const port = await start();
    const probe = createAgentProbe({
      keyStore: keyStore({ port, token: 'stale-token' }),
      fetch: globalFetch,
    });
    expect(await probe()).toBe(false);
  });

  it('reads a closed port as not running', async () => {
    const port = await start();
    await receiver!.close();
    receiver = undefined;
    const probe = createAgentProbe({
      keyStore: keyStore({ port, token: TOKEN }),
      fetch: globalFetch,
    });
    expect(await probe()).toBe(false);
  });

  it('reads a missing or unreadable endpoint file as not running', async () => {
    const fetchNever = () => Promise.reject(new Error('no request expected'));
    expect(await createAgentProbe({ keyStore: keyStore(undefined), fetch: fetchNever })()).toBe(
      false,
    );
    expect(
      await createAgentProbe({ keyStore: keyStore(new Error('EACCES')), fetch: fetchNever })(),
    ).toBe(false);
  });
});
