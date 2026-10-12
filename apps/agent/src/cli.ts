#!/usr/bin/env node
import { homedir, tmpdir } from 'node:os';

import { runCli } from './cli/main.js';
import { createContainer } from './container.js';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => controller.abort());
}

const container = createContainer({
  platform: process.platform,
  env: process.env,
  homedir: homedir(),
  tmpdir: tmpdir(),
  output: {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
});

try {
  process.exitCode = await runCli(process.argv.slice(2), container, { signal: controller.signal });
} catch (error) {
  process.stderr.write(`remotectl: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
