import { describe, expect, it } from 'vitest';

import {
  SchtasksArgumentError,
  createArgv,
  deleteArgv,
  endArgv,
  queryArgv,
  runArgv,
  systemSchtasks,
} from './schtasks.js';

const XML = 'C:\\Users\\Tom & Jerry\\AppData\\Local\\remotectl\\Data\\service-task.xml';
/** Off Windows the literal schtasks.exe path never exists, so every method is safe to run. */
const notWindows = process.platform === 'win32' ? it.skip : it;

describe('schtasks argv builders', () => {
  it('build the literal argv', () => {
    expect(createArgv('remotectl', XML)).toEqual([
      '/Create',
      '/TN',
      'remotectl',
      '/XML',
      XML,
      '/F',
    ]);
    expect(deleteArgv('remotectl')).toEqual(['/Delete', '/TN', 'remotectl', '/F']);
    expect(queryArgv('remotectl')).toEqual(['/Query', '/TN', 'remotectl', '/XML', 'ONE']);
    expect(runArgv('remotectl')).toEqual(['/Run', '/TN', 'remotectl']);
    expect(endArgv('remotectl')).toEqual(['/End', '/TN', 'remotectl']);
    expect(createArgv('remotectl', 'd:\\x.XML')).toEqual([
      '/Create',
      '/TN',
      'remotectl',
      '/XML',
      'd:\\x.XML',
      '/F',
    ]);
  });

  it('refuse any task but remotectl', () => {
    for (const task of ['', 'Remotectl', '/F', '\\remotectl', 'remotectl ', 'other']) {
      expect(() => createArgv(task, XML)).toThrow(SchtasksArgumentError);
      expect(() => deleteArgv(task)).toThrow(SchtasksArgumentError);
      expect(() => queryArgv(task)).toThrow(SchtasksArgumentError);
      expect(() => runArgv(task)).toThrow(SchtasksArgumentError);
      expect(() => endArgv(task)).toThrow(SchtasksArgumentError);
    }
  });

  it('refuse an XML path that is not an absolute Windows .xml path', () => {
    for (const path of [
      '',
      'task.xml',
      '\\task.xml',
      '\\\\server\\share\\task.xml',
      '/tmp/task.xml',
      'C:task.xml',
      'C:\\task.txt',
      'C:\\a"b.xml',
      'C:\\a\nb.xml',
      'C:\\a\0b.xml',
      '/F',
    ]) {
      expect(() => createArgv('remotectl', path)).toThrow(SchtasksArgumentError);
    }
  });
});

describe('systemSchtasks', () => {
  it('refuses a bad task name before spawning', async () => {
    await expect(Promise.resolve().then(() => systemSchtasks.query('x'))).rejects.toThrow(
      SchtasksArgumentError,
    );
  });

  notWindows('rejects with the spawn error where schtasks.exe is absent', async () => {
    const calls = [
      () => systemSchtasks.create('remotectl', XML),
      () => systemSchtasks.delete('remotectl'),
      () => systemSchtasks.query('remotectl'),
      () => systemSchtasks.run('remotectl'),
      () => systemSchtasks.end('remotectl'),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
