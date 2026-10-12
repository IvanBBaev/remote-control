import { describe, expect, it } from 'vitest';

import { escapeXml } from './xml-escape.js';

describe('escapeXml', () => {
  it('escapes the five XML special characters', () => {
    expect(escapeXml(`a & b <c> "d" 'e'`)).toBe('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;');
  });

  it('keeps tabs, newlines and non-ASCII text', () => {
    expect(escapeXml('Tab\tLine\nПетър 😀')).toBe('Tab\tLine\nПетър 😀');
  });

  it.each(['\u0000', '\u0007', '\u001F', '￾', '\uD800'])(
    'refuses %j, which XML cannot carry',
    (bad) => {
      expect(() => escapeXml(`x${bad}y`)).toThrow(RangeError);
    },
  );
});
