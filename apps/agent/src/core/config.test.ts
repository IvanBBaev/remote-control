import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNodeFileSystem, nodePaths } from '../adapters/node-file-system.js';
import { systemRandom } from '../adapters/system-random.js';
import { DEFAULT_HOLD_SECONDS } from './agent-config.js';
import { defaultConfigText } from './default-config-text.js';
import { loadConfig } from './load-config.js';
import { parseConfig } from './parse-config.js';

function errorsOf(text: string): readonly string[] {
  const result = parseConfig(text, nodePaths);
  if (result.ok) throw new Error('expected an invalid config');
  return result.errors;
}

describe('parseConfig', () => {
  it('applies the defaults to an empty object', () => {
    expect(parseConfig('{}', nodePaths)).toEqual({
      ok: true,
      config: {
        repositories: [],
        hooks: { holdSeconds: DEFAULT_HOLD_SECONDS, port: 4327 },
        agent: { onExpire: 'handoff' },
        always: { destinations: ['session'] },
        notifications: { turnFinished: false, needsInput: false },
      },
    });
  });

  it('round-trips the default config text', () => {
    const result = parseConfig(defaultConfigText(), nodePaths);
    expect(result.ok).toBe(true);
    expect(defaultConfigText().endsWith('}\n')).toBe(true);
  });

  it('accepts a full config', () => {
    const result = parseConfig(
      JSON.stringify({
        repositories: ['/srv/repo'],
        hooks: { holdSeconds: 60 },
        agent: { onExpire: 'deny' },
        always: { destinations: ['session', 'localSettings'] },
        notifications: { turnFinished: true },
        relay: { url: 'wss://relay.example.com' },
      }),
      nodePaths,
    );
    expect(result).toMatchObject({
      ok: true,
      config: {
        hooks: { holdSeconds: 60, port: 4327 },
        agent: { onExpire: 'deny' },
        always: { destinations: ['session', 'localSettings'] },
        notifications: { turnFinished: true, needsInput: false },
      },
    });
  });

  it('accepts ws: only on loopback', () => {
    for (const url of ['ws://localhost:8080', 'ws://127.0.0.1:1', 'ws://[::1]:2']) {
      expect(parseConfig(JSON.stringify({ relay: { url } }), nodePaths).ok).toBe(true);
    }
    for (const url of ['ws://relay.example.com', 'https://relay.example.com', 'not a url']) {
      expect(errorsOf(JSON.stringify({ relay: { url } }))[0]).toMatch(/^relay\.url: /);
    }
  });

  it('reports malformed JSON', () => {
    expect(errorsOf('{')[0]).toMatch(/^not valid JSON/);
  });

  it('names the offending field', () => {
    expect(errorsOf('[]')).toEqual([expect.stringMatching(/^\(root\): /)]);
    expect(errorsOf('{"hooks":{"holdSeconds":5}}')).toEqual([
      expect.stringMatching(/^hooks\.holdSeconds: /),
    ]);
    expect(errorsOf('{"hooks":{"holdSeconds":100000}}')).toHaveLength(1);
    expect(errorsOf('{"hooks":{"holdSeconds":1.5}}')).toHaveLength(1);
    expect(errorsOf('{"agent":{"onExpire":"allow"}}')).toEqual([
      expect.stringMatching(/^agent\.onExpire: /),
    ]);
    expect(errorsOf('{"notifications":{"needsInput":"yes"}}')).toEqual([
      expect.stringMatching(/^notifications\.needsInput: /),
    ]);
  });

  it('lets "Always" add settings destinations, but always with the session (M2-07)', () => {
    const all = { always: { destinations: ['session', 'localSettings', 'projectSettings'] } };
    expect(parseConfig(JSON.stringify(all), nodePaths)).toMatchObject({ ok: true, config: all });
    for (const destinations of [
      [],
      ['projectSettings'],
      ['session', 'session'],
      ['userSettings'],
    ]) {
      expect(errorsOf(JSON.stringify({ always: { destinations } }))[0]).toMatch(
        /^always\.destinations/,
      );
    }
  });

  it('refuses unknown keys, so a typo is not silently ignored', () => {
    expect(errorsOf('{"repository":[]}')).toHaveLength(1);
    expect(errorsOf('{"hooks":{"holdSecs":60}}')).toHaveLength(1);
  });

  it('refuses relative, whitespace-edged and NUL repository roots', () => {
    expect(errorsOf('{"repositories":["repo"]}')).toEqual([
      'repositories.0: must be an absolute path',
    ]);
    expect(errorsOf('{"repositories":["/srv/../srv/repo", "./x"]}')).toEqual([
      'repositories.1: must be an absolute path',
    ]);
    expect(errorsOf('{"repositories":["/srv/repo "]}')[0]).toMatch(/whitespace/);
    expect(errorsOf('{"repositories":[" /srv/repo"]}')[0]).toMatch(/whitespace/);
    expect(errorsOf('{"repositories":["/srv/\\u0000"]}')[0]).toMatch(/NUL/);
    expect(errorsOf('{"repositories":[""]}')).toHaveLength(1);
  });
});

describe('loadConfig', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'remotectl-config-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const fs = createNodeFileSystem(systemRandom);

  it('reports a missing file', async () => {
    expect(await loadConfig(dir, fs, nodePaths)).toEqual({
      status: 'missing',
      path: join(dir, 'config.json'),
    });
  });

  it('loads a valid file and reports an invalid one', async () => {
    await writeFile(join(dir, 'config.json'), '{"agent":{"onExpire":"deny"}}');
    expect(await loadConfig(dir, fs, nodePaths)).toMatchObject({
      status: 'ok',
      config: { agent: { onExpire: 'deny' } },
    });
    await writeFile(join(dir, 'config.json'), '{"agent":1}');
    expect(await loadConfig(dir, fs, nodePaths)).toMatchObject({ status: 'invalid' });
  });
});
