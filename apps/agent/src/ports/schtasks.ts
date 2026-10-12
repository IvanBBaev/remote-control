import type { ProcessResult } from './process-result.js';

/**
 * The `schtasks.exe` subcommands the agent uses on Windows (06 §5.4). The real adapter
 * is `adapters/windows/schtasks.ts`; tests inject a fake.
 */
export interface Schtasks {
  /** `schtasks /Create /TN <task> /XML <path> /F` — creates or replaces the task. */
  create(task: string, xmlPath: string): Promise<ProcessResult>;
  /** `schtasks /Delete /TN <task> /F`. */
  delete(task: string): Promise<ProcessResult>;
  /** `schtasks /Query /TN <task> /XML ONE` — exits non-zero when the task is absent. */
  query(task: string): Promise<ProcessResult>;
  /** `schtasks /Run /TN <task>` — starts it now. */
  run(task: string): Promise<ProcessResult>;
  /** `schtasks /End /TN <task>` — stops a running instance. */
  end(task: string): Promise<ProcessResult>;
}
