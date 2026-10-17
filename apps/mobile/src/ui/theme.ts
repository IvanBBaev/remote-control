import type { SFSymbol } from 'expo-symbols';

import type { AgentState, HistoryOutcome } from '../core/model';

/** Dark only: the app is used at a glance, often at night, like Coucou. */
export const colors = {
  background: '#0B0D10',
  surface: '#15181D',
  surfaceRaised: '#1C2027',
  border: '#262B33',
  text: '#F2F4F7',
  textSecondary: '#9AA3AF',
  textTertiary: '#5F6773',
  brand: '#2563EB',
  orange: '#FF9F0A',
  cyan: '#64D2FF',
  red: '#FF453A',
  green: '#30D158',
  blue: '#0A84FF',
  gray: '#8E8E93',
} as const;

export const radius = { card: 18, row: 16, pill: 999, button: 14 } as const;

export const mono = 'Menlo';

interface Tone {
  readonly color: string;
  /** The badge text, as in the Island's compact view. */
  readonly glyph: string;
  readonly label: string;
}

/** orange = needs an OK, cyan = a question, red = an error, green = done (ADR 0017). */
export const TONES: Readonly<Record<AgentState, Tone>> = {
  'needs-ok': { color: colors.orange, glyph: 'OK?', label: 'Needs your OK' },
  question: { color: colors.cyan, glyph: '?', label: 'Has a question' },
  error: { color: colors.red, glyph: '!', label: 'Stopped on an error' },
  working: { color: colors.blue, glyph: '•••', label: 'Working' },
  done: { color: colors.green, glyph: '✓', label: 'Done' },
  idle: { color: colors.gray, glyph: '–', label: 'Idle' },
};

export const OUTCOMES: Readonly<
  Record<
    HistoryOutcome,
    { readonly color: string; readonly symbol: SFSymbol; readonly label: string }
  >
> = {
  allow: { color: colors.green, symbol: 'checkmark.circle.fill', label: 'Allowed' },
  always: { color: colors.green, symbol: 'checkmark.seal.fill', label: 'Always allowed' },
  deny: { color: colors.red, symbol: 'xmark.circle.fill', label: 'Denied' },
  answer: { color: colors.cyan, symbol: 'questionmark.bubble.fill', label: 'Answered' },
  instruct: { color: colors.blue, symbol: 'paperplane.fill', label: 'Instructed' },
  expired: { color: colors.gray, symbol: 'clock.badge.xmark', label: 'Expired' },
};

/** `color` at `alpha` (0–1), for tinted backgrounds. */
export function tint(color: string, alpha: number): string {
  return `${color}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`;
}
