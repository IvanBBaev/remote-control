/**
 * Hidden and direction-changing characters on an approval card (V3-S03, 02 §4.5, F15
 * Trojan Source). The card never lets such a character act: each one is shown as a
 * visible `⟨U+XXXX⟩` marker in its place, and the card counts them, so what the user
 * reads is the text the agent will run, in its logical order. The agent applies the same
 * reveal to the push summary (V3-S03b); a marker contains no hidden character, so a
 * second reveal on the phone changes nothing.
 */

/** Why a character is shown as a marker. */
export type HiddenKind = 'bidi' | 'invisible' | 'control';

/** Bidi embeddings, overrides, isolates and marks (CVE-2021-42574). */
const BIDI: readonly (readonly [number, number])[] = [
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

/** Zero-width and otherwise invisible characters that change what a name or command is. */
const INVISIBLE: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180e],
  [0x200b, 0x200d],
  [0x2060, 0x2064],
  [0x206a, 0x206f],
  [0x3164, 0x3164],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe007f],
];

const inRanges = (code: number, ranges: readonly (readonly [number, number])[]) =>
  ranges.some(([from, to]) => code >= from && code <= to);

/**
 * The kind of a hidden character, `undefined` for one that shows as itself. A line feed
 * and a tab are layout and stay; a carriage return can overwrite a line in a terminal,
 * so it is a control like the rest of C0, DEL, C1 and the Unicode line separators.
 */
export function hiddenKind(code: number): HiddenKind | undefined {
  if (inRanges(code, BIDI)) return 'bidi';
  if (inRanges(code, INVISIBLE)) return 'invisible';
  if (code === 0x0a || code === 0x09) return undefined;
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
    return 'control';
  }
  return undefined;
}

/** `⟨U+202E⟩`: the visible stand-in for one hidden character. */
export function marker(code: number): string {
  return `⟨U+${code.toString(16).toUpperCase().padStart(4, '0')}⟩`;
}

/** One run of a revealed text: plain text, or the marker of one hidden character. */
export type RevealedPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: HiddenKind; readonly text: string; readonly code: number };

/** A text with every hidden character replaced by its marker, and the counts. */
export interface RevealedText {
  /** The runs, for a renderer that styles the markers. */
  readonly parts: readonly RevealedPart[];
  /** The runs joined: the text as the card shows it. */
  readonly text: string;
  readonly bidi: number;
  readonly invisible: number;
  readonly control: number;
}

/** Replaces each hidden character of `text` by its marker, keeping everything else. */
export function revealHidden(text: string): RevealedText {
  const parts: RevealedPart[] = [];
  const counts = { bidi: 0, invisible: 0, control: 0 };
  let run = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const kind = hiddenKind(code);
    if (kind === undefined) {
      run += char;
      continue;
    }
    if (run !== '') parts.push({ kind: 'text', text: run });
    run = '';
    parts.push({ kind, text: marker(code), code });
    counts[kind] += 1;
  }
  if (run !== '') parts.push({ kind: 'text', text: run });
  return { parts, text: parts.map((part) => part.text).join(''), ...counts };
}

/** How many hidden characters a revealed text had. */
export function hiddenCount(revealed: RevealedText): number {
  return revealed.bidi + revealed.invisible + revealed.control;
}
