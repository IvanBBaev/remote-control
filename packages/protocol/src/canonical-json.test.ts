import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical-json.js';

describe('canonicalJson', () => {
  it.each([
    [null, 'null'],
    [true, 'true'],
    [false, 'false'],
    [0, '0'],
    [-1.5, '-1.5'],
    [-0, '0'],
    ['CANARY-7f3a café', '"CANARY-7f3a café"'],
    ['quote " and \\ backslash', '"quote \\" and \\\\ backslash"'],
    [[], '[]'],
    [{}, '{}'],
    [[1, 'a', null, [true]], '[1,"a",null,[true]]'],
    [{ b: 1, a: { d: [], c: null } }, '{"a":{"c":null,"d":[]},"b":1}'],
    [{ a: undefined, b: 2 }, '{"b":2}'],
  ])('serialises %j canonically', (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  it('sorts keys by UTF-16 code unit', () => {
    expect(canonicalJson({ b: 0, B: 0, é: 0, a: 0, _: 0, '1': 0 })).toBe(
      '{"1":0,"B":0,"_":0,"a":0,"b":0,"é":0}',
    );
  });

  it('accepts objects without a prototype', () => {
    const value = Object.create(null) as Record<string, unknown>;
    value.z = 1;
    value.y = 2;
    expect(canonicalJson(value)).toBe('{"y":2,"z":1}');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses the non-finite number %s',
    (value) => {
      expect(() => canonicalJson(value)).toThrow('canonicalJson: non-finite number');
    },
  );

  it.each([
    ['undefined', undefined],
    ['bigint', 1n],
    ['function', () => 0],
    ['symbol', Symbol('x')],
    ['object', new Date(0)],
    ['object', new Map()],
    ['undefined', [undefined]],
  ])('refuses a value of type %s', (type, value) => {
    expect(() => canonicalJson(value)).toThrow(`canonicalJson: unsupported value of type ${type}`);
  });

  it('matches JSON.stringify for any JSON value up to key order', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
      }),
      { numRuns: 1000 },
    );
  });

  it('does not depend on key insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (value) => {
        const reversed = Object.fromEntries(Object.entries(value).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(value));
      }),
      { numRuns: 1000 },
    );
  });
});
