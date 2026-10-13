// @vitest-environment node
import { webCryptoRandom } from '@remote-control/crypto';
import { permissionRequestPayload } from '@remote-control/fake-claude-code';
import { SoftwareAuthenticator } from '@remote-control/relay/testing';
import {
  createFakeClock,
  eventually,
  startAgent,
  startRelay,
  type FakeClock,
  type HarnessAgent,
  type HarnessRelay,
} from '@remote-control/test-harness';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createRelayApi } from '../auth/relay-api.js';
import type { FetchLike } from '../auth/relay-api.js';
import { createIndexedDbKeyStore } from '../pairing/key-store.js';
import { createPhoneService } from './phone.js';
import type { PhoneService } from './phone.js';
import type { SocketFactory, SocketLike } from './relay-socket.js';

const SESSION_COOKIE = /__Host-rc_session=([^;]+);/;

/** The browser's same-origin `fetch`: origin headers and the session cookie, by hand. */
function sameOriginFetch(relay: HarnessRelay) {
  let cookie = '';
  const fetchImpl: FetchLike = async (input, init) => {
    const headers = new Headers(init.headers);
    headers.set('origin', relay.origin);
    headers.set('sec-fetch-site', 'same-origin');
    if (cookie !== '') headers.set('cookie', `__Host-rc_session=${cookie}`);
    const response = await fetch(input, {
      method: init.method ?? 'GET',
      headers,
      body: init.body ?? null,
      signal: init.signal ?? null,
    });
    const set = SESSION_COOKIE.exec(response.headers.get('set-cookie') ?? '');
    if (set !== null) cookie = set[1]!;
    return response;
  };
  return { fetchImpl, cookie: () => cookie };
}

/** The browser `WebSocket` on `ws`, sending what the browser would (origin, cookie). */
function nodeSockets(headers: () => Record<string, string>) {
  const opened: WebSocket[] = [];
  const create: SocketFactory = (url) => {
    const ws = new WebSocket(url, { headers: headers() });
    opened.push(ws);
    const socket: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (data) => {
        ws.send(data);
      },
      close: (code, reason) => {
        ws.close(code, reason);
      },
    };
    ws.on('open', () => socket.onopen?.(undefined));
    ws.on('message', (data: Buffer) => socket.onmessage?.({ data: data.toString('utf8') }));
    ws.on('close', () => socket.onclose?.(undefined));
    ws.on('error', () => socket.onerror?.(undefined));
    return socket;
  };
  return { create, opened };
}

interface Running {
  readonly clock: FakeClock;
  readonly relay: HarnessRelay;
  readonly agent: HarnessAgent;
  readonly phone: PhoneService;
  readonly sockets: WebSocket[];
  readonly userId: string;
}

/** The relay and agent in process; the PWA's own phone service, signed in and connected. */
async function start(): Promise<Running> {
  const clock = createFakeClock();
  const relay = await startRelay({ clock });
  const agent = await startAgent({ relayUrl: relay.wsOrigin, clock, name: 'Studio Mac' });
  const http = sameOriginFetch(relay);
  const api = createRelayApi(http.fetchImpl, { baseUrl: relay.url });
  const authenticator = new SoftwareAuthenticator(relay.rpId, relay.origin);
  const options = await api.registerOptions({ inviteCode: await relay.mintInvite() });
  const { userId } = await api.registerVerify(await authenticator.create(options));
  const sockets = nodeSockets(() => ({
    origin: relay.origin,
    cookie: `__Host-rc_session=${http.cookie()}`,
  }));
  const phone = createPhoneService({
    relay: api,
    keyStore: createIndexedDbKeyStore({ indexedDB: new IDBFactory(), random: webCryptoRandom }),
    timer: clock,
    random: webCryptoRandom,
    createSocket: sockets.create,
    url: `${relay.wsOrigin}/ws`,
    version: '0.0.0-harness',
    phoneName: 'iPhone',
  });
  await phone.connect(userId);
  await eventually(() => phone.realtime.getState().connection === 'open', 'phone: no hello_ok');
  return { clock, relay, agent, phone, sockets: sockets.opened, userId };
}

describe('PWA pairing against the in-process relay (M0-20 AC)', () => {
  let running: Running | undefined;
  const cleanup: (() => void)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0)) step();
    running?.phone.disconnect();
    await running?.agent.close();
    await running?.relay.close();
    running = undefined;
  });

  it(
    'pairs, decrypts the agent, and re-handshakes into the pending set after a drop',
    { timeout: 30_000 },
    async () => {
      running = await start();
      const { phone, agent, sockets } = running;

      // Enrol and sign the computer in, then pair with the code it prints (D6).
      const enrolled = await phone.enroll('Studio Mac');
      await agent.login(enrolled.enrollToken, running.userId);
      const pairing = agent.pair();
      const pending = await phone.pair(await pairing.code);
      expect(pending).toMatchObject({ agentDeviceId: enrolled.deviceId, name: 'Studio Mac' });
      // Both screens show the same fingerprint for the user to compare.
      await eventually(
        () => agent.stdout().includes(`Fingerprint: ${pending.fingerprint}`),
        'no fingerprint',
      );
      await pending.confirm();
      expect(await pairing.done).toBe(0);
      expect(await phone.pairedCount()).toBe(1);

      // `remotectl run`: the KK session opens and the snapshot decrypts on the phone.
      await agent.run();
      const machineOf = () => phone.realtime.getState().machines[enrolled.deviceId];
      await eventually(
        () => machineOf()?.machine !== null && machineOf()?.machine !== undefined,
        'no snapshot',
      );
      expect(machineOf()).toMatchObject({
        session: 'open',
        machine: { id: enrolled.deviceId, name: 'Studio Mac' },
      });

      // A permission request reaches the phone as a pending card.
      const endpoint = await agent.container.keyStore.readHookEndpoint();
      if (endpoint === undefined) throw new Error('agent: no hook endpoint');
      const hook = new AbortController();
      cleanup.push(() => {
        hook.abort();
      });
      const held = fetch(`http://127.0.0.1:${String(endpoint.port)}/hook`, {
        method: 'POST',
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(
          permissionRequestPayload(
            {
              sessionId: '0b6c4c1e-2f5d-4a8e-9a43-6c1f3f0d2a11',
              transcriptPath: `${agent.base}/transcript.jsonl`,
              cwd: agent.base,
              permissionMode: 'default',
            },
            { toolName: 'Bash', toolInput: { command: 'ls' } },
          ),
        ),
        signal: hook.signal,
      });
      held.catch(() => undefined);
      const pendingIds = () =>
        Object.entries(phone.realtime.getState().requests)
          .filter(([, view]) => view.status === 'pending')
          .map(([id]) => id);
      await eventually(() => pendingIds().length === 1, 'no request');
      const [requestId] = pendingIds();

      // The socket drops; the phone forgets the card to prove the agent sends it again.
      sockets.at(-1)!.terminate();
      await eventually(() => phone.realtime.getState().connection === 'reconnecting', 'no drop');
      phone.realtime.setState({ requests: {} });
      phone.wake();
      await eventually(() => phone.realtime.getState().connection === 'open', 'no reconnect');
      expect(sockets).toHaveLength(2);
      await eventually(() => pendingIds().length === 1, 'pending set not received');
      expect(pendingIds()).toEqual([requestId]);
      expect(machineOf()?.session).toBe('open');
    },
  );
});
