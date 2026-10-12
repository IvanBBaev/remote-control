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
});
