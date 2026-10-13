import { PGlite } from '@electric-sql/pglite';
import { webCryptoRandom } from '@remote-control/crypto';
import { createLogger, createMemoryDestination } from '@remote-control/log';
import { buildApp, DrainState } from '@remote-control/relay';
import {
  AccountService,
  AuditRecorder,
  createDrizzleAccountStore,
  createDrizzleAuditLog,
  createDrizzleDeviceDirectory,
  createDrizzleDeviceRegistry,
  createDrizzlePushSubscriptionStore,
  createPgliteDb,
  createScryptSecretHasher,
  createSimpleWebAuthn,
  createWebPushSender,
  DecisionVerifier,
  DEVICE_CAP,
  FakePushService,
  generateVapidKeys,
  LocalHub,
  mintInvites,
  MIGRATIONS_DIR,
  PairingService,
  PushNotifier,
  RelayRouter,
} from '@remote-control/relay/testing';

import type { FakeClock } from './fake-clock.js';

/** The relying party every harness passkey is bound to. */
export const RELAY_RP_ID = 'rc.example.test';
export const RELAY_ORIGIN = `https://${RELAY_RP_ID}`;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface StartRelayOptions {
  readonly clock: FakeClock;
}

export interface HarnessRelay {
  /** `http://127.0.0.1:<port>`: the HTTP API. */
  readonly url: string;
  /** `ws://127.0.0.1:<port>`: what the agent's `relay.url` names. */
  readonly wsOrigin: string;
  /** The origin the phone presents (WebAuthn RP, origin guard). */
  readonly origin: string;
  readonly rpId: string;
  /** The fake Web Push service the relay delivers to (VAPID and aes128gcm checked). */
  readonly push: FakePushService;
  /** Every relay log line (JSON), for canary scans. */
  logs(): string[];
  /** A single-use invite code, as `rcadmin invites` mints them. */
  mintInvite(): Promise<string>;
  /** Waits for in-flight pushes and audit writes. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The relay in process (07 §5.6), wired like `container.ts` but on PGlite and the shared
 * fake clock, listening on 127.0.0.1 port 0 (`inject` cannot carry WebSockets).
 */
export async function startRelay(options: StartRelayOptions): Promise<HarnessRelay> {
  const { clock } = options;
  const client = new PGlite();
  const db = createPgliteDb(client, { migrationsFolder: MIGRATIONS_DIR });
  await db.migrate();
  const vapid = { ...generateVapidKeys(), subject: 'mailto:harness@example.test' };
  const push = await FakePushService.start(vapid.publicKey);
  const destination = createMemoryDestination();
  const logger = createLogger({ level: 'debug', destination });
  const random = webCryptoRandom;

  const accountStore = createDrizzleAccountStore(db.orm);
  const directory = createDrizzleDeviceDirectory(db.orm);
  const subscriptions = createDrizzlePushSubscriptionStore(db.orm);
  const hub = new LocalHub(clock, DEVICE_CAP);
  const audit = new AuditRecorder({ clock, store: createDrizzleAuditLog(db.orm), logger });
  const webauthn = createSimpleWebAuthn({ id: RELAY_RP_ID, origin: RELAY_ORIGIN, name: 'rc' });
  const decisions = new DecisionVerifier({ store: accountStore, webauthn, clock });
  const notifier = new PushNotifier({
    clock,
    directory,
    store: subscriptions,
    push: createWebPushSender(vapid),
    logger,
    audit,
  });
  const router = new RelayRouter({
    clock,
    timer: clock,
    hub,
    directory,
    logger,
    commandGate: decisions,
    pending: notifier,
    audit,
  });
  const accounts = new AccountService({
    store: accountStore,
    webauthn,
    hasher: createScryptSecretHasher(random),
    clock,
    random,
  });
  const pairing = new PairingService({
    registry: createDrizzleDeviceRegistry(db.orm),
    clock,
    random,
    deviceCap: DEVICE_CAP,
  });
  const app = await buildApp({
    logger,
    clock,
    database: db,
    drain: new DrainState(),
    version: '0.0.0-harness',
    commit: null,
    publicDir: undefined,
    auth: { service: accounts, origin: RELAY_ORIGIN },
    relay: { router, hub, directory, pairing, decisions },
    // The fake push service is plain http on 127.0.0.1; production keeps the allow-list.
    push: {
      store: subscriptions,
      publicKey: vapid.publicKey,
      allowEndpoint: (url) => url.startsWith(push.origin),
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('relay: no port');

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    wsOrigin: `ws://127.0.0.1:${String(address.port)}`,
    origin: RELAY_ORIGIN,
    rpId: RELAY_RP_ID,
    push,
    logs: () => destination.lines(),
    async mintInvite() {
      const [code] = await mintInvites({ store: accountStore, random, clock }, 1, INVITE_TTL_MS);
      return code!;
    },
    async idle() {
      await notifier.idle();
      await audit.idle();
    },
    async close() {
      await app.close();
      await notifier.idle();
      await audit.idle();
      await push.close();
      await client.close();
    },
  };
}
