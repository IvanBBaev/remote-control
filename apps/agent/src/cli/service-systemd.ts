// The Linux service: a systemd user unit plus lingering (M1-08, D22, 06 §5.4).
import { posix } from 'node:path';

import { systemdUnit } from '../core/systemd-unit.js';
import type { Container } from '../container.js';
import type { ProcessResult } from '../ports/process-result.js';
import {
  EXIT_ERROR,
  EXIT_OK,
  attempt,
  firstLine,
  resolveScript,
  servicePath,
  type ServiceOptions,
} from './service-shared.js';

/** The unit name (ROADMAP §5 names). */
export const SYSTEMD_UNIT = 'remotectl.service';

const UNIT_DIR_MODE = 0o755;
const UNIT_MODE = 0o644;
/** The user manager's default `PATH` when the installing shell has none. */
const FALLBACK_PATH = '/usr/local/bin:/usr/bin:/bin';
const JOURNAL_HINT = 'journalctl --user -u remotectl';

/** `$XDG_CONFIG_HOME/systemd/user/remotectl.service` (`~/.config/…` by default). */
export function systemdUnitPath(c: Container): string {
  return posix.join(c.service.xdgConfigHome, 'systemd', 'user', SYSTEMD_UNIT);
}

/** `KEY=VALUE` lines of `systemctl show` / `loginctl show-user` as a map. */
function properties(result: ProcessResult): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) map.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return map;
}

function failed(c: Container, command: string, what: string, result: ProcessResult): number {
  c.output.stderr(`remotectl ${command}: ${what} failed: ${firstLine(result)}\n`);
  return EXIT_ERROR;
}

/**
 * Lingering keeps the user manager — and so the agent — running without a login session
 * (after boot, after logout). Enabling it may need polkit consent; when it is refused the
 * service still works while the user is logged in, so this only warns.
 */
async function ensureLinger(c: Container, uid: number): Promise<void> {
  const shown = await attempt(() => c.systemctl.showLinger(uid));
  if (shown.code === 0 && properties(shown).get('Linger') === 'yes') return;
  const enabled = await attempt(() => c.systemctl.enableLinger());
  if (enabled.code === 0) {
    c.output.stdout('Enabled lingering, so the agent also runs without a login session.\n');
    return;
  }
  c.output.stderr(
    `warning: could not enable lingering (${firstLine(enabled)}); the agent runs only ` +
      'while you are logged in. Enable it with:\n  loginctl enable-linger $USER\n',
  );
}

/** `remotectl install [--dry-run]` on Linux: writes, enables and starts the user unit. */
export async function installSystemd(c: Container, options: ServiceOptions): Promise<number> {
  const uid = c.service.uid;
  if (uid === undefined) {
    c.output.stderr('remotectl install: cannot determine the user id.\n');
    return EXIT_ERROR;
  }
  const script = await resolveScript(c);
  if (!script.ok) {
    c.output.stderr(`remotectl install: ${script.message}\n`);
    return EXIT_ERROR;
  }
  const unit = systemdUnit({
    description: 'remotectl agent',
    execStart: [c.service.execPath, script.scriptPath, 'run'],
    environment: { HOME: c.service.homedir, PATH: servicePath(c, FALLBACK_PATH) },
  });
  if (options.dryRun) {
    c.output.stdout(unit);
    return EXIT_OK;
  }

  const unitPath = systemdUnitPath(c);
  const shown = await attempt(() => c.systemctl.show(SYSTEMD_UNIT));
  if (shown.code !== 0) return failed(c, 'install', 'systemctl --user show', shown);
  const state = properties(shown);
  const active = state.get('ActiveState') === 'active';
  const changed = (await c.fs.readText(unitPath)) !== unit;
  if (!changed && active && state.get('UnitFileState') === 'enabled') {
    c.output.stdout(`remotectl is already installed and running (${unitPath}).\n`);
    await ensureLinger(c, uid);
    return EXIT_OK;
  }
  if (changed) {
    await c.fs.ensureDir(posix.dirname(unitPath), UNIT_DIR_MODE);
    await c.fs.writeTextAtomic(unitPath, unit, UNIT_MODE);
  }
  const reload = await attempt(() => c.systemctl.daemonReload());
  if (reload.code !== 0) return failed(c, 'install', 'systemctl --user daemon-reload', reload);
  const enable = await attempt(() => c.systemctl.enableNow(SYSTEMD_UNIT));
  if (enable.code !== 0) return failed(c, 'install', 'systemctl --user enable --now', enable);
  if (changed && active) {
    // `enable --now` leaves a running unit alone; the new definition needs a restart.
    const restart = await attempt(() => c.systemctl.restart(SYSTEMD_UNIT));
    if (restart.code !== 0) return failed(c, 'install', 'systemctl --user restart', restart);
  }
  await ensureLinger(c, uid);
  c.output.stdout(
    `Installed ${unitPath}\nThe agent now starts with your user session and restarts if ` +
      `it exits.\nService output: ${JOURNAL_HINT}\n`,
  );
  return EXIT_OK;
}

