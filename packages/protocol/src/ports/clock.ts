/**
 * Time source. Core code reads time only through this port; the system adapter is the
 * only place allowed to call `Date.now()` (ROADMAP §5, lint-enforced).
 */
export interface Clock {
  /** Current time as Unix epoch milliseconds. */
  now(): number;
}
