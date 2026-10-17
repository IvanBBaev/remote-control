const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "now", "4m", "2h", "3d": how long ago `at` was. */
export function formatAgo(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  return `${Math.floor(elapsed / DAY)}d`;
}

/** "4:05" left until `deadline`, or "expired". */
export function formatCountdown(deadline: number, now: number): string {
  const left = deadline - now;
  if (left <= 0) return 'expired';
  const seconds = Math.ceil(left / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
