import { describe, expect, it } from 'vitest';

import { envPaths } from './env-paths.js';

describe('envPaths', () => {
  it('uses the macOS Library layout', () => {
    expect(
      envPaths('remotectl', { platform: 'darwin', env: {}, homedir: '/Users/u', tmpdir: '/tmp' }),
    ).toEqual({
      data: '/Users/u/Library/Application Support/remotectl',
      config: '/Users/u/Library/Preferences/remotectl',
      cache: '/Users/u/Library/Caches/remotectl',
      log: '/Users/u/Library/Logs/remotectl',
      temp: '/tmp/remotectl',
    });
  });

  it('uses APPDATA / LOCALAPPDATA on Windows, with profile fallbacks', () => {
    const host = { platform: 'win32' as const, homedir: 'C:\\Users\\u', tmpdir: 'C:\\Temp' };
    expect(
      envPaths('remotectl', {
        ...host,
        env: { APPDATA: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local' },
      }),
    ).toEqual({
      data: 'D:\\Local\\remotectl\\Data',
      config: 'D:\\Roaming\\remotectl\\Config',
      cache: 'D:\\Local\\remotectl\\Cache',
      log: 'D:\\Local\\remotectl\\Log',
      temp: 'C:\\Temp\\remotectl',
    });
    expect(envPaths('remotectl', { ...host, env: {} })).toMatchObject({
      data: 'C:\\Users\\u\\AppData\\Local\\remotectl\\Data',
      config: 'C:\\Users\\u\\AppData\\Roaming\\remotectl\\Config',
    });
  });

  it('follows XDG on Linux, with fallbacks for unset or empty variables', () => {
    const host = { platform: 'linux' as const, homedir: '/home/u', tmpdir: '/tmp' };
    expect(envPaths('remotectl', { ...host, env: { XDG_DATA_HOME: '' } })).toEqual({
      data: '/home/u/.local/share/remotectl',
      config: '/home/u/.config/remotectl',
      cache: '/home/u/.cache/remotectl',
      log: '/home/u/.local/state/remotectl',
      temp: '/tmp/u/remotectl',
    });
    expect(
      envPaths('remotectl', {
        ...host,
        env: {
          XDG_DATA_HOME: '/x/data',
          XDG_CONFIG_HOME: '/x/config',
          XDG_CACHE_HOME: '/x/cache',
          XDG_STATE_HOME: '/x/state',
        },
      }),
    ).toMatchObject({
      data: '/x/data/remotectl',
      config: '/x/config/remotectl',
      cache: '/x/cache/remotectl',
      log: '/x/state/remotectl',
    });
  });
});
