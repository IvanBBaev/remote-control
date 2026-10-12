// Entry of `hook.cjs` (D11): bundled to CommonJS with Node builtins only and copied by
// `remotectl hooks install` next to `agent.json` in the data directory. Exit code is
// always 0; see `run-hook.ts` for the contract.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runHook } from './run-hook.js';

const exit = (): never => process.exit(0);
process.on('uncaughtException', exit);
process.on('unhandledRejection', exit);

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

void runHook({
  argv: process.argv.slice(2),
  readStdin,
  readEndpoint: () => readFile(join(__dirname, 'agent.json'), 'utf8'),
  write: (text) =>
    new Promise<void>((resolve) => {
      process.stdout.write(text, () => resolve());
    }),
}).finally(exit);
