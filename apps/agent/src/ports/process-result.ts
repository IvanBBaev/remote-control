/** The outcome of one service-manager invocation (`launchctl`, `systemctl`, `schtasks`). */
export interface ProcessResult {
  /** Process exit code; non-zero for failures and, for queries, an unknown service. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
