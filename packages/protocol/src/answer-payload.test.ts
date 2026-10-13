import { describe, expect, it } from 'vitest';

import {
  AnswerPayload,
  MAX_OTHER_LENGTH,
  encodeAnswerPayload,
  parseAnswerPayload,
} from './answer-payload.js';

describe('AnswerPayload', () => {
  it.each([
    { answers: [{ labels: ['React'] }] },
    { answers: [{ labels: [], other: 'Svelte' }], response: 'see notes' },
    { answers: [{ labels: ['lint', 'test'] }, { labels: ['Postgres'] }] },
  ])('accepts %j', (payload) => {
    expect(AnswerPayload.parse(payload)).toEqual(payload);
  });

  it.each([
    ['no answers', { answers: [] }],
    ['five answers', { answers: Array.from({ length: 5 }, () => ({ labels: ['a'] })) }],
    ['five labels', { answers: [{ labels: ['1', '2', '3', '4', '5'] }] }],
    ['an empty label', { answers: [{ labels: [''] }] }],
    ['blank other text', { answers: [{ labels: [], other: '   ' }] }],
    ['too long other text', { answers: [{ labels: [], other: 'x'.repeat(MAX_OTHER_LENGTH + 1) }] }],
    ['a blank response', { answers: [{ labels: ['a'] }], response: '' }],
    ['an unknown key', { answers: [{ labels: ['a'] }], extra: 1 }],
    ['an unknown key in an answer', { answers: [{ labels: ['a'], value: 'b' }] }],
  ])('refuses %s', (_name, payload) => {
    expect(AnswerPayload.safeParse(payload).success).toBe(false);
  });
});

describe('encodeAnswerPayload / parseAnswerPayload', () => {
  it('encodes canonical JSON and parses it back', () => {
    const payload = { response: 'r', answers: [{ other: 'o', labels: ['b', 'a'] }] };
    const encoded = encodeAnswerPayload(payload);
    expect(encoded).toBe('{"answers":[{"labels":["b","a"],"other":"o"}],"response":"r"}');
    expect(parseAnswerPayload(encoded)).toEqual(payload);
  });

  it('refuses to encode an invalid payload', () => {
    expect(() => encodeAnswerPayload({ answers: [] })).toThrow();
  });

  it.each([
    ['null', null],
    ['not JSON', '{'],
    ['the wrong shape', '{"answers":[]}'],
  ])('parses %s to undefined', (_name, payload) => {
    expect(parseAnswerPayload(payload)).toBeUndefined();
  });
});
