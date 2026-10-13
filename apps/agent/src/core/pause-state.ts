import { z } from 'zod';

/**
 * `remotectl pause` (M1-03): while paused, the agent hands every blocking hook straight
 * back to the terminal (D10 handoff) and nothing reaches the phones. Kept on this
 * computer only.
 */
export const PauseFile = z
  .object({
    version: z.literal(1),
    /** When `remotectl pause` ran (epoch ms). */
    pausedAt: z.number().int().nonnegative(),
    /** When the pause ends by itself (epoch ms); `null` = until `remotectl resume`. */
    until: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type PauseFile = z.infer<typeof PauseFile>;

/** The longest `--for` accepted: a pause is a short-term switch, not a configuration. */
export const MAX_PAUSE_MS = 30 * 24 * 60 * 60 * 1000;

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const DURATION_PATTERN = /^([1-9]\d{0,5})([mhd])$/;

/**
 * A `--for` duration such as `30m`, `2h` or `1d`, in milliseconds; `undefined` for
 * anything else (no unit, zero, fractions, combined units, or more than {@link MAX_PAUSE_MS}).
 */
export function parseDuration(text: string): number | undefined {
  const match = DURATION_PATTERN.exec(text.trim());
  if (match === null) return undefined;
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  return ms <= MAX_PAUSE_MS ? ms : undefined;
}

/** The pause file a `remotectl pause` at `now` writes; `durationMs` absent = no expiry. */
export function pauseAt(now: number, durationMs?: number): PauseFile {
  return { version: 1, pausedAt: now, until: durationMs === undefined ? null : now + durationMs };
}

/** Whether `state` pauses the agent at `now`; an expired pause no longer does. */
export function isPaused(state: PauseFile | undefined, now: number): boolean {
  return state !== undefined && (state.until === null || now < state.until);
}

/** The `remotectl status` value: `not paused`, `paused` or `paused until <ISO time>`. */
export function pauseStatusText(state: PauseFile | undefined, now: number): string {
  if (state === undefined || !isPaused(state, now)) return 'not paused';
  return state.until === null ? 'paused' : `paused until ${new Date(state.until).toISOString()}`;
}

/** The pause file, or `undefined` when the text is not one (a corrupt file = not paused). */
export function parsePause(text: string): PauseFile | undefined {
  try {
    const parsed = PauseFile.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
