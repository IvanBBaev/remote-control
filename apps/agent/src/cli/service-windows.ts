// The Windows service: a Task Scheduler logon task (M1-08, D22, 06 §5.4).
import { win32 } from 'node:path';

import { utf16le, windowsLauncherVbs, windowsTaskXml } from '../core/windows-task.js';
import type { Container } from '../container.js';
import {
  EXIT_ERROR,
  EXIT_OK,
  attempt,
  firstLine,
  resolveScript,
  type ServiceOptions,
} from './service-shared.js';

/** The scheduled task name (ROADMAP §5 names). */
export const WINDOWS_TASK = 'remotectl';

const DATA_DIR_MODE = 0o700;
/** Ignored on Windows (no POSIX modes); the data directory's ACL applies. */
const FILE_MODE = 0o600;

interface TaskFiles {
  readonly xmlPath: string;
  readonly vbsPath: string;
}

/** The task definition and its launcher, both in the agent's data directory. */
export function windowsTaskFiles(c: Container): TaskFiles {
  return {
    xmlPath: win32.join(c.paths.data, 'service-task.xml'),
    vbsPath: win32.join(c.paths.data, 'service.vbs'),
  };
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  return a !== undefined && a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * `remotectl install [--dry-run]` on Windows: writes the launcher and the task XML,
 * registers the task and starts it. No environment is written: Task Scheduler runs the
 * task with the user's normal environment (see `windowsTaskXml`).
 */
export async function installWindows(c: Container, options: ServiceOptions): Promise<number> {
  const userId = c.service.windowsUser;
  if (userId === undefined) {
    c.output.stderr('remotectl install: cannot determine the Windows user (USERNAME).\n');
    return EXIT_ERROR;
  }
  const script = await resolveScript(c);
  if (!script.ok) {
    c.output.stderr(`remotectl install: ${script.message}\n`);
    return EXIT_ERROR;
  }
  const { xmlPath, vbsPath } = windowsTaskFiles(c);
  const vbs = windowsLauncherVbs([c.service.execPath, script.scriptPath, 'run']);
  const xml = windowsTaskXml({
    description: 'remotectl agent',
    userId,
    launcherPath: vbsPath,
  });
  if (options.dryRun) {
    c.output.stdout(`--- ${vbsPath}\n${vbs.replaceAll('\r\n', '\n')}--- ${xmlPath}\n${xml}`);
    return EXIT_OK;
  }

  const vbsBytes = utf16le(vbs);
  const xmlBytes = utf16le(xml);
  const unchanged =
    sameBytes(await c.fs.readBytes(vbsPath), vbsBytes) &&
    sameBytes(await c.fs.readBytes(xmlPath), xmlBytes);
  const registered = (await attempt(() => c.schtasks.query(WINDOWS_TASK))).code === 0;
  if (unchanged && registered) {
    c.output.stdout(`remotectl is already installed (scheduled task ${WINDOWS_TASK}).\n`);
    return EXIT_OK;
  }
  if (registered) {
    // Stop the running instance so the replaced definition starts fresh; it may not run.
    await attempt(() => c.schtasks.end(WINDOWS_TASK));
  }
  await c.fs.ensureDir(c.paths.data, DATA_DIR_MODE);
  await c.fs.writeBytesAtomic(vbsPath, vbsBytes, FILE_MODE);
  await c.fs.writeBytesAtomic(xmlPath, xmlBytes, FILE_MODE);
  const created = await attempt(() => c.schtasks.create(WINDOWS_TASK, xmlPath));
  if (created.code !== 0) {
    c.output.stderr(
      `remotectl install: wrote ${xmlPath}, but schtasks /Create failed: ${firstLine(created)}\n`,
    );
    return EXIT_ERROR;
  }
  const run = await attempt(() => c.schtasks.run(WINDOWS_TASK));
  if (run.code !== 0) {
    c.output.stderr(
      `remotectl install: registered the task, but schtasks /Run failed: ${firstLine(run)}\n`,
    );
    return EXIT_ERROR;
  }
  c.output.stdout(
    `Installed the scheduled task ${WINDOWS_TASK} (${xmlPath}).\n` +
      'The agent now starts at logon and restarts if it fails.\n' +
      `Service output: ${c.paths.log}\n`,
  );
  return EXIT_OK;
}

/** `remotectl uninstall [--dry-run]` on Windows: ends and deletes the task, removes its files. */
export async function uninstallWindows(c: Container, options: ServiceOptions): Promise<number> {
  const { xmlPath, vbsPath } = windowsTaskFiles(c);
  if (options.dryRun) {
    c.output.stdout(
      `Would run: schtasks /End and /Delete /TN ${WINDOWS_TASK} (if registered)\n` +
        `Would remove: ${vbsPath}\nWould remove: ${xmlPath}\n`,
    );
    return EXIT_OK;
  }
  const registered = (await attempt(() => c.schtasks.query(WINDOWS_TASK))).code === 0;
  if (registered) {
    // `/End` fails when the task is not running; that is fine.
    await attempt(() => c.schtasks.end(WINDOWS_TASK));
    const deleted = await attempt(() => c.schtasks.delete(WINDOWS_TASK));
    if (deleted.code !== 0) {
      c.output.stderr(`remotectl uninstall: schtasks /Delete failed: ${firstLine(deleted)}\n`);
      return EXIT_ERROR;
    }
  }
  const removedVbs = await c.fs.remove(vbsPath);
  const removedXml = await c.fs.remove(xmlPath);
  if (!registered && !removedVbs && !removedXml) {
    c.output.stdout('remotectl is not installed as a service.\n');
    return EXIT_OK;
  }
  c.output.stdout(
    `Uninstalled the service${registered ? ` (scheduled task ${WINDOWS_TASK})` : ''}` +
      `${removedVbs || removedXml ? ' and removed its files' : ''}.\n`,
  );
  return EXIT_OK;
}

/** One `status` line describing the scheduled task. */
export async function windowsStatusLine(c: Container): Promise<string> {
  const { xmlPath } = windowsTaskFiles(c);
  const queried = await attempt(() => c.schtasks.query(WINDOWS_TASK));
  if (queried.code === 0) return `installed (scheduled task ${WINDOWS_TASK}, runs at logon)`;
  return (await c.fs.readBytes(xmlPath)) === undefined
    ? 'not installed (`remotectl install`)'
    : `installed, not registered (${xmlPath}; run \`remotectl install\`)`;
}
