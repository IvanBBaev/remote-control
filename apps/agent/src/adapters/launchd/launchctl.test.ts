import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  LaunchctlArgumentError,
  bootoutArgv,
  bootstrapArgv,
  collect,
  printArgv,
  type CollectableProcess,
} from './launchctl.js';

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

class FakeChild extends EventEmitter implements CollectableProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

describe('collect', () => {
  it('gathers stdout and stderr and resolves with the exit code', async () => {
    const child = new FakeChild();
    const result = collect(child);
    child.stdout.end('state = running\n');
    child.stderr.end('warn\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 113, null);
    expect(await result).toEqual({ code: 113, stdout: 'state = running\n', stderr: 'warn\n' });
  });

  it('maps a signal to 128 and a missing code to 1', async () => {
    const killed = new FakeChild();
    const a = collect(killed);
    killed.emit('close', null, 'SIGKILL');
    expect((await a).code).toBe(128);
    const odd = new FakeChild();
    const b = collect(odd);
    odd.emit('close', null, null);
    expect((await b).code).toBe(1);
  });

  it('rejects when the process cannot start', async () => {
    const child = new FakeChild();
    const result = collect(child);
    child.emit('error', new Error('spawn ENOENT'));
    await expect(result).rejects.toThrow('ENOENT');
  });
});
