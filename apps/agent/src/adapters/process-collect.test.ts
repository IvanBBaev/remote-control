import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { collect, type CollectableProcess } from './process-collect.js';

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
