import { AlwaysDestination, PermissionMode } from '@remote-control/protocol';
import { z } from 'zod';

/** Default hold for a blocking hook (D10, Q3): 30 minutes, then handoff to the terminal. */
export const DEFAULT_HOLD_SECONDS = 1800;
/** Lower bound: the pending store answers at `T − 10 s`, so a hold must leave room for it. */
export const MIN_HOLD_SECONDS = 30;
/** Upper bound: one day. Claude Code documents no maximum; this keeps typos sane. */
export const MAX_HOLD_SECONDS = 86_400;
/** Loopback port of the hook receiver (D11, ROADMAP §5); agenthropic uses 4317. */
export const DEFAULT_HOOK_PORT = 4327;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isRelayUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'wss:') return true;
  // Plain ws only for a relay on this machine (development).
  return url.protocol === 'ws:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * A repository root as written in the config file. Whitespace at either end is refused
 * rather than trimmed: `/repo ` and `/repo` are different directories (02 W12 fixtures).
 * Absoluteness is platform-specific and checked by `parseConfig` through the `PathPort`.
 */
const RepositoryRoot = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, 'must not start or end with whitespace')
  .refine((value) => !value.includes('\0'), 'must not contain a NUL character');

/** The bound a repository gets when the config names only its root (M2-09). */
export const DEFAULT_MAX_PERMISSION_MODE: PermissionMode = 'default';

/**
 * An allow-listed repository: a bare root, or `{ path, maxPermissionMode }` to let the
 * phone start sessions there in a mode up to that bound (M2-09, 04 §5.4). Both forms
 * read as the object form.
 */
const RepositoryEntry = z.preprocess(
  (entry) => (typeof entry === 'string' ? { path: entry } : entry),
  z.strictObject({
    path: RepositoryRoot,
    maxPermissionMode: PermissionMode.default(DEFAULT_MAX_PERMISSION_MODE),
  }),
);
export type RepositoryEntry = z.infer<typeof RepositoryEntry>;

/**
 * The agent config file (`config.json` in the env-paths config dir). It is local only:
 * no protocol message can change it (02 §4.1, Q17), and the repository allow-list is
 * editable only here.
 */
export const AgentConfig = z
  .object({
    /**
     * Repository allow-list: absolute roots, each with its permission-mode bound; checked
     * with `realpath` at use time (D13).
     */
    repositories: z
      .array(RepositoryEntry)
      .refine(
        (list) => new Set(list.map((entry) => entry.path)).size === list.length,
        'must not repeat a repository',
      )
      .default([]),
    hooks: z
      .object({
        holdSeconds: z
          .int()
          .min(MIN_HOLD_SECONDS)
          .max(MAX_HOLD_SECONDS)
          .default(DEFAULT_HOLD_SECONDS),
        /**
         * Loopback port of the hook receiver. `hook.js` reads the bound port from
         * `agent.json`, so any free port works; 0 picks one (tests).
         */
        port: z.int().min(0).max(65_535).default(DEFAULT_HOOK_PORT),
      })
      .strict()
      .default({ holdSeconds: DEFAULT_HOLD_SECONDS, port: DEFAULT_HOOK_PORT }),
    agent: z
      .object({
        /** What a pending request does at its deadline (D10): `handoff` (default) or `deny`. */
        onExpire: z.enum(['handoff', 'deny']).default('handoff'),
      })
      .strict()
      .default({ onExpire: 'handoff' }),
    always: z
      .object({
        /**
         * Where "Always" from the phone may store rules (D24, M2-07). The session always;
         * `localSettings` / `projectSettings` only when listed here, since they persist.
         */
        destinations: z
          .array(AlwaysDestination)
          .min(1)
          .refine((list) => list.includes('session'), 'must include "session"')
          .refine((list) => new Set(list).size === list.length, 'must not repeat a destination')
          .default(['session']),
      })
      .strict()
      .default({ destinations: ['session'] }),
    notifications: z
      .object({
        /** Push when a turn finishes (`Stop`, M2-08). Off by default. */
        turnFinished: z.boolean().default(false),
        /** Push when the agent waits for input (`agent_needs_input`, M2-08). Off by default. */
        needsInput: z.boolean().default(false),
      })
      .strict()
      .default({ turnFinished: false, needsInput: false }),
    relay: z
      .object({
        /** Relay WebSocket origin; `wss:` (or `ws:` on loopback for development). */
        url: z.string().refine(isRelayUrl, 'must be a wss: URL (ws: only on loopback)'),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AgentConfig = z.infer<typeof AgentConfig>;
