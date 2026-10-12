import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CanonicalDecision } from './canonical-decision.js';
import { canonicalJson } from './canonical-json.js';
import { decisionChallenge } from './decision-challenge.js';
import { decisionHash } from './decision-hash.js';

interface DecisionVector {
  readonly name: string;
  readonly decision: CanonicalDecision;
  readonly canonical: string;
  readonly sha256: string;
  readonly challenge: string;
}

const { vectors } = JSON.parse(
  readFileSync(new URL('../fixtures/v1/decision-hash.json', import.meta.url), 'utf8'),
) as { vectors: DecisionVector[] };

describe('decisionHash (frozen D7 vectors)', () => {
  it('includes the 02 §7.2 reference vector', () => {
    expect(vectors[0]?.sha256).toBe(
      'dff6fb689e9190f30988151085b076973b2a07f52f990f5ec9771ffbdd596c7b',
    );
  });

  it.each(vectors)('$name: canonical bytes match', ({ decision, canonical }) => {
    expect(canonicalJson(decision)).toBe(canonical);
  });

  it.each(vectors)('$name: hash matches', async ({ decision, sha256 }) => {
    await expect(decisionHash(decision)).resolves.toBe(sha256);
  });

  it.each(vectors)('$name: challenge matches', async ({ decision, challenge }) => {
    await expect(decisionChallenge(decision)).resolves.toBe(challenge);
  });

  it('does not depend on field order', async () => {
    const [vector] = vectors;
    if (vector === undefined) throw new Error('missing vector');
    const reversed = Object.fromEntries(
      Object.entries(vector.decision).reverse(),
    ) as CanonicalDecision;
    await expect(decisionHash(reversed)).resolves.toBe(vector.sha256);
  });

  it('changes when any bound field changes', async () => {
    const [, vector] = vectors;
    if (vector === undefined) throw new Error('missing vector');
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...(Object.keys(vector.decision) as (keyof CanonicalDecision)[])),
        async (field) => {
          const original = vector.decision[field];
          const changed = typeof original === 'number' ? original + 1 : `${String(original)}x`;
          const hash = await decisionHash({ ...vector.decision, [field]: changed });
          expect(hash).not.toBe(vector.sha256);
        },
      ),
      { numRuns: 100 },
    );
  });
});
