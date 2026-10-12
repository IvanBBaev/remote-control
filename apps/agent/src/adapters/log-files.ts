import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Base name of the agent log; pino-roll numbers it `agent.1.log`, `agent.2.log`, … */
export const LOG_FILE = 'agent.log';
const ROLLED = /^agent\.(\d+)\.log$/;

/** The newest rolled log file in `dir`, or `undefined` when there is none yet. */
export async function newestLogFile(dir: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  let best: { n: number; name: string } | undefined;
  for (const name of names) {
    const match = ROLLED.exec(name);
    if (match === null) continue;
    const n = Number(match[1]);
    if (best === undefined || n > best.n) best = { n, name };
  }
  return best === undefined ? undefined : join(dir, best.name);
}

/** Size in bytes, or 0 when the file vanished (rotated away). */
export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Reads `[start, end)` of a file as UTF-8. */
export async function readRange(path: string, start: number, end: number): Promise<string> {
  if (end <= start) return '';
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
