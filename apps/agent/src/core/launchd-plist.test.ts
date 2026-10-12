import { describe, expect, it } from 'vitest';

import { launchdPlist, type LaunchdPlistSpec } from './launchd-plist.js';

const SPEC: LaunchdPlistSpec = {
  label: 'dev.remotectl.agent',
  programArguments: ['/opt/node/bin/node', '/opt/lib/remotectl/dist/cli.mjs', 'run'],
  environment: { HOME: '/Users/me', PATH: '/opt/node/bin:/usr/bin:/bin' },
  stdoutPath: '/Users/me/Library/Logs/remotectl/launchd.out.log',
  stderrPath: '/Users/me/Library/Logs/remotectl/launchd.err.log',
};

describe('launchdPlist', () => {
  it('renders the user agent definition', () => {
    expect(launchdPlist(SPEC)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>dev.remotectl.agent</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/opt/node/bin/node</string>
\t\t<string>/opt/lib/remotectl/dist/cli.mjs</string>
\t\t<string>run</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>HOME</key>
\t\t<string>/Users/me</string>
\t\t<key>PATH</key>
\t\t<string>/opt/node/bin:/usr/bin:/bin</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>StandardOutPath</key>
\t<string>/Users/me/Library/Logs/remotectl/launchd.out.log</string>
\t<key>StandardErrorPath</key>
\t<string>/Users/me/Library/Logs/remotectl/launchd.err.log</string>
</dict>
</plist>
`);
  });

  it('escapes XML metacharacters in every string', () => {
    const text = launchdPlist({
      ...SPEC,
      programArguments: ['/Users/a & b/<node>', `/it's "quoted"/cli.mjs`, 'run'],
      environment: { 'A&B': 'x<y>z' },
      stdoutPath: '/Logs/Tom & Jerry/out.log',
    });
    expect(text).toContain('<string>/Users/a &amp; b/&lt;node&gt;</string>');
    expect(text).toContain('<string>/it&apos;s &quot;quoted&quot;/cli.mjs</string>');
    expect(text).toContain('<key>A&amp;B</key>');
    expect(text).toContain('<string>x&lt;y&gt;z</string>');
    expect(text).toContain('<string>/Logs/Tom &amp; Jerry/out.log</string>');
    // Nothing unescaped slipped through: every & starts an entity.
    expect(text).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('keeps non-ASCII and astral characters', () => {
    expect(launchdPlist({ ...SPEC, stdoutPath: '/Logs/Ивана 🚀/out.log' })).toContain(
      '<string>/Logs/Ивана 🚀/out.log</string>',
    );
  });

  it.each(['a\u0000b', 'a\u0007b', 'a\uFFFEb', 'a\uD800b'])(
    'refuses a value XML cannot carry (%j)',
    (bad) => {
      expect(() => launchdPlist({ ...SPEC, stderrPath: bad })).toThrow(RangeError);
    },
  );
});
