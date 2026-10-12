import { describe, expect, it } from 'vitest';

import {
  JsonTextError,
  appendArrayItem,
  appendObjectMember,
  detectIndentUnit,
  findMember,
  lineIndent,
  parseJsonText,
  removeArrayItem,
  removeObjectMember,
  type JsonArrayNode,
  type JsonObjectNode,
} from './json-text-edit.js';

const asObject = (text: string): JsonObjectNode => parseJsonText(text) as JsonObjectNode;
const asArray = (text: string): JsonArrayNode => parseJsonText(text) as JsonArrayNode;

describe('parseJsonText', () => {
  it('records offsets of members, items and scalars', () => {
    const text = '{ "a": [1, -2.5e3, "x\\"y"], "b": {"c": true, "d": null, "e": false} }';
    const root = asObject(text);
    expect(root).toMatchObject({ type: 'object', start: 0, end: text.length });
    const [a, b] = root.members;
    expect(text.slice(a!.start, a!.end)).toBe('"a": [1, -2.5e3, "x\\"y"]');
    const items = (a!.value as JsonArrayNode).items;
    expect(items.map((item) => (item.type === 'scalar' ? item.value : undefined))).toEqual([
      1,
      -2500,
      'x"y',
    ]);
    expect(text.slice(b!.value.start, b!.value.end)).toBe('{"c": true, "d": null, "e": false}');
    expect(parseJsonText(' [ ] ')).toMatchObject({ type: 'array', start: 1, end: 4, items: [] });
  });

  it('throws JsonTextError on invalid JSON', () => {
    expect(() => parseJsonText('{ "a": ')).toThrow(JsonTextError);
    expect(() => parseJsonText('')).toThrow(JsonTextError);
  });
});

describe('indentation helpers', () => {
  it('reads the indent of a line and the unit of a document', () => {
    const text = '{\n\t"a": 1\n}';
    expect(lineIndent(text, text.indexOf('"a"'))).toBe('\t');
    expect(lineIndent(text, 0)).toBe('');
    expect(detectIndentUnit(text)).toBe('\t');
    expect(detectIndentUnit('{"a":1}')).toBe('  ');
  });
});

describe('append and remove', () => {
  it('appends to a multi-line container in its style and removes it again', () => {
    const text = '{\n    "a": [\n        1\n    ]\n}\n';
    const root = asObject(text);
    const array = root.members[0]!.value as JsonArrayNode;
    const added = appendArrayItem(text, array, { x: [1] });
    expect(added).toBe(
      '{\n    "a": [\n        1,\n        {\n            "x": [\n                1\n            ]\n        }\n    ]\n}\n',
    );
    const again = asObject(added).members[0]!.value as JsonArrayNode;
    expect(removeArrayItem(added, again, 1)).toBe(text);

    const withMember = appendObjectMember(text, root, 'b', true);
    expect(withMember).toBe('{\n    "a": [\n        1\n    ],\n    "b": true\n}\n');
    expect(removeObjectMember(withMember, asObject(withMember), 1)).toBe(text);
  });

  it('appends inline when the last entry shares a line', () => {
    const text = '{"a": [1, 2]}';
    const array = asObject(text).members[0]!.value as JsonArrayNode;
    expect(appendArrayItem(text, array, 3)).toBe('{"a": [1, 2, 3]}');
  });

  it('fills an empty container on new lines', () => {
    expect(appendObjectMember('{}', asObject('{}'), 'k', 1)).toBe('{\n  "k": 1\n}');
    const text = '{\n  "a": []\n}';
    const array = asObject(text).members[0]!.value as JsonArrayNode;
    expect(appendArrayItem(text, array, 'v')).toBe('{\n  "a": [\n    "v"\n  ]\n}');
  });

  it('removes the first, a middle and the only entry', () => {
    const text = '[1, 2, 3]';
    expect(removeArrayItem(text, asArray(text), 0)).toBe('[2, 3]');
    expect(removeArrayItem(text, asArray(text), 1)).toBe('[1, 3]');
    expect(removeArrayItem('[ 1 ]', asArray('[ 1 ]'), 0)).toBe('[]');
  });

  it('finds the last occurrence of a key', () => {
    const root = asObject('{"a": 1, "b": 2, "a": 3}');
    expect(findMember(root, 'a')).toMatchObject({ index: 2, member: { key: 'a' } });
    expect(findMember(root, 'z')).toBeUndefined();
  });
});
