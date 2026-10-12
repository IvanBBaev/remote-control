import { parseArgs } from 'node:util';

import { webCryptoRandom } from '@remote-control/crypto';
import { createLogger } from '@remote-control/log';
import type { Clock, Random } from '@remote-control/protocol';

import { createDrizzleAccountStore } from './adapters/drizzle-account-store.js';
import { createPgDb } from './adapters/pg-db.js';
import { systemClock } from './adapters/system-clock.js';
import { loadConfig } from './config.js';
import { mintInvites } from './core/invites.js';
import { MIGRATIONS_DIR } from './package-paths.js';
import type { AccountStore } from './ports/account-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TTL_DAYS = 90;

export const ADMIN_USAGE = `usage: node dist/admin.js invite [--count N] [--ttl-days N]
  invite      mint single-use invite codes (default 1, valid 7 days, at most 90)`;

export interface AdminStore {
  readonly store: AccountStore;
  readonly close: () => Promise<void>;
}

export interface AdminCommandOptions {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Invite codes go here, one per line, and nowhere else (never into logs). */
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Opens the account store; production uses the `pg` database from the config. */
  readonly openStore?: (databaseUrl: string) => AdminStore;
  readonly clock?: Clock;
  readonly random?: Random;
}

function openPgStore(databaseUrl: string): AdminStore {
  const logger = createLogger({ name: 'relay-admin', level: 'warn' });
  const db = createPgDb(databaseUrl, logger, MIGRATIONS_DIR);
  return { store: createDrizzleAccountStore(db.orm), close: () => db.close() };
}

function positiveInt(text: string | undefined, fallback: number, max: number): number | null {
  if (text === undefined) return fallback;
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= 1 && value <= max ? value : null;
}

/**
 * `railway run node dist/admin.js invite` — the operator's CLI (D8, 02 §5.7). Mints
 * invite codes and prints them once; the database keeps only their SHA-256 hashes.
 * Exit code 0 on success, 1 on an error, 2 on a usage error.
 */
export async function runAdminCommand(options: AdminCommandOptions): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...options.argv],
      allowPositionals: true,
      options: { count: { type: 'string' }, 'ttl-days': { type: 'string' } },
    });
  } catch {
    options.stderr(ADMIN_USAGE);
    return 2;
  }
  const [command, ...extra] = parsed.positionals;
  const count = positiveInt(parsed.values.count, 1, 100);
  const ttlDays = positiveInt(parsed.values['ttl-days'], 7, MAX_TTL_DAYS);
  if (command !== 'invite' || extra.length > 0 || count === null || ttlDays === null) {
    options.stderr(ADMIN_USAGE);
    return 2;
  }

  let databaseUrl: string | undefined;
  try {
    databaseUrl = loadConfig(options.env).databaseUrl;
  } catch (error) {
    options.stderr(error instanceof Error ? error.message : 'invalid configuration');
    return 1;
  }
  if (databaseUrl === undefined) {
    options.stderr('RC_DATABASE_URL (or DATABASE_URL) is not set');
    return 1;
  }

  const clock = options.clock ?? systemClock;
  const { store, close } = (options.openStore ?? openPgStore)(databaseUrl);
  try {
    const ttlMs = ttlDays * DAY_MS;
    const codes = await mintInvites(
      { store, clock, random: options.random ?? webCryptoRandom },
      count,
      ttlMs,
    );
    for (const code of codes) options.stdout(code);
    options.stderr(
      `${codes.length} invite code(s), single use, valid until ${new Date(clock.now() + ttlMs).toISOString()}`,
    );
    return 0;
  } catch {
    options.stderr('minting invite codes failed (is the database migrated and reachable?)');
    return 1;
  } finally {
    await close();
  }
}
