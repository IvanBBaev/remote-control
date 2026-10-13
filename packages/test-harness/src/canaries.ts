/**
 * Canary strings (07 §5.12): every fixture payload a scenario puts on the wire carries
 * one, so a post-run scan of the relay logs and push bodies proves the relay never saw
 * plaintext (I1) and never logged a payload (I2).
 */
export interface Canaries {
  /** A fresh canary tagged with `label`, recorded for the scan. */
  mint(label: string): string;
  /** Every canary minted so far. */
  all(): readonly string[];
}

export function createCanaries(prefix = 'rc-canary'): Canaries {
  const minted: string[] = [];
  return {
    mint(label) {
      const canary = `${prefix}-${label}-${String(minted.length + 1)}`;
      minted.push(canary);
      return canary;
    },
    all: () => [...minted],
  };
}
