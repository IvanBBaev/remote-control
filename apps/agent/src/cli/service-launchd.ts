// The macOS service: a launchd user agent (M0-24, D22, 06 §5.4).
import { posix } from 'node:path';

import { launchdPlist } from '../core/launchd-plist.js';
import type { Container } from '../container.js';
import {
  EXIT_ERROR,
  EXIT_OK,
  resolveScript,
  servicePath,
  type ServiceOptions,
} from './service-shared.js';

/** The launchd label (ROADMAP §5 names). */
export const LAUNCHD_LABEL = 'dev.remotectl.agent';
export const LAUNCHD_STDOUT_FILE = 'launchd.out.log';
export const LAUNCHD_STDERR_FILE = 'launchd.err.log';

const LAUNCH_AGENTS_DIR_MODE = 0o755;
const PLIST_MODE = 0o644;
const LOG_DIR_MODE = 0o700;
/** launchd's own default when a job sets no `PATH`. */
const FALLBACK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** `~/Library/LaunchAgents/dev.remotectl.agent.plist` under the injected home. */
export function launchdPlistPath(c: Container): string {
  return posix.join(c.service.homedir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function launchdDomain(c: Container): string | undefined {
  return c.service.uid === undefined ? undefined : `gui/${c.service.uid}`;
}

/** `remotectl install [--dry-run]`: writes and bootstraps the launchd user agent. */
export async function installLaunchd(c: Container, options: ServiceOptions): Promise<number> {
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
    environment: { HOME: c.service.homedir, PATH: servicePath(c, FALLBACK_PATH) },
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

/** `remotectl uninstall [--dry-run]`: boots the agent out and removes its plist. */
export async function uninstallLaunchd(c: Container, options: ServiceOptions): Promise<number> {
  const domain = launchdDomain(c);
  if (domain === undefined) {
    c.output.stderr('remotectl uninstall: cannot determine the user id.\n');
    return EXIT_ERROR;
  }
  const plistPath = launchdPlistPath(c);
  const target = `${domain}/${LAUNCHD_LABEL}`;
  if (options.dryRun) {
    c.output.stdout(
      `Would run: launchctl bootout ${target} (if loaded)\nWould remove: ${plistPath}\n`,
    );
    return EXIT_OK;
  }
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
export async function launchdStatusLine(c: Container): Promise<string> {
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