/** `remotectl uninstall [--dry-run]` on Linux: stops and disables the unit, removes it. */
export async function uninstallSystemd(c: Container, options: ServiceOptions): Promise<number> {
  const unitPath = systemdUnitPath(c);
  if (options.dryRun) {
    c.output.stdout(
      `Would run: systemctl --user disable --now ${SYSTEMD_UNIT} (if loaded)\n` +
        `Would remove: ${unitPath}\nWould run: systemctl --user daemon-reload\n`,
    );
    return EXIT_OK;
  }
  const shown = await attempt(() => c.systemctl.show(SYSTEMD_UNIT));
  if (shown.code !== 0) return failed(c, 'uninstall', 'systemctl --user show', shown);
  const loaded = properties(shown).get('LoadState') === 'loaded';
  if (loaded) {
    const disable = await attempt(() => c.systemctl.disableNow(SYSTEMD_UNIT));
    if (disable.code !== 0) {
      return failed(c, 'uninstall', 'systemctl --user disable --now', disable);
    }
  }
  const removed = await c.fs.remove(unitPath);
  if (!loaded && !removed) {
    c.output.stdout('remotectl is not installed as a service.\n');
    return EXIT_OK;
  }
  const reload = await attempt(() => c.systemctl.daemonReload());
  if (reload.code !== 0) return failed(c, 'uninstall', 'systemctl --user daemon-reload', reload);
  c.output.stdout(
    `Uninstalled the service${removed ? ` and removed ${unitPath}` : ''}.\n` +
      'Lingering stays enabled (other user services may rely on it); turn it off with ' +
      '`loginctl disable-linger $USER` if nothing else needs it.\n',
  );
  return EXIT_OK;
}

/** One `status` line describing the unit as `systemctl --user` sees it. */
export async function systemdStatusLine(c: Container): Promise<string> {
  const unitPath = systemdUnitPath(c);
  const installed = (await c.fs.readText(unitPath)) !== undefined;
  const shown = await attempt(() => c.systemctl.show(SYSTEMD_UNIT));
  if (shown.code !== 0) return `unknown (systemctl --user: ${firstLine(shown)})`;
  const state = properties(shown);
  if (state.get('LoadState') !== 'loaded') {
    return installed
      ? `installed, not loaded (${unitPath}; run \`remotectl install\`)`
      : 'not installed (`remotectl install`)';
  }
  const pid = state.get('MainPID');
  const lastExit = state.get('ExecMainStatus');
  const enabled = state.get('UnitFileState');
  const details = [
    pid === undefined || pid === '0' ? undefined : `pid ${pid}`,
    lastExit === undefined ? undefined : `last exit ${lastExit}`,
    enabled,
  ].filter((part) => part !== undefined && part !== '');
  const active = `${state.get('ActiveState') ?? 'unknown'}/${state.get('SubState') ?? 'unknown'}`;
  return `loaded, ${active}${details.length > 0 ? ` (${details.join(', ')})` : ''}${
    installed ? '' : ' — unit file missing'
  }`;
}
