/**
 * The repository roots a hook event came from (M1-07): proof that Claude Code trusts the
 * folder and runs the hooks there (04 §2.6). Shared by the running agent and `status`.
 */
export interface HookSeenStore {
  /** Root → first hook time (epoch ms); a missing or unreadable file reads as none. */
  read(): Promise<Readonly<Record<string, number>>>;
  /** Records `root` at `at`; a root already recorded keeps its first time. */
  record(root: string, at: number): Promise<void>;
}
