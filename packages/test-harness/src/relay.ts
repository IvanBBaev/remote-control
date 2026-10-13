import { PGlite } from '@electric-sql/pglite';
import { webCryptoRandom } from '@remote-control/crypto';
import { createLogger, createMemoryDestination } from '@remote-control/log';
import { buildApp, DrainState } from '@remote-control/relay';
import {
  AccountService,
  AuditRecorder,
  DEFAULT_AUTH_RATE_LIMITS,
  createDrizzleAccountStore,
  createDrizzleAuditLog,
  createDrizzleDeviceDirectory,
  createDrizzleDeviceRegistry,
  createDrizzleDeviceRevocations,
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
  RevocationService,
  type AuthRateLimits,
} from '@remote-control/relay/testing';

import type { HarnessClock } from './fake-clock.js';

/** The relying party every harness passkey is bound to. */
export const RELAY_RP_ID = 'rc.example.test';
export const RELAY_ORIGIN = `https://${RELAY_RP_ID}`;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface StartRelayOptions {
  readonly clock: HarnessClock;
  /** WebAuthn RP id (default {@link RELAY_RP_ID}). */
  readonly rpId?: string;
  /** The origin the phone presents (default {@link RELAY_ORIGIN}). */
  readonly origin?: string;
  /** Listen address (default `127.0.0.1`). */
  readonly host?: string;
  /** Listen port (default 0). */
  readonly port?: number;
  /** The built PWA to serve, as in production (default: none). */
  readonly publicDir?: string;
  /**
   * Overrides of the production `/api/auth/*` limits. Every harness phone shares one IP,
   * so a suite that registers many accounts raises the per-IP ones.
   */
  readonly authLimits?: Partial<AuthRateLimits>;
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
  /**
   * Every row of every table, one line per row (`schema.table: {json}`, byte columns as
   * latin1), for canary scans (07 §5.12).
   */
  dump(): Promise<string[]>;
  /** A single-use invite code, as `rcadmin invites` mints them. */
  mintInvite(): Promise<string>;
  /** Waits for in-flight pushes and audit writes. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

const textOf = (_key: string, value: unknown): unknown => {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('latin1');
  return typeof value === 'bigint' ? value.toString() : value;
};

async function dumpTables(client: PGlite): Promise<string[]> {
  const tables = await client.query<{ table_schema: string; table_name: string }>(
    `SELECT table_schema, table_name FROM information_schema.tables
     WHERE table_type = 'BASE TABLE'
       AND table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY table_schema, table_name`,
  );
  const lines: string[] = [];
  for (const { table_schema: schema, table_name: table } of tables.rows) {
    const name = `"${schema.replaceAll('"', '""')}"."${table.replaceAll('"', '""')}"`;
    const rows = await client.query<Record<string, unknown>>(`SELECT * FROM ${name}`);
    for (const row of rows.rows) lines.push(`${schema}.${table}: ${JSON.stringify(row, textOf)}`);
  }
  return lines;
}

/**
 * The relay in process (07 §5.6), wired like `container.ts` but on PGlite and the shared
 * fake clock, listening on 127.0.0.1 port 0 (`inject` cannot carry WebSockets).
 */
export async function startRelay(options: StartRelayOptions): Promise<HarnessRelay> {
  const { clock } = options;
  const rpId = options.rpId ?? RELAY_RP_ID;
  const origin = options.origin ?? RELAY_ORIGIN;
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
  const webauthn = createSimpleWebAuthn({ id: rpId, origin, name: 'rc' });
  const decisions = new DecisionVerifier({ store: accountStore, webauthn, clock });
  const revocationStore = createDrizzleDeviceRevocations(db.orm);
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
    revocations: revocationStore,
  });
  const revocations = new RevocationService({
    store: revocationStore,
    hub,
    verifier: decisions,
    clock,
    logger,
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
    publicDir: options.publicDir,
    auth: {
      service: accounts,
      origin,
      limits: { ...DEFAULT_AUTH_RATE_LIMITS, ...options.authLimits },
    },
    relay: { router, hub, directory, pairing, decisions, revocations },
    // The fake push service is plain http on 127.0.0.1; production keeps the allow-list.
    push: {
      store: subscriptions,
      publicKey: vapid.publicKey,
      allowEndpoint: (url) => url.startsWith(push.origin),
    },
  });
  await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('relay: no port');

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    wsOrigin: `ws://127.0.0.1:${String(address.port)}`,
    origin,
    rpId,
    push,
    logs: () => destination.lines(),
    dump: () => dumpTables(client),
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
