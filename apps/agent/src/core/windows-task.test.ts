import { describe, expect, it } from 'vitest';

import { utf16le, windowsLauncherVbs, windowsTaskXml } from './windows-task.js';

const LAUNCHER = 'C:\\Users\\Tom & Jerry\\AppData\\Local\\remotectl\\Data\\service.vbs';

describe('windowsTaskXml', () => {
  it('renders the golden task definition', () => {
    expect(
      windowsTaskXml({
        description: 'remotectl agent',
        userId: 'WORKGROUP\\Tom & Jerry',
        launcherPath: LAUNCHER,
      }),
    ).toBe(
      [
        '<?xml version="1.0" encoding="UTF-16"?>',
        '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
        '  <RegistrationInfo>',
        '    <Description>remotectl agent</Description>',
        '  </RegistrationInfo>',
        '  <Triggers>',
        '    <LogonTrigger>',
        '      <Enabled>true</Enabled>',
        '      <UserId>WORKGROUP\\Tom &amp; Jerry</UserId>',
        '    </LogonTrigger>',
        '  </Triggers>',
        '  <Principals>',
        '    <Principal id="Author">',
        '      <UserId>WORKGROUP\\Tom &amp; Jerry</UserId>',
        '      <LogonType>InteractiveToken</LogonType>',
        '      <RunLevel>LeastPrivilege</RunLevel>',
        '    </Principal>',
        '  </Principals>',
        '  <Settings>',
        '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
        '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
        '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
        '    <StartWhenAvailable>true</StartWhenAvailable>',
        '    <AllowStartOnDemand>true</AllowStartOnDemand>',
        '    <Enabled>true</Enabled>',
        '    <Hidden>true</Hidden>',
        '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
        '    <RestartOnFailure>',
        '      <Interval>PT1M</Interval>',
        '      <Count>999</Count>',
        '    </RestartOnFailure>',
        '  </Settings>',
        '  <Actions Context="Author">',
        '    <Exec>',
        '      <Command>C:\\Windows\\System32\\wscript.exe</Command>',
        '      <Arguments>//B //NoLogo &quot;C:\\Users\\Tom &amp; Jerry\\AppData\\Local\\remotectl\\Data\\service.vbs&quot;</Arguments>',
        '    </Exec>',
        '  </Actions>',
        '</Task>',
        '',
      ].join('\n'),
    );
  });

  it('refuses a launcher path with a quote and a user XML cannot carry', () => {
    const spec = { description: 'd', userId: 'U\\u', launcherPath: LAUNCHER };
    expect(() => windowsTaskXml({ ...spec, launcherPath: 'C:\\a"b.vbs' })).toThrow(RangeError);
    expect(() => windowsTaskXml({ ...spec, userId: 'U\\\u0001' })).toThrow(RangeError);
  });
});

describe('windowsLauncherVbs', () => {
  it('renders the golden launcher with doubled quotes', () => {
    expect(
      windowsLauncherVbs([
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Users\\Петър\\AppData\\Roaming\\npm\\node_modules\\remotectl\\dist\\cli.mjs',
        'run',
      ]),
    ).toBe(
      "' remotectl service launcher, written by `remotectl install`; do not edit.\r\n" +
        'WScript.Quit CreateObject("WScript.Shell").Run(' +
        '"""C:\\Program Files\\nodejs\\node.exe"" ' +
        '""C:\\Users\\Петър\\AppData\\Roaming\\npm\\node_modules\\remotectl\\dist\\cli.mjs"" ' +
        '""run""", 0, True)\r\n',
    );
  });

  it.each(['"', '\n', '\r', '\u0000'])('refuses %j in an argument', (bad) => {
    expect(() => windowsLauncherVbs([`C:\\a${bad}b`, 'run'])).toThrow(RangeError);
  });
});

describe('utf16le', () => {
  it('writes a byte-order mark and little-endian code units', () => {
    expect([...utf16le('Aé😀')]).toEqual([
      0xff, 0xfe, 0x41, 0x00, 0xe9, 0x00, 0x3d, 0xd8, 0x00, 0xde,
    ]);
  });

  it('encodes the empty string as the bare mark', () => {
    expect([...utf16le('')]).toEqual([0xff, 0xfe]);
  });
});
