import { describe, expect, it } from 'vitest';

import { useAppState } from './app-state.js';
import { render } from './test-render.js';

function Reader() {
  useAppState();
  return null;
}

describe('useAppState', () => {
  it('throws outside the provider', async () => {
    const original = console.error;
    console.error = () => undefined;
    try {
      await expect(render(<Reader />)).rejects.toThrow('outside <AppStateProvider>');
    } finally {
      console.error = original;
    }
  });
});
