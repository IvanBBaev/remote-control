import { z } from 'zod';

/** Empty strings in the environment mean "unset" (Railway and compose both produce them). */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const port = z.coerce.number().int().min(0).max(65_535);
const postgresUrl = z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// URL' });

const EnvSchema = z
  .object({
    NODE_ENV: optional(z.enum(['development', 'test', 'production'])),
    RC_HOST: optional(z.string().min(1)),
    RC_PORT: optional(port),
    /** Railway injects `PORT`; `RC_PORT` wins when both are set. */
    PORT: optional(port),
    RC_DATABASE_URL: optional(postgresUrl),
    /** Railway's Postgres reference variable; the fallback for `RC_DATABASE_URL`. */
    DATABASE_URL: optional(postgresUrl),
    RC_LOG_LEVEL: optional(z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])),
    RC_PUBLIC_DIR: optional(z.string().min(1)),
    RC_TLS_CERT_FILE: optional(z.string().min(1)),
    RC_TLS_KEY_FILE: optional(z.string().min(1)),
    RAILWAY_GIT_COMMIT_SHA: optional(z.string().min(1)),
    /** WebAuthn relying-party id: the production domain (D9, §6 Q2). */
    RC_RP_ID: optional(z.string().regex(/^[a-z0-9.-]+$/, 'must be a lower-case host name')),
    /** The PWA's origin; the only origin accepted for WebAuthn and state-changing requests. */
    RC_ORIGIN: optional(z.url({ protocol: /^https?$/, error: 'must be an http(s) origin' })),
    /** Reverse proxies in front of the relay whose X-Forwarded-For entry is trusted. */
    RC_TRUST_PROXY_HOPS: optional(z.coerce.number().int().min(0).max(5)),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.RC_DATABASE_URL && !env.DATABASE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['RC_DATABASE_URL'],
        message: 'is required in production (or DATABASE_URL)',
      });
    }
    if (env.NODE_ENV === 'production') {
      for (const name of ['RC_RP_ID', 'RC_ORIGIN'] as const) {
        if (env[name] === undefined) {
          ctx.addIssue({ code: 'custom', path: [name], message: 'is required in production' });
        }
      }
      if (env.RC_ORIGIN?.startsWith('http:')) {
        ctx.addIssue({
          code: 'custom',
          path: ['RC_ORIGIN'],
          message: 'must be https in production (the __Host- cookie is Secure)',
        });
      }
    }
    if (env.RC_ORIGIN !== undefined && env.RC_RP_ID !== undefined) {
      const host = new URL(env.RC_ORIGIN).hostname;
      if (host !== env.RC_RP_ID && !host.endsWith(`.${env.RC_RP_ID}`)) {
        ctx.addIssue({
          code: 'custom',
          path: ['RC_RP_ID'],
          message: "must be RC_ORIGIN's host or a parent domain of it",
        });
      }
    }
    if ((env.RC_TLS_CERT_FILE === undefined) !== (env.RC_TLS_KEY_FILE === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['RC_TLS_CERT_FILE'],
        message: 'RC_TLS_CERT_FILE and RC_TLS_KEY_FILE must be set together',
      });
    }
  });

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export interface Config {
  readonly nodeEnv: 'development' | 'test' | 'production';
  /** Listen address; `::` accepts IPv4 and IPv6 (Railway's private network is IPv6). */
  readonly host: string;
  readonly port: number;
  /** `undefined` only outside production: `/health` then reports `db: "disabled"`. */
  readonly databaseUrl: string | undefined;
  readonly logLevel: LogLevel;
  /** PWA build to serve; `undefined` = the composition root's default (`apps/web/dist`). */
  readonly publicDir: string | undefined;
  /** Local HTTPS for phone-on-LAN testing (`pnpm dev:https`); never set on Railway. */
  readonly tls: { readonly certFile: string; readonly keyFile: string } | undefined;
  /** Git commit of the running build, from Railway. */
  readonly commit: string | null;
  /** WebAuthn RP ID (`localhost` outside production). */
  readonly rpId: string;
  /** The single accepted origin, without a trailing slash (`http://localhost:3000` outside production). */
  readonly origin: string;
  /** Fastify `trustProxy` hop count: 1 on Railway (its edge appends the client IP). */
  readonly trustProxyHops: number;
}

/** Thrown when the environment is invalid; the message names variables, never values. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Parses and validates the relay's environment (`RC_*`, ROADMAP §5). */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`);
    throw new ConfigError(`Invalid relay configuration: ${problems.join('; ')}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV ?? 'development',
    host: e.RC_HOST ?? '::',
    port: e.RC_PORT ?? e.PORT ?? 3000,
    databaseUrl: e.RC_DATABASE_URL ?? e.DATABASE_URL,
    logLevel: e.RC_LOG_LEVEL ?? 'info',
    publicDir: e.RC_PUBLIC_DIR,
    tls:
      e.RC_TLS_CERT_FILE !== undefined && e.RC_TLS_KEY_FILE !== undefined
        ? { certFile: e.RC_TLS_CERT_FILE, keyFile: e.RC_TLS_KEY_FILE }
        : undefined,
    commit: e.RAILWAY_GIT_COMMIT_SHA ?? null,
    rpId: e.RC_RP_ID ?? 'localhost',
    origin: e.RC_ORIGIN === undefined ? 'http://localhost:3000' : new URL(e.RC_ORIGIN).origin,
    trustProxyHops: e.RC_TRUST_PROXY_HOPS ?? (e.NODE_ENV === 'production' ? 1 : 0),
  };
}
