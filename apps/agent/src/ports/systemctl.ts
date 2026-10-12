import type { ProcessResult } from './process-result.js';

/**
 * The `systemctl --user` and `loginctl` subcommands the agent uses on Linux (06 §5.4).
 * The real adapter is `adapters/systemd/systemctl.ts`; tests inject a fake.
 */
export interface Systemctl {
  /** `systemctl --user daemon-reload` — rereads changed unit files. */
  daemonReload(): Promise<ProcessResult>;
  /** `systemctl --user enable --now <unit>` — starts it now and at every boot. */
  enableNow(unit: string): Promise<ProcessResult>;
  /** `systemctl --user disable --now <unit>` — stops it and removes the boot link. */
  disableNow(unit: string): Promise<ProcessResult>;
  /** `systemctl --user restart <unit>`. */
  restart(unit: string): Promise<ProcessResult>;
  /**
   * `systemctl --user show <unit> --property=LoadState,ActiveState,SubState,MainPID,
   * ExecMainStatus,UnitFileState` — `KEY=VALUE` lines (`LoadState=not-found` when unknown).
   */
  show(unit: string): Promise<ProcessResult>;
  /** `loginctl enable-linger` for the calling user (may need polkit consent). */
  enableLinger(): Promise<ProcessResult>;
  /** `loginctl show-user <uid> --property=Linger` — `Linger=yes|no`. */
  showLinger(uid: number): Promise<ProcessResult>;
}
