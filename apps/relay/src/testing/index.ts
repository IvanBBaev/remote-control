/**
 * Relay internals for in-process integration tests (`@remote-control/relay/testing`,
 * used by `packages/test-harness`). Not part of the production entry point.
 */
export { createDrizzleAccountStore } from '../adapters/drizzle-account-store.js';
export { createDrizzleAuditLog } from '../adapters/drizzle-audit-log.js';
export { createDrizzleDeviceDirectory } from '../adapters/drizzle-device-directory.js';
export { createDrizzleDeviceRegistry } from '../adapters/drizzle-device-registry.js';
export { createDrizzlePushSubscriptionStore } from '../adapters/drizzle-push-subscription-store.js';
export { createPgliteDb } from '../adapters/pglite-db.js';
export { createScryptSecretHasher } from '../adapters/scrypt-secret-hasher.js';
export { createSimpleWebAuthn } from '../adapters/simple-webauthn.js';
export { createWebPushSender, generateVapidKeys } from '../adapters/web-push-sender.js';
export { AccountService } from '../core/account-service.js';
export { AuditRecorder } from '../core/audit-recorder.js';
export { DecisionVerifier } from '../core/decision-verifier.js';
export { DEVICE_CAP } from '../core/hub-limits.js';
export { mintInvites } from '../core/invites.js';
export { LocalHub } from '../core/local-hub.js';
export { PairingService } from '../core/pairing-service.js';
export { PushNotifier } from '../core/push-notifier.js';
export { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimits } from '../http/auth-routes.js';
export { RelayRouter } from '../core/relay-router.js';
export { MIGRATIONS_DIR } from '../package-paths.js';
export type { Timer } from '../ports/timer.js';
export { FakePushService, type ReceivedPush } from './fake-push-service.js';
export { SoftwareAuthenticator } from './software-authenticator.js';
