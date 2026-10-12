/** Value pino writes in place of a redacted field. */
export const REDACT_CENSOR = '[Redacted]';

/**
 * Keys that must never reach a log line (ROADMAP D19, reports 06 §5.5 and 02 §5.6):
 * credentials, message payloads (encrypted or not), push endpoints (capability URLs),
 * WebAuthn challenges and pairing codes.
 */
const SENSITIVE_KEYS = [
  'token',
  'secret',
  'payload',
  'ciphertext',
  'push_endpoint',
  'challenge',
  'pairing_code',
  'password',
] as const;

/**
 * The pino `redact` path list. D19 lists the `*.<key>` wildcards; pino's `*` matches
 * exactly one level, so the same keys are also listed at the top level of the logged
 * object, where `*.<key>` does not reach.
 */
export const REDACT_PATHS: readonly string[] = Object.freeze([
  'req.headers.authorization',
  'req.headers.cookie',
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
]);
