// Railway infrastructure as code (D16, ADR 0023). Replaces `railway.json`, whose Config
// as Code is ignored for services created after 2026-08-28 and stops being read on
// 2026-12-01. Review with `railway config plan`; change Railway with `railway config apply`.
// Secrets are never written here: `preserve()` keeps the value set in the dashboard.
import { defineRailway, github, postgres, preserve, service } from 'railway/iac';

/** D16: one region for the relay and its database. */
export const REGION = 'europe-west4-drams3a';

/**
 * Redeploy only when an input of the relay image changes, including the root files that
 * pin dependencies and the toolchain (review 06 F11).
 */
export const WATCH_PATTERNS = [
  'apps/relay/**',
  'apps/web/**',
  'packages/**',
  'Dockerfile',
  '.dockerignore',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.nvmrc',
  '.railway/**',
];

export default defineRailway((ctx, project) => {
  // ADR 0016: staging runs two replicas on the Postgres hub; production runs one.
  const staging = ctx.isEnvironment('staging');
  const db = postgres('postgres', { region: REGION });

  const relay = service('relay', {
    source: github('IvanBBaev/remote-control', { branch: staging ? 'staging' : 'main' }),
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'Dockerfile',
      watchPatterns: WATCH_PATTERNS,
    },
    deploy: {
      // D17: a broken migration fails the deploy before traffic switches.
      preDeployCommand: ['node dist/migrate.js'],
      healthcheckPath: '/health',
      healthcheckTimeout: 100,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      // Serverless off: the relay holds WebSockets (I2).
      sleepApplication: false,
      // The old container serves while the new one warms up, then drains (06 §5.1).
      overlapSeconds: 20,
      drainingSeconds: 30,
    },
    replicas: { [REGION]: staging ? 2 : 1 },
    env: {
      RC_DATABASE_URL: db.env.DATABASE_URL,
      ...(staging ? { RC_HUB: 'pg' } : {}),
      RC_RP_ID: preserve(),
      RC_ORIGIN: preserve(),
      RC_VAPID_PUBLIC: preserve(),
      RC_VAPID_PRIVATE: preserve(),
      RC_VAPID_SUBJECT: preserve(),
      RC_ADMIN_TOKEN: preserve(),
      RC_SENTRY_DSN: preserve(),
    },
  });

  return project('remote-control', {
    environments: ['production', 'staging'],
    resources: [db, relay],
  });
});
