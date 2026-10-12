import { describe, expect, it } from 'vitest';

import { systemdUnit, type SystemdUnitSpec } from './systemd-unit.js';

const SPEC: SystemdUnitSpec = {
  description: 'remotectl agent',
  execStart: ['/opt/node 22/bin/node', '/home/tom/lib/node_modules/remotectl/dist/cli.mjs', 'run'],
  environment: { HOME: '/home/tom', PATH: '/opt/node 22/bin:/usr/bin:/bin' },
};

describe('systemdUnit', () => {
  it('renders the golden unit', () => {
    expect(systemdUnit(SPEC)).toBe(
      [
        '[Unit]',
        'Description=remotectl agent',
        '',
        '[Service]',
        'Type=simple',
        'ExecStart="/opt/node 22/bin/node" "/home/tom/lib/node_modules/remotectl/dist/cli.mjs" "run"',
        'Environment="HOME=/home/tom" "PATH=/opt/node 22/bin:/usr/bin:/bin"',
        'Restart=always',
        'RestartSec=5',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    );
  });

  it('escapes quotes, backslashes, specifiers and variables', () => {
    const unit = systemdUnit({
      ...SPEC,
      execStart: ['/home/a "b"\\c/100%/$HOME/node', 'run'],
      environment: { HOME: '/home/a "b"\\c/100%/$HOME' },
    });
    expect(unit).toContain('ExecStart="/home/a \\"b\\"\\\\c/100%%/$$HOME/node" "run"\n');
    expect(unit).toContain('Environment="HOME=/home/a \\"b\\"\\\\c/100%%/$HOME"\n');
  });

  it('escapes % in the description', () => {
    expect(systemdUnit({ ...SPEC, description: '100% agent' })).toContain(
      'Description=100%% agent\n',
    );
  });

  it.each(['\n', '\r', '\u0000'])('refuses %j in any value', (bad) => {
    expect(() => systemdUnit({ ...SPEC, execStart: [`/a${bad}b`] })).toThrow(RangeError);
    expect(() => systemdUnit({ ...SPEC, environment: { HOME: `/a${bad}b` } })).toThrow(RangeError);
  });

  it('refuses an invalid environment variable name', () => {
    expect(() => systemdUnit({ ...SPEC, environment: { 'A=B': 'x' } })).toThrow(RangeError);
  });
});
