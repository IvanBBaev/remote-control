import { describe, expect, it } from 'vitest';

import type { HookSeenStore } from '../ports/hook-seen-store.js';
import type { PathPort } from '../ports/path-port.js';
import { createHookSeenTracker } from './hook-seen.js';

/** Paths resolve to themselves, except `/link` → `/src/api`; `/gone` does not exist. */
const paths = {
  realpath: (path: string) =>
    Promise.resolve(path.startsWith('/gone') ? undefined : path.replace(/^\/link/, '/src/api')),
  contains: (root: string, path: string) => path === root || path.startsWith(`${root}/`),
} as Partial<PathPort> as PathPort;

function memoryStore(initial: Record<string, number> = {}) {
  const roots = { ...initial };
  let reads = 0;
  const store: HookSeenStore = {
    read: () => {
      reads += 1;
      return Promise.resolve({ ...roots });
    },
    record: (root, at) => {
      roots[root] ??= at;
      return Promise.resolve();
    },
  };
  return { store, roots, reads: () => reads };
}

describe('createHookSeenTracker (M1-07)', () => {
  it('records the root a hook came from, once, and tells the phones', async () => {
    const memory = memoryStore();
    let changes = 0;
    const tracker = createHookSeenTracker({
      roots: ['/src/api', '/src/web'],
      paths,
      clock: { now: () => 42 },
      store: memory.store,
      onChange: () => (changes += 1),
    });
    await tracker.observe('/src/api/lib');
    await tracker.observe('/link/test');
    expect(memory.roots).toEqual({ '/src/api': 42 });
    expect(changes).toBe(1);
    expect([...(await tracker.seen())]).toEqual(['/src/api']);
  });

  it('ignores a folder outside the allow-list and a missing one', async () => {
    const memory = memoryStore();
    const tracker = createHookSeenTracker({
      roots: ['/src/api', '/gone/repo'],
      paths,
      clock: { now: () => 1 },
      store: memory.store,
    });
    await tracker.observe('/elsewhere');
    await tracker.observe('/gone/x');
    expect(memory.roots).toEqual({});
  });

  it('starts from what earlier runs recorded and stops looking once all are seen', async () => {
    const memory = memoryStore({ '/src/api': 7 });
    const tracker = createHookSeenTracker({
      roots: ['/src/api'],
      paths,
      clock: { now: () => 9 },
      store: memory.store,
    });
    expect([...(await tracker.seen())]).toEqual(['/src/api']);
    await tracker.observe('/src/api');
    expect(memory.roots).toEqual({ '/src/api': 7 });
    expect(memory.reads()).toBe(1);
  });
});
