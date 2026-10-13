import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { FRAME_KINDS } from './frame.js';
import { parseFrame } from './parse-frame.js';

const BAD_FRAME = { ok: false, error: { code: 'bad_frame', closeCode: 1008 } };
const UNSUPPORTED = { ok: false, error: { code: 'unsupported_version', closeCode: 4001 } };

const FIXTURE_BY_KIND: Record<(typeof FRAME_KINDS)[number], string> = {
  data: 'envelope',
  hello: 'hello',
  hello_ok: 'hello-ok',
  ack: 'ack',
  presence: 'presence',
  peer_revoked: 'peer-revoked',
  ping: 'ping',
  pong: 'pong',
  error: 'error',
};

function validFrames(name: string): Record<string, unknown>[] {
  const url = new URL(`../fixtures/v1/${name}.json`, import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { valid: Record<string, unknown>[] }).valid;
}

describe('parseFrame', () => {
  it.each(FRAME_KINDS)('accepts every golden %s frame', (kind) => {
    for (const frame of validFrames(FIXTURE_BY_KIND[kind])) {
      expect(parseFrame(JSON.stringify(frame))).toEqual({ ok: true, frame });
    }
  });

  it.each([
    ['malformed JSON', '{"v":1,'],
    ['a JSON array', '[1]'],
    ['a JSON null', 'null'],
    ['a JSON string', '"hello"'],
    ['a missing v', '{"kind":"ping","t":0}'],
    ['a fractional v', '{"v":1.5,"kind":"ping","t":0}'],
    ['a string v', '{"v":"1","kind":"ping","t":0}'],
    ['a missing kind', '{"v":1,"t":0}'],
    ['a numeric kind', '{"v":1,"kind":7,"t":0}'],
    ['an unknown key', '{"v":1,"kind":"ping","t":0,"extra":"CANARY-7f3a"}'],
    ['a schema violation', '{"v":1,"kind":"ping","t":-1}'],
  ])('refuses %s with bad_frame (close 1008)', (_label, text) => {
    expect(parseFrame(text)).toEqual(BAD_FRAME);
  });

  it.each([
    ['a version above the supported range', '{"v":2,"kind":"ping","t":0}'],
    ['a version below the supported range', '{"v":0,"kind":"ping","t":0}'],
    ['an unknown kind', '{"v":1,"kind":"resume","t":0}'],
  ])('refuses %s with unsupported_version (close 4001)', (_label, text) => {
    expect(parseFrame(text)).toEqual(UNSUPPORTED);
  });
});
