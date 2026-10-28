/**
 * Homoglyph names on an approval card (V3-S03, 02 §4.5, F15 CVE-2021-42694): a host or
 * package name that mixes Latin letters with look-alike letters of another script
 * (`exаmple.com` with a Cyrillic `а`) gets a warning naming the foreign letters.
 */

/** Scripts whose letters pass for Latin ones; mixing any two of them is suspicious. */
const LOOK_ALIKE_SCRIPTS = [
  ['Latin', /\p{Script=Latin}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Armenian', /\p{Script=Armenian}/u],
  ['Cherokee', /\p{Script=Cherokee}/u],
] as const;

type Script = (typeof LOOK_ALIKE_SCRIPTS)[number][0];

function scriptOf(char: string): Script | undefined {
  return LOOK_ALIKE_SCRIPTS.find(([, pattern]) => pattern.test(char))?.[0];
}

/** One name that mixes look-alike scripts. */
export interface MixedScriptName {
  /** The name as it appears in the text. */
  readonly name: string;
  /** The scripts it mixes, Latin first when present. */
  readonly scripts: readonly string[];
  /** The letters outside the name's main script, as `U+0430`. */
  readonly letters: readonly string[];
}

/**
 * A name-like token: letters, digits and the punctuation of hosts, URLs, paths and
 * package names (`@scope/pkg`, `a.b-c_d`). Quotes, spaces and shell operators split.
 */
const NAME = /[\p{L}\p{M}\p{N}._@/:+~-]+/gu;

const codeOf = (char: string) =>
  `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * Every distinct name in `text` that mixes letters of two look-alike scripts, in order of
 * appearance. A name in one script only (`пример.рф`, `naïve`) is fine.
 */
export function mixedScriptNames(text: string): MixedScriptName[] {
  const found = new Map<string, MixedScriptName>();
  for (const [name] of text.matchAll(NAME)) {
    if (found.has(name)) continue;
    const counts = new Map<Script, string[]>();
    for (const char of name) {
      const script = scriptOf(char);
      if (script !== undefined) counts.set(script, [...(counts.get(script) ?? []), char]);
    }
    if (counts.size < 2) continue;
    const scripts = [...counts.keys()].sort((a, b) =>
      a === 'Latin' ? -1 : b === 'Latin' ? 1 : counts.get(b)!.length - counts.get(a)!.length,
    );
    const letters = [
      ...new Set(
        scripts
          .slice(1)
          .flatMap((script) => counts.get(script)!)
          .map(codeOf),
      ),
    ];
    found.set(name, { name, scripts, letters });
  }
  return [...found.values()];
}

/**
 * Punycode host labels (`xn--`): an international name spelled in ASCII, which can hide
 * a look-alike once the browser or tool decodes it.
 */
export function punycodeNames(text: string): string[] {
  const found = new Set<string>();
  for (const [name] of text.matchAll(NAME)) {
    if (/(^|[./@:])xn--/i.test(name)) found.add(name);
  }
  return [...found];
}
