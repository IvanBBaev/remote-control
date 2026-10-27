// eslint-disable-next-line no-restricted-imports -- test keys for the APNs .p8 (node:crypto adapter).
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults for an empty development environment', () => {
    expect(loadConfig({})).toEqual({
      nodeEnv: 'development',
      host: '::',
      port: 3000,
      databaseUrl: undefined,
      logLevel: 'info',
      publicDir: undefined,
      tls: undefined,
      commit: null,
      rpId: 'localhost',
      origin: 'http://localhost:3000',
      trustProxyHops: 0,
      push: undefined,
      sentry: undefined,
      spike: false,
      hub: 'local',
    });
  });

  it('reads RC_* variables and Railway values', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      RC_HOST: '0.0.0.0',
      RC_PORT: '8080',
      RC_DATABASE_URL: 'postgres://rc:secret@db:5432/rc',
      RC_LOG_LEVEL: 'warn',
      RC_PUBLIC_DIR: '/app/public',
      RAILWAY_GIT_COMMIT_SHA: 'abc123',
      RC_RP_ID: 'rc.example.com',
      RC_ORIGIN: 'https://rc.example.com/',
    });
    expect(config).toMatchObject({
      nodeEnv: 'production',
      host: '0.0.0.0',
      port: 8080,
      databaseUrl: 'postgres://rc:secret@db:5432/rc',
      logLevel: 'warn',
      publicDir: '/app/public',
      commit: 'abc123',
      rpId: 'rc.example.com',
      origin: 'https://rc.example.com',
      trustProxyHops: 1,
    });
  });

  it('requires RC_RP_ID and an https RC_ORIGIN in production', () => {
    const base = { NODE_ENV: 'production', RC_DATABASE_URL: 'postgres://h/db' };
    expect(() => loadConfig(base)).toThrow(/RC_RP_ID is required.*RC_ORIGIN is required/);
    expect(() =>
      loadConfig({ ...base, RC_RP_ID: 'rc.example.com', RC_ORIGIN: 'http://rc.example.com' }),
    ).toThrow(/RC_ORIGIN must be https/);
    expect(
      loadConfig({
        ...base,
        RC_RP_ID: 'example.com',
        RC_ORIGIN: 'https://rc.example.com',
        RC_TRUST_PROXY_HOPS: '0',
      }),
    ).toMatchObject({ rpId: 'example.com', trustProxyHops: 0 });
  });

  it("requires the RP ID to be the origin's host or a parent domain", () => {
    expect(() =>
      loadConfig({ RC_RP_ID: 'other.com', RC_ORIGIN: 'https://rc.example.com' }),
    ).toThrow(/RC_RP_ID must be RC_ORIGIN's host/);
    expect(() =>
      loadConfig({ RC_RP_ID: 'ample.com', RC_ORIGIN: 'https://rc.example.com' }),
    ).toThrow(/RC_RP_ID/);
    expect(loadConfig({ RC_ORIGIN: 'https://localhost:3443' }).origin).toBe(
      'https://localhost:3443',
    );
  });

  it('falls back to PORT and DATABASE_URL, RC_* winning when both are set', () => {
    expect(loadConfig({ PORT: '4000', DATABASE_URL: 'postgresql://h/db' })).toMatchObject({
      port: 4000,
      databaseUrl: 'postgresql://h/db',
    });
    expect(
      loadConfig({
        PORT: '4000',
        RC_PORT: '5000',
        DATABASE_URL: 'postgres://fallback/db',
        RC_DATABASE_URL: 'postgres://primary/db',
      }),
    ).toMatchObject({ port: 5000, databaseUrl: 'postgres://primary/db' });
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ RC_PORT: '', RC_DATABASE_URL: '', RC_HOST: '' })).toMatchObject({
      port: 3000,
      databaseUrl: undefined,
      host: '::',
    });
  });

  it('pairs the TLS files', () => {
    expect(loadConfig({ RC_TLS_CERT_FILE: 'c.pem', RC_TLS_KEY_FILE: 'k.pem' }).tls).toEqual({
      certFile: 'c.pem',
      keyFile: 'k.pem',
    });
    expect(() => loadConfig({ RC_TLS_CERT_FILE: 'c.pem' })).toThrow(/set together/);
  });

  it('reads the VAPID keys, defaulting the subject to an https origin (M0-12)', () => {
    const keys = { RC_VAPID_PUBLIC: `B${'A'.repeat(86)}`, RC_VAPID_PRIVATE: 'a'.repeat(43) };
    expect(loadConfig({ ...keys, RC_ORIGIN: 'https://rc.example.com/' }).push).toEqual({
      publicKey: keys.RC_VAPID_PUBLIC,
      privateKey: keys.RC_VAPID_PRIVATE,
      subject: 'https://rc.example.com',
    });
    expect(loadConfig({ ...keys, RC_VAPID_SUBJECT: 'mailto:ops@example.com' }).push?.subject).toBe(
      'mailto:ops@example.com',
    );
    expect(() => loadConfig(keys)).toThrow(/RC_VAPID_SUBJECT/);
    expect(() => loadConfig({ RC_VAPID_PUBLIC: keys.RC_VAPID_PUBLIC })).toThrow(/set together/);
    expect(() => loadConfig({ RC_VAPID_PRIVATE: keys.RC_VAPID_PRIVATE })).toThrow(/set together/);
  });

  it('reads the APNs token-auth settings as a set and never echoes the key (M4-05)', () => {
    const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const apns = {
      RC_APNS_KEY: pem.replaceAll('\n', '\\n'),
      RC_APNS_KEY_ID: 'ABC123DEFG',
      RC_APNS_TEAM_ID: 'TEAM123456',
      RC_APNS_TOPIC: 'dev.ivanbaev.remotecontrol',
    };
    expect(loadConfig({}).apns).toBeUndefined();
    expect(loadConfig(apns).apns).toEqual({
      privateKey: pem,
      keyId: 'ABC123DEFG',
      teamId: 'TEAM123456',
      topic: 'dev.ivanbaev.remotecontrol',
    });
    expect(() => loadConfig({ ...apns, RC_APNS_TOPIC: undefined })).toThrow(/set together/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    let message = '';
    try {
      loadConfig({ ...apns, RC_APNS_KEY: rsa });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/RC_APNS_KEY must be the PEM/);
    expect(message).not.toContain('PRIVATE KEY');
    expect(() => loadConfig({ ...apns, RC_APNS_KEY_ID: 'short' })).toThrow(/RC_APNS_KEY_ID/);
  });

  it('enables the device spike only with RC_SPIKE=1 and the VAPID keys (M0-03)', () => {
    const keys = {
      RC_VAPID_PUBLIC: `B${'A'.repeat(86)}`,
      RC_VAPID_PRIVATE: 'a'.repeat(43),
      RC_VAPID_SUBJECT: 'mailto:ops@example.com',
    };
    expect(loadConfig({}).spike).toBe(false);
    expect(loadConfig({ ...keys, RC_SPIKE: '0' }).spike).toBe(false);
    expect(loadConfig({ ...keys, RC_SPIKE: '1' }).spike).toBe(true);
    expect(() => loadConfig({ RC_SPIKE: '1' })).toThrow(/RC_SPIKE/);
    expect(() => loadConfig({ RC_SPIKE: 'yes' })).toThrow(/RC_SPIKE/);
  });

  it('selects the Postgres hub only with a database (ADR 0012)', () => {
    const url = 'postgres://rc@db:5432/rc';
    expect(loadConfig({ RC_DATABASE_URL: url, RC_HUB: 'pg' }).hub).toBe('pg');
    expect(loadConfig({ DATABASE_URL: url, RC_HUB: 'pg' }).hub).toBe('pg');
    expect(loadConfig({ RC_HUB: 'local' }).hub).toBe('local');
    expect(() => loadConfig({ RC_HUB: 'pg' })).toThrow(/RC_HUB/);
    expect(() => loadConfig({ RC_HUB: 'redis' })).toThrow(/RC_HUB/);
  });

  it('reads the optional admin token (M1-13)', () => {
    expect(loadConfig({}).adminToken).toBeUndefined();
    const token = 'A1-'.repeat(12);
    expect(loadConfig({ RC_ADMIN_TOKEN: token }).adminToken).toBe(token);
  });

  it('requires a database URL in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/RC_DATABASE_URL is required/);
  });

  it.each([
    ['RC_PORT', '70000'],
    ['RC_PORT', 'abc'],
    ['RC_LOG_LEVEL', 'loud'],
    ['NODE_ENV', 'staging'],
    ['RC_DATABASE_URL', 'mysql://h/db'],
    ['DATABASE_URL', 'not a url'],
    ['RC_RP_ID', 'Upper.Example'],
    ['RC_ORIGIN', 'ftp://example.com'],
    ['RC_TRUST_PROXY_HOPS', '9'],
    ['RC_VAPID_PUBLIC', 'not-a-key'],
    ['RC_VAPID_PRIVATE', 'short'],
    ['RC_VAPID_SUBJECT', 'http://example.com'],
    ['RC_ADMIN_TOKEN', 'too-short'],
    ['RC_ADMIN_TOKEN', `${'a'.repeat(40)} with spaces`],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(new RegExp(`^Invalid relay.*${name}`));
  });

  it('never echoes a value in the error message', () => {
    const secret = 'postgres-password-canary';
    let message = '';
    try {
      loadConfig({ RC_DATABASE_URL: `mysql://rc:${secret}@h/db` });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('RC_DATABASE_URL');
    expect(message).not.toContain(secret);
  });

  it('parses RC_SENTRY_DSN and rejects anything that is not an https DSN (M0-26)', () => {
    expect(loadConfig({ RC_SENTRY_DSN: 'https://k@o1.ingest.sentry.io/42' }).sentry).toEqual({
      dsn: 'https://k@o1.ingest.sentry.io/42',
      publicKey: 'k',
      envelopeUrl: 'https://o1.ingest.sentry.io/api/42/envelope/',
    });
    expect(() => loadConfig({ RC_SENTRY_DSN: 'http://k@o1.ingest.sentry.io/42' })).toThrow(
      /RC_SENTRY_DSN/,
    );
  });
});
