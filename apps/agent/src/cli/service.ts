// `remotectl install | uninstall` and the service line of `status` (M0-24, D22, 06 §5.4).
// macOS only for now: a launchd user agent. Linux and Windows follow in M1-08.
import { posix } from 'node:path';

import { installLocationProblem } from '../core/install-location-problem.js';
import { launchdPlist } from '../core/launchd-plist.js';
import type { Container } from '../container.js';

/** The launchd label (ROADMAP §5 names). */
export const LAUNCHD_LABEL = 'dev.remotectl.agent';
export const LAUNCHD_STDOUT_FILE = 'launchd.out.log';
export const LAUNCHD_STDERR_FILE = 'launchd.err.log';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const LAUNCH_AGENTS_DIR_MODE = 0o755;
const PLIST_MODE = 0o644;
const LOG_DIR_MODE = 0o700;
/** launchd's own default when a job sets no `PATH`. */
const FALLBACK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export interface InstallOptions {
  readonly dryRun: boolean;
}

/** `~/Library/LaunchAgents/dev.remotectl.agent.plist` under the injected home. */
export function launchdPlistPath(c: Container): string {
  return posix.join(c.service.homedir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function unsupported(c: Container, command: string): number {
  c.output.stderr(
    `remotectl ${command}: running as a service is not supported on ${c.platform} yet ` +
      '(planned in M1-08); use `remotectl run` in a terminal meanwhile.\n',
  );
  return EXIT_ERROR;
}

function launchdDomain(c: Container): string | undefined {
  return c.service.uid === undefined ? undefined : `gui/${c.service.uid}`;
}

/** The service `PATH`: the installing shell's, with the Node binary's directory first. */
function servicePath(c: Container): string {
  const nodeDir = posix.dirname(c.service.execPath);
  const entries = (c.service.pathEnv ?? FALLBACK_PATH).split(':').filter((entry) => entry !== '');
  return [nodeDir, ...entries.filter((entry) => entry !== nodeDir)].join(':');
}

type Resolved = { ok: true; scriptPath: string } | { ok: false; message: string };

/** The real path of the running CLI, refused when it is not a stable global install. */
async function resolveScript(c: Container): Promise<Resolved> {
  const invoked = c.service.scriptPath;
  const real = invoked === undefined ? undefined : await c.pathPort.realpath(invoked);
  if (real === undefined) {
    return { ok: false, message: 'cannot locate the remotectl entry script' };
  }
  const tmp = (await c.pathPort.realpath(c.service.tmpdir)) ?? c.service.tmpdir;
  const problem = installLocationProblem(real, tmp);
  if (problem !== undefined) {
    return {
      ok: false,
      message:
        `${problem} (${real}), which can disappear at any time, so a service cannot point ` +
        'at it.\nInstall remotectl globally first, then install the service from there:\n' +
        '  npm install -g remotectl\n  remotectl install',
    };
  }
  return { ok: true, scriptPath: real };
}

/** `remotectl install [--dry-run]`: writes and bootstraps the launchd user agent. */
export async function installService(c: Container, options: InstallOptions): Promise<number> {
  if (c.platform !== 'darwin') return unsupported(c, 'install');
  const domain = launchdDomain(c);
  if (domain === undefined) {
    c.output.stderr('remotectl install: cannot determine the user id.\n');
    return EXIT_ERROR;
  }
  const script = await resolveScript(c);
  if (!script.ok) {
    c.output.stderr(`remotectl install: ${script.message}\n`);
    return EXIT_ERROR;
  }
  const plist = launchdPlist({
    label: LAUNCHD_LABEL,
    programArguments: [c.service.execPath, script.scriptPath, 'run'],
    environment: { HOME: c.service.homedir, PATH: servicePath(c) },
    stdoutPath: posix.join(c.paths.log, LAUNCHD_STDOUT_FILE),
    stderrPath: posix.join(c.paths.log, LAUNCHD_STDERR_FILE),
  });
  if (options.dryRun) {
    c.output.stdout(plist);
    return EXIT_OK;
  }

  const plistPath = launchdPlistPath(c);
  const target = `${domain}/${LAUNCHD_LABEL}`;
  const existing = await c.fs.readText(plistPath);
  const loaded = (await c.launchctl.print(target)).code === 0;
  if (existing === plist && loaded) {
    c.output.stdout(`remotectl is already installed and loaded (${plistPath}).\n`);
    return EXIT_OK;
  }
  if (loaded) {
    // A changed definition only takes effect after an unload.
    const out = await c.launchctl.bootout(target);
    if (out.code !== 0) {
      c.output.stderr(`remotectl install: launchctl bootout failed: ${out.stderr.trim()}\n`);
      return EXIT_ERROR;
    }
  }
  await c.fs.ensureDir(c.paths.log, LOG_DIR_MODE);
  await c.fs.ensureDir(posix.dirname(plistPath), LAUNCH_AGENTS_DIR_MODE);
  await c.fs.writeTextAtomic(plistPath, plist, PLIST_MODE);
  const boot = await c.launchctl.bootstrap(domain, plistPath);
  if (boot.code !== 0) {
    c.output.stderr(
      `remotectl install: wrote ${plistPath}, but launchctl bootstrap failed ` +
        `(exit ${boot.code}): ${boot.stderr.trim()}\n`,
    );
    return EXIT_ERROR;
  }
  c.output.stdout(
    `Installed ${plistPath}\nThe agent now starts at login and restarts if it exits.\n` +
      `Service output: ${posix.join(c.paths.log, LAUNCHD_STDOUT_FILE)}\n`,
  );
  return EXIT_OK;
}

/** `remotectl uninstall`: boots the agent out and removes its plist. */
export async function uninstallService(c: Container): Promise<number> {
  if (c.platform !== 'darwin') return unsupported(c, 'uninstall');
  const domain = launchdDomain(c);
  if (domain === undefined) {
    c.output.stderr('remotectl uninstall: cannot determine the user id.\n');
    return EXIT_ERROR;
  }
  const plistPath = launchdPlistPath(c);
  const target = `${domain}/${LAUNCHD_LABEL}`;
  const loaded = (await c.launchctl.print(target)).code === 0;
  if (loaded) {
    const out = await c.launchctl.bootout(target);
    if (out.code !== 0) {
      c.output.stderr(`remotectl uninstall: launchctl bootout failed: ${out.stderr.trim()}\n`);
      return EXIT_ERROR;
    }
  }
  const removed = await c.fs.remove(plistPath);
  if (!loaded && !removed) {
    c.output.stdout('remotectl is not installed as a service.\n');
    return EXIT_OK;
  }
  c.output.stdout(`Uninstalled the service${removed ? ` and removed ${plistPath}` : ''}.\n`);
  return EXIT_OK;
}

function field(text: string, name: string): string | undefined {
  return new RegExp(`^\\s*${name} = (.+)$`, 'm').exec(text)?.[1]?.trim();
}

/** One `status` line describing the service as launchctl sees it. */
export async function serviceStatusLine(c: Container): Promise<string> {
  if (c.platform !== 'darwin') return `not supported on ${c.platform} yet (M1-08)`;
  const domain = launchdDomain(c);
  if (domain === undefined) return 'unknown (no user id)';
  const plistPath = launchdPlistPath(c);
  const installed = (await c.fs.readText(plistPath)) !== undefined;
  const printed = await c.launchctl.print(`${domain}/${LAUNCHD_LABEL}`);
  if (printed.code !== 0) {
    return installed
      ? `installed, not loaded (${plistPath}; run \`remotectl install\`)`
      : 'not installed (`remotectl install`)';
  }
  const state = field(printed.stdout, 'state') ?? 'unknown';
  const pid = field(printed.stdout, 'pid');
  const lastExit = field(printed.stdout, 'last exit code');
  const details = [
    pid === undefined ? undefined : `pid ${pid}`,
    lastExit === undefined ? undefined : `last exit ${lastExit}`,
  ].filter((part) => part !== undefined);
  return `loaded, ${state}${details.length > 0 ? ` (${details.join(', ')})` : ''}${
    installed ? '' : ' — plist missing'
  }`;
}
