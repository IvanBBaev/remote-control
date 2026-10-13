import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { CanonicalDecision } from './canonical-decision.js';
import { Ack, Hello, HelloOk, Ping, Pong, Presence, RelayError } from './control-frames.js';
import { ApprovalRequest } from './domain/approval-request.js';
import { Capabilities } from './domain/capabilities.js';
import { Decision } from './domain/decision.js';
import { Instruction } from './domain/instruction.js';
import { Machine } from './domain/machine.js';
import { Question } from './domain/question.js';
import { Repository } from './domain/repository.js';
import { Session } from './domain/session.js';
import { StartSession } from './domain/start-session.js';
import { canonicalJson } from './canonical-json.js';
import { Envelope } from './envelope.js';

interface SchemaFixture {
  readonly valid: readonly Record<string, unknown>[];
  readonly invalid: readonly { readonly reason: string; readonly value: unknown }[];
}

function loadFixture(name: string): SchemaFixture {
  const url = new URL(`../fixtures/v1/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as SchemaFixture;
}

const SCHEMAS: readonly (readonly [string, z.ZodType])[] = [
  ['envelope', Envelope],
  ['hello', Hello],
  ['hello-ok', HelloOk],
  ['ack', Ack],
  ['presence', Presence],
  ['ping', Ping],
  ['pong', Pong],
  ['error', RelayError],
  ['capabilities', Capabilities],
  ['machine', Machine],
  ['repository', Repository],
  ['session', Session],
  ['approval-request', ApprovalRequest],
  ['question', Question],
  ['decision', Decision],
  ['instruction', Instruction],
  ['start-session', StartSession],
  ['canonical-decision', CanonicalDecision],
];

describe.each(SCHEMAS)('%s schema', (name, schema) => {
  const fixture = loadFixture(name);

  it('has at least one valid and one invalid golden example', () => {
    expect(fixture.valid.length).toBeGreaterThan(0);
    expect(fixture.invalid.length).toBeGreaterThan(0);
  });

  it.each(fixture.valid)('round-trips valid example %#', (example) => {
    const decoded = schema.parse(example);
    expect(decoded).toEqual(example);
    const encoded = canonicalJson(decoded);
    expect(schema.parse(JSON.parse(encoded))).toEqual(example);
    expect(canonicalJson(schema.parse(JSON.parse(encoded)))).toBe(encoded);
  });

  it.each(fixture.invalid)('rejects: $reason', ({ value }) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each(fixture.valid)('rejects an unknown top-level key in example %#', (example) => {
    expect(schema.safeParse({ ...example, extra: 'CANARY-7f3a' }).success).toBe(false);
  });

  it.each(fixture.valid)('rejects example %# with any required key missing', (example) => {
    for (const key of Object.keys(example)) {
      const value = example[key];
      const without: Record<string, unknown> = { ...example };
      delete without[key];
      const result = schema.safeParse(without);
      // Optional members may be absent; everything else is required.
      if (result.success) expect(value === undefined || isOptional(schema, key)).toBe(true);
    }
  });
});

function isOptional(schema: z.ZodType, key: string): boolean {
  const shape = (schema as unknown as { shape?: Record<string, z.ZodType> }).shape;
  return shape?.[key]?.safeParse(undefined).success ?? false;
}

describe('01 W2 field lists', () => {
  const keys = (schema: { shape: object }): string[] => Object.keys(schema.shape).sort();

  it('domain schemas carry the fields the screens need', () => {
    expect(keys(Machine)).toEqual(['agentVersion', 'agents', 'id', 'name', 'platform']);
    expect(keys(Repository)).toEqual(['id', 'machineId', 'maxPermissionMode', 'name', 'path']);
    expect(keys(Session)).toEqual(
      expect.arrayContaining(['id', 'machineId', 'repositoryId', 'state', 'changedFiles']),
    );
    expect(keys(ApprovalRequest)).toEqual(
      expect.arrayContaining(['id', 'requestHash', 'toolLabel', 'content', 'expiresAt']),
    );
    expect(keys(Question)).toEqual([
      'expiresAt',
      'id',
      'project',
      'questions',
      'requestHash',
      'sessionId',
    ]);
    expect(keys(Decision)).toEqual(['behavior', 'reason', 'requestId', 'scope']);
    expect(keys(Instruction)).toEqual(['sessionId', 'text']);
    expect(keys(StartSession)).toEqual(['machineId', 'permissionMode', 'prompt', 'repositoryId']);
    expect(keys(Capabilities)).toEqual([
      'agent',
      'always',
      'instructions',
      'questions',
      'startSession',
    ]);
  });

  it('the envelope has exactly the D14 fields plus its kind discriminator', () => {
    expect(keys(Envelope)).toEqual([
      'cls',
      'decisionHash',
      'expiresAt',
      'from',
      'id',
      'kind',
      'payload',
      'pushBlob',
      'replyTo',
      'seq',
      'session',
      'to',
      'ts',
      'v',
    ]);
  });
});
