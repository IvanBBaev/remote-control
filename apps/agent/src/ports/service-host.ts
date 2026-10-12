/**
 * Host facts the service installer needs (D22, 06 §5.4). Injected so tests use a temp
 * HOME and a fake script location instead of the real machine.
 */
export interface ServiceHost {
  readonly homedir: string;
  readonly tmpdir: string;
  /** The user id for the launchd `gui/<uid>` domain; `undefined` on Windows. */
  readonly uid: number | undefined;
  /** Absolute path of the Node binary that runs the agent. */
  readonly execPath: string;
  /** The CLI entry script as invoked (`process.argv[1]`); resolved with realpath. */
  readonly scriptPath: string | undefined;
  /** The installing shell's `PATH`, copied into the service environment. */
  readonly pathEnv: string | undefined;
}
