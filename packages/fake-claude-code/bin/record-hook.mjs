#!/usr/bin/env node
// Hook recorder for M0-23 / `fixtures:anonymise` (07 §5.4): register it as a `command`
// hook (`node <path>/record-hook.mjs <dir>`); it saves the raw stdin payload as
// `<dir>/<Event>-NNNN.json`. It never decides, prints nothing and always exits 0, so it
// cannot change Claude Code's behaviour. Raw recordings contain real paths and prompts and
// must never be committed; only the anonymised output is.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const dir = resolve(process.argv[2] ?? process.env.RECORD_HOOK_DIR ?? 'hook-recordings');
  const raw = await readStdin();
  const parsed = JSON.parse(raw);
  const event = typeof parsed.hook_event_name === 'string' ? parsed.hook_event_name : 'Unknown';
  mkdirSync(dir, { recursive: true });
  let index = readdirSync(dir).length;
  for (;;) {
    const file = join(
      dir,
      `${event.replace(/[^\w-]/g, '_')}-${String(index).padStart(4, '0')}.json`,
    );
    try {
      // Exclusive create: parallel hooks never overwrite each other.
      writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, { flag: 'wx' });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      index += 1;
    }
  }
} catch {
  // A recorder must never break the session it observes.
}
process.exitCode = 0;
