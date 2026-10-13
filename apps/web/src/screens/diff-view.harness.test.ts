import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// jsdom does no layout, so the "no page overflow" half of M2-02's AC is checked on the
// stylesheet itself.
describe('diff view styles (M2-02)', () => {
  it('AC: long lines scroll inside the monospace diff block, not the page', () => {
    const css = readFileSync(join(import.meta.dirname, '../styles.css'), 'utf8');
    const rule = /pre\.diff \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('overflow-x: auto');
    expect(rule).toContain('max-width: 100%');
    expect(rule).toContain('font-family: var(--font-mono)');
  });
});
