import { describe, expect, it, vi } from 'vitest';

import { browserMediaQuery } from './browser-media-query.js';

describe('browser media query', () => {
  it('reads the list and forwards its change events until unsubscribed', () => {
    const listeners = new Set<() => void>();
    const list = {
      matches: false,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    };
    const matchMedia = vi.fn(() => list);
    const query = browserMediaQuery({ matchMedia } as never, '(min-width: 900px)');
    expect(matchMedia).toHaveBeenCalledWith('(min-width: 900px)');
    expect(query.matches()).toBe(false);

    const onChange = vi.fn();
    const unsubscribe = query.subscribe(onChange);
    list.matches = true;
    for (const listener of listeners) listener();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(query.matches()).toBe(true);
    unsubscribe();
    expect(listeners.size).toBe(0);
  });
});
