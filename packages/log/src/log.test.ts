import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertNoCanary,
  createLogger,
  createMemoryDestination,
  createRollingDestination,
  LOG_FIELDS,
  REDACT_CENSOR,
  REDACT_PATHS,
  type LogFields,
} from './index.js';

const CANARY = 'CANARY-7f3a';

/** Builds an object with `value` at every redact path (wildcards become `x`). */
function objectWithEveryRedactedPath(value: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const path of REDACT_PATHS) {
    const keys = path.split('.').map((key) => (key === '*' ? 'x' : key));
    let node = root;
    keys.slice(0, -1).forEach((key) => {
      node[key] ??= {};
      node = node[key] as Record<string, unknown>;
    });
    node[keys[keys.length - 1]!] = value;
  }
  return root;
}

describe('createLogger', () => {
  it('AC: redacts every D19 path and the rendered line carries no canary', () => {
    const dest = createMemoryDestination();
    const logger = createLogger({ destination: dest, timestamp: false });

    logger.info(objectWithEveryRedactedPath(CANARY), 'frame received');

    const lines = dest.lines();
    expect(lines).toHaveLength(1);
    expect(() => assertNoCanary(lines, [CANARY])).not.toThrow();
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject(objectWithEveryRedactedPath(REDACT_CENSOR));
  });

  it('covers every key D19 names, at the top level and one level down', () => {
    expect(REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        '*.token',
        '*.secret',
        '*.payload',
        '*.ciphertext',
        '*.push_endpoint',
        '*.challenge',
        '*.pairing_code',
        '*.password',
        'payload',
        'token',
      ]),
    );
    expect(Object.isFrozen(REDACT_PATHS)).toBe(true);
  });

  it('renders the level as a label and keeps the metadata fields', () => {
    const dest = createMemoryDestination();
    const logger = createLogger({ destination: dest, timestamp: false, name: 'relay' });
    const fields: Required<LogFields> = {
      req_id: 'r-1',
      user_id: 'u-1',
      device_id: 'd-1',
      event: 'ws_closed',
      bytes: 512,
      duration_ms: 12,
      ws_close_code: 1008,
    };

    logger.warn(fields, 'closed');

    expect(JSON.parse(dest.lines()[0]!)).toEqual({
      level: 'warn',
      name: 'relay',
      ...fields,
      msg: 'closed',
    });
    expect(Object.keys(fields)).toEqual([...LOG_FIELDS]);
  });

  it('omits pid and hostname, adds an ISO time by default and honours the level', () => {
    const dest = createMemoryDestination();
    const logger = createLogger({ destination: dest });

    logger.debug('hidden');
    logger.info('shown');

    const lines = dest.lines();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('pid');
    expect(parsed).not.toHaveProperty('hostname');
    expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(createLogger({ level: 'debug', destination: dest }).isLevelEnabled('debug')).toBe(true);
  });

  it('defaults to stdout', () => {
    expect(createLogger({ level: 'silent' }).level).toBe('silent');
  });
});

describe('assertNoCanary', () => {
  it('passes clean lines and accepts a single string', () => {
    expect(() => assertNoCanary(['{"a":1}', '{"b":2}'], [CANARY])).not.toThrow();
    expect(() => assertNoCanary('plain text', [CANARY, 'other'])).not.toThrow();
  });

  it('names every leaking canary and its line index', () => {
    expect(() => assertNoCanary(['ok', `x ${CANARY} y`, 'SECRET-2'], [CANARY, 'SECRET-2'])).toThrow(
      `Canary leaked into logs: "${CANARY}" in line 1, "SECRET-2" in line 2.`,
    );
  });

  it('catches a canary that redaction cannot reach, such as the message string', () => {
    const dest = createMemoryDestination();
    createLogger({ destination: dest, timestamp: false }).info(`body ${CANARY}`);
    expect(() => assertNoCanary(dest.lines(), [CANARY])).toThrow(/Canary leaked/);
  });

  it('rejects an empty canary list or an empty canary', () => {
    expect(() => assertNoCanary(['x'], [])).toThrow(TypeError);
    expect(() => assertNoCanary(['x'], [''])).toThrow(TypeError);
  });
});

describe('createRollingDestination', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('writes redacted lines to a numbered file under a created directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-log-'));
    const file = join(dir, 'nested', 'agent.log');
    const dest = await createRollingDestination({ file });
    const logger = createLogger({ destination: dest, timestamp: false, name: 'agent' });

    logger.info({ x: { token: CANARY } }, 'hook received');
    await new Promise<void>((resolve) => {
      dest.once('close', resolve);
      dest.end();
    });

    expect(await readdir(join(dir, 'nested'))).toEqual(['agent.1.log']);
    const text = await readFile(join(dir, 'nested', 'agent.1.log'), 'utf8');
    expect(text).toContain('"hook received"');
    assertNoCanary(text, [CANARY]);
  });

  it('rejects a file count below 2', async () => {
    await expect(createRollingDestination({ file: 'unused.log', files: 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(createRollingDestination({ file: 'unused.log', files: 2.5 })).rejects.toThrow(
      RangeError,
    );
  });
});
