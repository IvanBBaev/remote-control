/**
 * Throws when any canary string occurs in any log line. Used by unit tests and by the
 * privacy gate (M0-08, M0-22), which plants canaries in payloads and greps everything
 * the relay wrote. The error names the canary and line index, never the line itself.
 */
export function assertNoCanary(
  logLines: Iterable<string> | string,
  canaries: readonly string[],
): void {
  if (canaries.length === 0) {
    throw new TypeError('assertNoCanary: at least one canary is required.');
  }
  if (canaries.some((canary) => canary.length === 0)) {
    throw new TypeError('assertNoCanary: an empty canary would match every line.');
  }
  const lines = typeof logLines === 'string' ? [logLines] : [...logLines];
  const hits: string[] = [];
  lines.forEach((line, index) => {
    for (const canary of canaries) {
      if (line.includes(canary)) {
        hits.push(`"${canary}" in line ${index}`);
      }
    }
  });
  if (hits.length > 0) {
    throw new Error(`Canary leaked into logs: ${hits.join(', ')}.`);
  }
}
