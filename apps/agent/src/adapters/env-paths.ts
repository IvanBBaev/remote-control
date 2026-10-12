import { posix, win32 } from 'node:path';

import type { AgentPaths } from '../ports/agent-paths.js';

export interface EnvPathsHost {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
  readonly tmpdir: string;
}

/**
 * `env-paths(name, {suffix: ''})` (sindresorhus/env-paths 3.0, MIT), vendored so the
 * published bundle has zero runtime dependencies (D13, R13). Pure: the host is injected,
 * so tests never touch the real home directory.
 */
export function envPaths(name: string, host: EnvPathsHost): AgentPaths {
  const { env, homedir, tmpdir } = host;
  if (host.platform === 'darwin') {
    const library = posix.join(homedir, 'Library');
    return {
      data: posix.join(library, 'Application Support', name),
      config: posix.join(library, 'Preferences', name),
      cache: posix.join(library, 'Caches', name),
      log: posix.join(library, 'Logs', name),
      temp: posix.join(tmpdir, name),
    };
  }
  if (host.platform === 'win32') {
    const appData = env.APPDATA || win32.join(homedir, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA || win32.join(homedir, 'AppData', 'Local');
    return {
      data: win32.join(localAppData, name, 'Data'),
      config: win32.join(appData, name, 'Config'),
      cache: win32.join(localAppData, name, 'Cache'),
      log: win32.join(localAppData, name, 'Log'),
      temp: win32.join(tmpdir, name),
    };
  }
  // Linux and other Unix: XDG Base Directory specification.
  const username = posix.basename(homedir);
  return {
    data: posix.join(env.XDG_DATA_HOME || posix.join(homedir, '.local', 'share'), name),
    config: posix.join(env.XDG_CONFIG_HOME || posix.join(homedir, '.config'), name),
    cache: posix.join(env.XDG_CACHE_HOME || posix.join(homedir, '.cache'), name),
    log: posix.join(env.XDG_STATE_HOME || posix.join(homedir, '.local', 'state'), name),
    temp: posix.join(tmpdir, username, name),
  };
}
