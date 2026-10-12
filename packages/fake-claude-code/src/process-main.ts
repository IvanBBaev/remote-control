import { systemClock } from './adapters/system-clock.js';
import { systemRandom } from './adapters/system-random.js';
import { main } from './cli.js';

/** Runs the CLI against the real process (used by `bin/fake-claude.mjs`). */
export async function runFromProcess(): Promise<void> {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    clock: systemClock,
    random: systemRandom,
    pid: process.pid,
  });
}
