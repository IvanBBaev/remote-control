import { escapeXml } from './xml-escape.js';

/** What goes into the launchd user agent definition (06 §5.4, D22). */
export interface LaunchdPlistSpec {
  readonly label: string;
  /** `[<node>, <abs cli.mjs>, 'run']` — a stable global install, never the npx cache. */
  readonly programArguments: readonly string[];
  /** launchd starts with a minimal environment, so `HOME` and `PATH` are explicit. */
  readonly environment: Readonly<Record<string, string>>;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

function xmlString(value: string): string {
  return `<string>${escapeXml(value)}</string>`;
}

/**
 * Renders the `dev.remotectl.agent` plist: `RunAtLoad` and `KeepAlive` so launchd starts
 * it at login and restarts it after any exit, `ThrottleInterval 10` against a crash loop,
 * stdout/stderr into the env-paths log directory. Every string is XML-escaped; a value
 * XML cannot represent throws `RangeError`.
 */
export function launchdPlist(spec: LaunchdPlistSpec): string {
  const environment = Object.entries(spec.environment)
    .map(([key, value]) => `\t\t<key>${escapeXml(key)}</key>\n\t\t${xmlString(value)}`)
    .join('\n');
  const programArguments = spec.programArguments.map((arg) => `\t\t${xmlString(arg)}`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t${xmlString(spec.label)}`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    programArguments,
    '\t</array>',
    '\t<key>EnvironmentVariables</key>',
    '\t<dict>',
    environment,
    '\t</dict>',
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
    '\t<key>KeepAlive</key>',
    '\t<true/>',
    '\t<key>ThrottleInterval</key>',
    '\t<integer>10</integer>',
    '\t<key>ProcessType</key>',
    '\t<string>Background</string>',
    '\t<key>StandardOutPath</key>',
    `\t${xmlString(spec.stdoutPath)}`,
    '\t<key>StandardErrorPath</key>',
    `\t${xmlString(spec.stderrPath)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
