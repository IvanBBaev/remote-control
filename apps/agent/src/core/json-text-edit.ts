/**
 * Surgical edits of a JSON document as text. The hooks installer changes only its own
 * entries in the user's `settings.json`; every other byte — formatting, key order,
 * foreign hooks — stays as the user (or another tool) wrote it (04 §5.6).
 */

interface Span {
  /** Offset of the first character. */
  readonly start: number;
  /** Offset just past the last character. */
  readonly end: number;
}

export interface JsonObjectNode extends Span {
  readonly type: 'object';
  readonly members: readonly JsonMember[];
}

export interface JsonArrayNode extends Span {
  readonly type: 'array';
  readonly items: readonly JsonNode[];
}

export interface JsonScalarNode extends Span {
  readonly type: 'scalar';
  readonly value: string | number | boolean | null;
}

export type JsonNode = JsonObjectNode | JsonArrayNode | JsonScalarNode;

/** A `"key": value` pair; the span runs from the key's quote to the value's end. */
export interface JsonMember extends Span {
  readonly key: string;
  readonly value: JsonNode;
}

/** The text is not valid JSON. */
export class JsonTextError extends Error {
  override readonly name = 'JsonTextError';
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * Parses `text` into a tree with source offsets. Validity is checked with `JSON.parse`
 * first, so the positional scan below can rely on well-formed input.
 */
export function parseJsonText(text: string): JsonNode {
  try {
    JSON.parse(text);
  } catch (error) {
    throw new JsonTextError((error as Error).message);
  }
  let pos = 0;

  const skipWhitespace = (): void => {
    while (pos < text.length && ' \t\n\r'.includes(text[pos] as string)) pos++;
  };

  const readString = (): JsonScalarNode => {
    const start = pos;
    pos++;
    while (text[pos] !== '"') pos += text[pos] === '\\' ? 2 : 1;
    pos++;
    return { type: 'scalar', start, end: pos, value: JSON.parse(text.slice(start, pos)) as string };
  };

  const readValue = (): JsonNode => {
    skipWhitespace();
    const start = pos;
    const char = text[pos];
    if (char === '{') {
      pos++;
      const members: JsonMember[] = [];
      skipWhitespace();
      while (text[pos] !== '}') {
        const key = readString();
        skipWhitespace();
        pos++; // ':'
        const value = readValue();
        members.push({ key: key.value as string, start: key.start, end: value.end, value });
        skipWhitespace();
        if (text[pos] === ',') pos++;
        skipWhitespace();
      }
      pos++;
      return { type: 'object', start, end: pos, members };
    }
    if (char === '[') {
      pos++;
      const items: JsonNode[] = [];
      skipWhitespace();
      while (text[pos] !== ']') {
        items.push(readValue());
        skipWhitespace();
        if (text[pos] === ',') pos++;
        skipWhitespace();
      }
      pos++;
      return { type: 'array', start, end: pos, items };
    }
    if (char === '"') return readString();
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(word, pos)) {
        pos += word.length;
        return { type: 'scalar', start, end: pos, value };
      }
    }
    NUMBER.lastIndex = pos;
    const match = NUMBER.exec(text) as RegExpExecArray;
    pos += match[0].length;
    return { type: 'scalar', start, end: pos, value: Number(match[0]) };
  };

  return readValue();
}

/** The whitespace that starts the line containing `offset`. */
export function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
}

/** The document's indentation unit: the first indented line's whitespace, else 2 spaces. */
export function detectIndentUnit(text: string): string {
  const match = /\n([ \t]+)\S/.exec(text);
  return match?.[1] ?? '  ';
}

/** True when only whitespace precedes `offset` on its line. */
function startsLine(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, offset));
}

function render(value: unknown, unit: string, indent: string): string {
  return JSON.stringify(value, null, unit).split('\n').join(`\n${indent}`);
}

function splice(text: string, start: number, end: number, insert: string): string {
  return text.slice(0, start) + insert + text.slice(end);
}

/** Inserts `entry` (already rendered for `indent`) as the last element of a container. */
function appendEntry(
  text: string,
  container: Span,
  last: Span | undefined,
  build: (indent: string) => string,
): string {
  const unit = detectIndentUnit(text);
  if (last === undefined) {
    const outer = lineIndent(text, container.start);
    const inner = outer + unit;
    return splice(
      text,
      container.start + 1,
      container.end - 1,
      `\n${inner}${build(inner)}\n${outer}`,
    );
  }
  if (startsLine(text, last.start)) {
    const indent = lineIndent(text, last.start);
    return splice(text, last.end, last.end, `,\n${indent}${build(indent)}`);
  }
  return splice(text, last.end, last.end, `, ${build(lineIndent(text, last.start))}`);
}

/** Removes element `index` with its separator, so an append followed by this is a no-op. */
function removeEntry(
  text: string,
  container: Span,
  entries: readonly Span[],
  index: number,
): string {
  const entry = entries[index] as Span;
  if (entries.length === 1) return splice(text, container.start + 1, container.end - 1, '');
  if (index > 0) return splice(text, (entries[index - 1] as Span).end, entry.end, '');
  return splice(text, entry.start, (entries[1] as Span).start, '');
}

export function appendArrayItem(text: string, array: JsonArrayNode, value: unknown): string {
  const unit = detectIndentUnit(text);
  return appendEntry(text, array, array.items.at(-1), (indent) => render(value, unit, indent));
}

export function appendObjectMember(
  text: string,
  object: JsonObjectNode,
  key: string,
  value: unknown,
): string {
  const unit = detectIndentUnit(text);
  return appendEntry(
    text,
    object,
    object.members.at(-1),
    (indent) => `${JSON.stringify(key)}: ${render(value, unit, indent)}`,
  );
}

export function removeArrayItem(text: string, array: JsonArrayNode, index: number): string {
  return removeEntry(text, array, array.items, index);
}

export function removeObjectMember(text: string, object: JsonObjectNode, index: number): string {
  return removeEntry(text, object, object.members, index);
}

/** The member named `key`, with its index. */
export function findMember(
  object: JsonObjectNode,
  key: string,
): { readonly member: JsonMember; readonly index: number } | undefined {
  // The last occurrence wins, as with `JSON.parse`.
  for (let index = object.members.length - 1; index >= 0; index--) {
    const member = object.members[index] as JsonMember;
    if (member.key === key) return { member, index };
  }
  return undefined;
}
