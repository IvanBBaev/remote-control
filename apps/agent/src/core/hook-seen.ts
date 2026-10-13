import type { Clock } from '../ports/clock.js';
import type { HookSeenStore } from '../ports/hook-seen-store.js';
import type { PathPort } from '../ports/path-port.js';

export interface HookSeenTrackerOptions {
  /** `repositories` from the config, as written there. */
  readonly roots: readonly string[];
  readonly paths: PathPort;
  readonly clock: Clock;
  readonly store: HookSeenStore;
  /** A root saw its first hook (the phones get a new snapshot). */
  readonly onChange?: () => void;
}

/** Which allow-listed repositories have sent a hook (M1-07, 04 §2.6). */
export interface HookSeenTracker {
  /** Records the root `cwd` lies in, once; resolves when it is stored. */
  observe(cwd: string): Promise<void>;
  /** The roots a hook came from (this run and earlier ones). */
  seen(): Promise<ReadonlySet<string>>;
}

export function createHookSeenTracker(options: HookSeenTrackerOptions): HookSeenTracker {
  const { paths, store } = options;
  let known: Promise<Set<string>> | undefined;
  const load = (): Promise<Set<string>> =>
    (known ??= store.read().then((roots) => new Set(Object.keys(roots))));

  return {
    async observe(cwd) {
      const seen = await load();
      const unseen = options.roots.filter((root) => !seen.has(root));
      if (unseen.length === 0) return;
      const real = await paths.realpath(cwd);
      if (real === undefined) return;
      for (const root of unseen) {
        const realRoot = await paths.realpath(root);
        if (realRoot === undefined || !paths.contains(realRoot, real) || seen.has(root)) continue;
        seen.add(root);
        await store.record(root, options.clock.now());
        options.onChange?.();
      }
    },
    seen: load,
  };
}
