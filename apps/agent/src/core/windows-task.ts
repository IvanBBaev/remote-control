import { escapeXml } from './xml-escape.js';

/** The script host that runs the launcher without a console window. */
export const WSCRIPT = 'C:\\Windows\\System32\\wscript.exe';

/** What goes into the `remotectl` scheduled task (06 §5.4, D22). */
export interface WindowsTaskSpec {
  readonly description: string;
  /** `DOMAIN\user`, for the logon trigger and the principal. */
  readonly userId: string;
  /** Absolute path of the VBScript launcher the task runs through `wscript.exe`. */
  readonly launcherPath: string;
}

/** Characters a quoted command-line argument or VBScript string cannot carry. */
// eslint-disable-next-line no-control-regex
const ARGUMENT_INVALID = /["\u0000\n\r]/;

function checkArgument(value: string): string {
  if (ARGUMENT_INVALID.test(value)) {
    throw new RangeError('argument contains a quote, a newline or NUL');
  }
  return value;
}

/**
 * Renders the Task Scheduler 1.2 definition: started at the user's logon with their
 * interactive token and least privilege, one instance at a time, no time limit, on
 * battery too, hidden, restarted every minute after a failure (999 times). Task
 * Scheduler passes no environment of its own: the task runs with the user's normal
 * environment, so — unlike launchd and systemd — nothing has to be set here. The
 * declaration says UTF-16; write the result with `utf16le`.
 */
export function windowsTaskXml(spec: WindowsTaskSpec): string {
  const userId = escapeXml(spec.userId);
  const launcher = escapeXml(checkArgument(spec.launcherPath));
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${escapeXml(spec.description)}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${userId}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${userId}</UserId>`,
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
    `      <Command>${WSCRIPT}</Command>`,
    `      <Arguments>//B //NoLogo &quot;${launcher}&quot;</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n');
}

/**
 * Renders the VBScript launcher: runs `"<node>" "<cli.mjs>" "run"` with a hidden window,
 * waits for it and exits with its code, so Task Scheduler sees a failure and restarts
 * the task. Inside the VBScript string literal every `"` is doubled. An argument with a
 * quote, a newline or NUL throws `RangeError`.
 */
export function windowsLauncherVbs(programArguments: readonly string[]): string {
  const command = programArguments.map((arg) => `"${checkArgument(arg)}"`).join(' ');
  const literal = `"${command.replaceAll('"', '""')}"`;
  return [
    "' remotectl service launcher, written by `remotectl install`; do not edit.",
    `WScript.Quit CreateObject("WScript.Shell").Run(${literal}, 0, True)`,
    '',
  ].join('\r\n');
}

/**
 * `text` as UTF-16LE bytes with a byte-order mark: what `schtasks /XML` expects for an
 * `encoding="UTF-16"` file, and what lets Windows Script Host read non-ASCII paths.
 */
export function utf16le(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    bytes[2 + i * 2] = unit & 0xff;
    bytes[3 + i * 2] = unit >> 8;
  }
  return bytes;
}
