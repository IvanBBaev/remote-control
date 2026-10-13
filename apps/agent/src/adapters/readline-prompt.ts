import { createInterface } from 'node:readline/promises';

import type { Prompt } from '../ports/prompt.js';

/**
 * `Prompt` on a terminal (stdin/stdout by default). Only `y` or `yes` (any case) is a
 * yes; end of input or an abort is a no.
 */
export function createReadlinePrompt(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Prompt {
  return {
    async confirm(question, signal) {
      if (signal.aborted) return false;
      const rl = createInterface({ input, output, terminal: false });
      const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
      try {
        const answer = await Promise.race([rl.question(`${question} [y/N] `, { signal }), closed]);
        return answer !== null && /^y(es)?$/i.test(answer.trim());
      } catch {
        return false;
      } finally {
        rl.close();
      }
    },
  };
}
