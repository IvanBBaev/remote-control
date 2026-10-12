import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical-json.js';
import { requestHash } from './request-hash.js';
import type { RequestHashInput } from './request-hash.js';

interface RequestVector {
  readonly name: string;
  readonly input: RequestHashInput;
  readonly canonical: string;
  readonly sha256: string;
}

const { vectors } = JSON.parse(
  readFileSync(new URL('../fixtures/v1/request-hash.json', import.meta.url), 'utf8'),
) as { vectors: RequestVector[] };

describe('requestHash (frozen vectors)', () => {
  it.each(vectors)('$name: hash matches', async ({ input, sha256 }) => {
    await expect(requestHash(input)).resolves.toBe(sha256);
  });

  it.each(vectors)('$name: hashes the documented canonical object', ({ input, canonical }) => {
    const subject =
      'toolName' in input
        ? { tool_name: input.toolName, tool_input: input.toolInput }
        : { prompt: input.prompt, cwd: input.cwd };
    expect(canonicalJson(subject)).toBe(canonical);
  });

  it('is a 64-digit lower-case hex string that differs for different tool input', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (a, b) => {
        fc.pre(a !== b);
        const [ha, hb] = await Promise.all([
          requestHash({ toolName: 'Bash', toolInput: { command: a } }),
          requestHash({ toolName: 'Bash', toolInput: { command: b } }),
        ]);
        expect(ha).toMatch(/^[0-9a-f]{64}$/);
        expect(ha).not.toBe(hb);
      }),
      { numRuns: 1000 },
    );
  });

  it('does not confuse a prompt with a tool call', async () => {
    const prompt = await requestHash({ prompt: 'Bash', cwd: '/' });
    const tool = await requestHash({ toolName: 'Bash', toolInput: '/' });
    expect(prompt).not.toBe(tool);
  });
});
