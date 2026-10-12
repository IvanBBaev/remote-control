import { describe, expect, it } from 'vitest';

import { LaunchctlArgumentError, bootoutArgv, bootstrapArgv, printArgv } from './launchctl.js';

describe('launchctl argv builders', () => {
  it('build the literal argv', () => {
    expect(bootstrapArgv('gui/501', '/Users/a b/Library/LaunchAgents/x.plist')).toEqual([
      'bootstrap',
      'gui/501',
      '/Users/a b/Library/LaunchAgents/x.plist',
    ]);
    expect(bootoutArgv('gui/501/dev.remotectl.agent')).toEqual([
      'bootout',
      'gui/501/dev.remotectl.agent',
    ]);
    expect(printArgv('gui/501/dev.remotectl.agent')).toEqual([
      'print',
      'gui/501/dev.remotectl.agent',
    ]);
  });

  it('refuse anything but a gui/<uid> domain and a plain label', () => {
    for (const domain of ['', 'system', 'gui/', 'gui/501/x', '-gui/501', 'user/501']) {
      expect(() => bootstrapArgv(domain, '/x.plist')).toThrow(LaunchctlArgumentError);
    }
    for (const target of ['gui/501', 'gui/501/-x', 'gui/501/a b', 'system/x', 'gui/501/a/b']) {
      expect(() => bootoutArgv(target)).toThrow(LaunchctlArgumentError);
      expect(() => printArgv(target)).toThrow(LaunchctlArgumentError);
    }
  });

  it('refuse a plist path that is relative, not a plist or contains NUL', () => {
    for (const path of ['x.plist', '-x.plist', '/x.txt', '/a\0b.plist']) {
      expect(() => bootstrapArgv('gui/501', path)).toThrow(LaunchctlArgumentError);
    }
  });
});
