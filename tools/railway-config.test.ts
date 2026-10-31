import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRailwayContext, project } from 'railway/iac';
import program, { REGION } from '../.railway/railway.js';

// D16 / ADR 0023: the Railway settings live in `.railway/railway.ts`. These assertions pin
// the values the deploy relies on (I2: overlap and draining keep sockets alive).

interface Resource {
  address: string;
  source?: { branch?: string };
  build?: { builder?: string; dockerfilePath?: string; watchPatterns?: string[] };
  deploy?: Record<string, unknown> & {
    multiRegionConfig?: Record<string, { numReplicas?: number }>;
  };
  variables?: Record<string, { type: string; value?: string }>;
}

async function relayIn(environmentName: string): Promise<Resource> {
  const definition = await program(createRailwayContext({ environmentName }), project);
  const relay = (definition.resources as Resource[] | undefined)?.find(
    (r) => r.address === 'service.relay',
  );
  if (!relay) throw new Error('no relay service');
  return relay;
}

describe('.railway/railway.ts', () => {
  it('replaces railway.json', () => {
    expect(existsSync(new URL('../railway.json', import.meta.url))).toBe(false);
  });

  it('builds the relay from the Dockerfile and watches every image input', async () => {
    const { build } = await relayIn('production');
    expect(build).toMatchObject({ builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' });
    expect(build?.watchPatterns).toEqual(
      expect.arrayContaining([
        'apps/relay/**',
        'packages/**',
        'Dockerfile',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        '.nvmrc',
      ]),
    );
  });

  it('pins the D16 deploy values', async () => {
    const { deploy } = await relayIn('production');
    expect(deploy).toMatchObject({
      preDeployCommand: ['node dist/migrate.js'],
      healthcheckPath: '/health',
      healthcheckTimeout: 100,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      sleepApplication: false,
      overlapSeconds: 20,
      drainingSeconds: 30,
    });
  });

  it('runs one replica in production on main and the in-process hub', async () => {
    const relay = await relayIn('production');
    expect(relay.source?.branch).toBe('main');
    expect(relay.deploy?.multiRegionConfig).toEqual({ [REGION]: { numReplicas: 1 } });
    expect(relay.variables?.['RC_HUB']).toBeUndefined();
  });

  it('runs two replicas in staging on the staging branch with the Postgres hub', async () => {
    const relay = await relayIn('staging');
    expect(relay.source?.branch).toBe('staging');
    expect(relay.deploy?.multiRegionConfig).toEqual({ [REGION]: { numReplicas: 2 } });
    expect(relay.variables?.['RC_HUB']).toEqual({ type: 'literal', value: 'pg' });
  });

  it('holds no secret: every value is a reference, a preserve or a non-secret literal', async () => {
    for (const env of ['production', 'staging']) {
      const { variables = {} } = await relayIn(env);
      for (const [name, value] of Object.entries(variables)) {
        if (value.type === 'literal') expect(name).toBe('RC_HUB');
        else expect(['reference', 'preserve']).toContain(value.type);
      }
      expect(variables['RC_DATABASE_URL']).toMatchObject({ type: 'reference' });
    }
  });
});
