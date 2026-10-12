/**
 * The relay's Postgres schema (02 §5.6, D4, D8). Metadata only (invariant I3): ids,
 * hashes, public keys, timestamps and states. There is no message table and no column
 * that could hold a payload, a transcript or a push body — `schema.test.ts` enforces
 * that against the migrated database.
 *
 * `drizzle-kit generate` reads this file (see `drizzle.config.ts`), so it imports only
 * from `drizzle-orm`. Changing it requires `pnpm --filter @remote-control/relay
 * db:generate` and committing the new SQL under `drizzle/`.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** `bytea` for hashes and public keys (drizzle-orm 0.45 has no built-in bytea column). */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const at = (name: string) => timestamp(name, { withTimezone: true });

/** An account: passkeys only, no email, no username (D8, 02 §5.5). */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Random WebAuthn user handle (base64url); not derived from anything personal. */
  webauthnUserId: text('webauthn_user_id').notNull().unique(),
  displayName: text('display_name'),
  createdAt: createdAt(),
});

/** WebAuthn credentials, fields as `@simplewebauthn/server` stores them. */
export const passkeys = pgTable(
  'passkeys',
  {
    /** Credential id (base64url). */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publicKey: bytea('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: text('transports').array(),
    deviceType: text('device_type').notNull(),
    /** `false` → the PWA asks the user to add a second passkey (02 §5.5). */
    backedUp: boolean('backed_up').notNull(),
    createdAt: createdAt(),
    lastUsedAt: at('last_used_at'),
  },
  (table) => [
    index('passkeys_user_id_idx').on(table.userId),
    check(
      'passkeys_device_type_check',
      sql`${table.deviceType} in ('singleDevice', 'multiDevice')`,
    ),
  ],
);

/**
 * The single-use recovery code shown once at registration; only its scrypt hash is kept.
 * The code is `locator + secret`: the random locator finds the row (a salted scrypt hash
 * cannot be looked up), the 128-bit secret is what the hash protects (02 §5.5).
 */
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Random, non-secret row locator (the first part of the code). */
    locator: text('locator').notNull().unique(),
    /** Encoded scrypt hash (parameters, salt and digest). */
    codeHash: text('code_hash').notNull(),
    createdAt: createdAt(),
    usedAt: at('used_at'),
  },
  (table) => [index('recovery_codes_user_id_idx').on(table.userId)],
);

/**
 * Invite codes minted by the admin CLI (D8, 02 §5.7): registration requires one at
 * launch. Only the SHA-256 hash of the 128-bit code is stored; a code is single-use.
 */
export const inviteCodes = pgTable(
  'invite_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeHash: bytea('code_hash').notNull().unique(),
    createdAt: createdAt(),
    expiresAt: at('expires_at').notNull(),
    usedAt: at('used_at'),
    usedByUserId: uuid('used_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [index('invite_codes_expires_at_idx').on(table.expiresAt)],
);

/** Phones and agents (machines) of a user (02 §5.6). */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    createdAt: createdAt(),
    lastSeenAt: at('last_seen_at'),
    revokedAt: at('revoked_at'),
  },
  (table) => [
    index('devices_user_id_idx').on(table.userId),
    check('devices_kind_check', sql`${table.kind} in ('phone', 'agent')`),
  ],
);

/** A completed phone ↔ agent pairing (one KK session per pair, D25). */
export const pairings = pgTable(
  'pairings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    phoneDeviceId: uuid('phone_device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    agentDeviceId: uuid('agent_device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    revokedAt: at('revoked_at'),
  },
  (table) => [
    uniqueIndex('pairings_phone_agent_idx').on(table.phoneDeviceId, table.agentDeviceId),
    index('pairings_user_id_idx').on(table.userId),
    index('pairings_agent_device_id_idx').on(table.agentDeviceId),
  ],
);

/** Web Push subscription of a phone. The endpoint is a capability URL: never logged (D19). */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    /** Subscription keys (RFC 8291) used to encrypt the metadata-only push. */
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: createdAt(),
    lastFailureAt: at('last_failure_at'),
  },
  (table) => [index('push_subscriptions_device_id_idx').on(table.deviceId)],
);

/**
 * Login sessions behind the `__Host-` cookie (D8, 02 §5.5): the SHA-256 hash of the
 * cookie value, never the value; idle 7 days (`last_seen_at`), absolute 30 days
 * (`expires_at`).
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull().unique(),
    createdAt: createdAt(),
    lastSeenAt: at('last_seen_at').notNull().defaultNow(),
    expiresAt: at('expires_at').notNull(),
    revokedAt: at('revoked_at'),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

/** Agent bearer tokens issued at enrolment (`rc-enroll:`, 02 §5.5); hash only. */
export const agentTokens = pgTable(
  'agent_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agentDeviceId: uuid('agent_device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull().unique(),
    createdAt: createdAt(),
    lastUsedAt: at('last_used_at'),
    revokedAt: at('revoked_at'),
  },
  (table) => [index('agent_tokens_agent_device_id_idx').on(table.agentDeviceId)],
);

/**
 * Single-use pairing slots opened by an agent (TTL 5 min, D6). The phone joins by the
 * hash of the code; the code itself and the XXpsk0 frames never touch the database.
 */
export const pairingSlots = pgTable(
  'pairing_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agentDeviceId: uuid('agent_device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    codeHash: bytea('code_hash').notNull().unique(),
    createdAt: createdAt(),
    expiresAt: at('expires_at').notNull(),
    /** Set when a phone joins; a joined slot cannot be joined again. */
    joinedAt: at('joined_at'),
    phoneDeviceId: uuid('phone_device_id').references(() => devices.id, { onDelete: 'cascade' }),
    failedAttempts: smallint('failed_attempts').notNull().default(0),
  },
  (table) => [index('pairing_slots_expires_at_idx').on(table.expiresAt)],
);

/**
 * Security events: event, user, device, time — no bodies, no free-form metadata
 * column (02 §5.6, D19). `device_id` has no foreign key so rows outlive a revoked or
 * deleted device for the 90-day retention (02 §5.9). `decision_hash` is set only on
 * `decision_forwarded`: the 32-byte hash the phone verified (D7), never the decision.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    deviceId: uuid('device_id'),
    event: text('event').notNull(),
    decisionHash: bytea('decision_hash'),
    at: at('at').notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_user_id_at_idx').on(table.userId, table.at.desc()),
    index('audit_log_at_idx').on(table.at),
    index('audit_log_event_at_idx').on(table.event, table.at),
  ],
);
