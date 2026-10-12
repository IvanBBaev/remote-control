// `remotectl install | uninstall` and the service line of `status` (M0-24, M1-08, D22,
// 06 §5.4): launchd on macOS, systemd --user on Linux, Task Scheduler on Windows.
import type { Container } from '../container.js';
import { installLaunchd, launchdStatusLine, uninstallLaunchd } from './service-launchd.js';
import { EXIT_ERROR, type ServiceOptions } from './service-shared.js';
import { installSystemd, systemdStatusLine, uninstallSystemd } from './service-systemd.js';
import { installWindows, uninstallWindows, windowsStatusLine } from './service-windows.js';

export {
  LAUNCHD_LABEL,
  LAUNCHD_STDERR_FILE,
  LAUNCHD_STDOUT_FILE,
  launchdPlistPath,
} from './service-launchd.js';
export { SYSTEMD_UNIT, systemdUnitPath } from './service-systemd.js';
export { WINDOWS_TASK, windowsTaskFiles } from './service-windows.js';
export type { ServiceOptions } from './service-shared.js';

function unsupported(c: Container, command: string): number {
  c.output.stderr(
    `remotectl ${command}: running as a service is not supported on ${c.platform}; ` +
      'use `remotectl run` in a terminal instead.\n',
  );
  return EXIT_ERROR;
}

/** `remotectl install [--dry-run]`: writes and starts the platform's login service. */
export function installService(c: Container, options: ServiceOptions): Promise<number> {
  switch (c.platform) {
    case 'darwin':
      return installLaunchd(c, options);
    case 'linux':
      return installSystemd(c, options);
    case 'win32':
      return installWindows(c, options);
    default:
      return Promise.resolve(unsupported(c, 'install'));
  }
}

/** `remotectl uninstall [--dry-run]`: stops and removes the platform's login service. */
export function uninstallService(c: Container, options: ServiceOptions): Promise<number> {
  switch (c.platform) {
    case 'darwin':
      return uninstallLaunchd(c, options);
    case 'linux':
      return uninstallSystemd(c, options);
    case 'win32':
      return uninstallWindows(c, options);
    default:
      return Promise.resolve(unsupported(c, 'uninstall'));
  }
}

/** One `status` line describing the service. */
export function serviceStatusLine(c: Container): Promise<string> {
  switch (c.platform) {
    case 'darwin':
      return launchdStatusLine(c);
    case 'linux':
      return systemdStatusLine(c);
    case 'win32':
      return windowsStatusLine(c);
    default:
      return Promise.resolve(`not supported on ${c.platform}`);
  }
}
