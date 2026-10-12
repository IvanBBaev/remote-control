/** What goes into the systemd user unit (06 §5.4, D22). */
export interface SystemdUnitSpec {
  readonly description: string;
  /** `[<node>, <abs cli.mjs>, 'run']` — a stable global install, never the npx cache. */
  readonly execStart: readonly string[];
  /** The user manager's environment is minimal, so `HOME` and `PATH` are explicit. */
  readonly environment: Readonly<Record<string, string>>;
}

/** Characters a unit file line cannot carry, quoted or not. */
// eslint-disable-next-line no-control-regex
const UNIT_INVALID = /[\u0000\n\r]/;

/**
 * One double-quoted unit-file word: `\` and `"` are backslash-escaped (C-style quoting),
 * `%` becomes `%%` (no specifier expansion) and, where systemd expands variables, `$`
 * becomes `$$`. A newline or NUL throws `RangeError`.
 */
function quote(value: string, expandsVariables: boolean): string {
  if (UNIT_INVALID.test(value)) {
    throw new RangeError('unit value contains a newline or NUL');
  }
  let escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  if (expandsVariables) escaped = escaped.replaceAll('$', '$$$$');
  return `"${escaped}"`;
}

/**
 * Renders `remotectl.service` for `systemctl --user`: `Restart=always` with a 5 s pause
 * against a crash loop, started with the user manager (`default.target`). Output goes to
 * journald (`journalctl --user -u remotectl`). `ExecStart=` expands `$VAR`, so `$` is
 * doubled there; `Environment=` does not, so its values keep `$` as is.
 */
export function systemdUnit(spec: SystemdUnitSpec): string {
  const execStart = spec.execStart.map((arg) => quote(arg, true)).join(' ');
  const environment = Object.entries(spec.environment)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new RangeError(`invalid environment variable name ${JSON.stringify(key)}`);
      }
      return quote(`${key}=${value}`, false);
    })
    .join(' ');
  return [
    '[Unit]',
    `Description=${spec.description.replaceAll('%', '%%')}`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execStart}`,
    `Environment=${environment}`,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
