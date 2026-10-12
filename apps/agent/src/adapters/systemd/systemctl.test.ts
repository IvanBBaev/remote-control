import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  SystemctlArgumentError,
  daemonReloadArgv,
  disableNowArgv,
  enableLingerArgv,
  enableNowArgv,
  restartArgv,
  showArgv,
  showLingerArgv,
  systemSystemctl,
} from './systemctl.js';

const UNIT = 'remotectl.service';
/** Only where neither binary exists can every method run without touching a real manager. */
const missingBinaries =
  existsSync('/usr/bin/systemctl') || existsSync('/usr/bin/loginctl') ? it.skip : it;

describe('systemctl argv builders', () => {
  it('build the literal argv', () => {
    expect(daemonReloadArgv()).toEqual(['--user', 'daemon-reload']);
    expect(enableNowArgv(UNIT)).toEqual(['--user', 'enable', '--now', UNIT]);
    expect(disableNowArgv(UNIT)).toEqual(['--user', 'disable', '--now', UNIT]);
    expect(restartArgv(UNIT)).toEqual(['--user', 'restart', UNIT]);
    expect(showArgv(UNIT)).toEqual([
      '--user',
      'show',
      UNIT,
      '--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus,UnitFileState',
    ]);
    expect(enableLingerArgv()).toEqual(['enable-linger']);
    expect(showLingerArgv(1000)).toEqual(['show-user', '1000', '--property=Linger']);
    expect(showLingerArgv(0)).toEqual(['show-user', '0', '--property=Linger']);
  });

  it('refuse any unit but remotectl.service', () => {
    for (const unit of ['', 'remotectl', '--now', 'other.service', 'remotectl.service ', '*']) {
      expect(() => enableNowArgv(unit)).toThrow(SystemctlArgumentError);
      expect(() => disableNowArgv(unit)).toThrow(SystemctlArgumentError);
      expect(() => restartArgv(unit)).toThrow(SystemctlArgumentError);
      expect(() => showArgv(unit)).toThrow(SystemctlArgumentError);
    }
  });

  it('refuse a uid that is not a non-negative integer', () => {
    for (const uid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => showLingerArgv(uid)).toThrow(SystemctlArgumentError);
    }
  });
});

describe('systemSystemctl', () => {
  it('refuses a bad unit before spawning', async () => {
    await expect(Promise.resolve().then(() => systemSystemctl.show('x'))).rejects.toThrow(
      SystemctlArgumentError,
    );
  });

  missingBinaries('rejects with the spawn error where the binaries are absent', async () => {
    const calls = [
      () => systemSystemctl.daemonReload(),
      () => systemSystemctl.enableNow(UNIT),
      () => systemSystemctl.disableNow(UNIT),
      () => systemSystemctl.restart(UNIT),
      () => systemSystemctl.show(UNIT),
      () => systemSystemctl.enableLinger(),
      () => systemSystemctl.showLinger(1000),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
