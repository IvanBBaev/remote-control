/** The outcome of one `launchctl` invocation. */
export interface LaunchctlResult {
  /** Process exit code (`launchctl print` exits non-zero for an unknown service). */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The `launchctl` subcommands the agent uses (06 §5.4). The real adapter is
 * `adapters/launchd/launchctl.ts`; tests inject a fake and never touch launchd.
 */
export interface Launchctl {
  /** `launchctl bootstrap <domain> <plist>` — loads and starts the user agent. */
  bootstrap(domain: string, plistPath: string): Promise<LaunchctlResult>;
  /** `launchctl bootout <service-target>` — stops and unloads it. */
  bootout(serviceTarget: string): Promise<LaunchctlResult>;
  /** `launchctl print <service-target>` — its state, or a non-zero code when unknown. */
  print(serviceTarget: string): Promise<LaunchctlResult>;
}
