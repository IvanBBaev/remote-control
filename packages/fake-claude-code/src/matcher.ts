/**
 * Hook matcher semantics (04 §2.1: "regex on `tool_name`"). Absent, empty or `*` matches
 * everything. Assumption (mirrors the hooks reference wording, verified in M0-23): a
 * matcher made only of word characters and `|` is an exact-name list (`Edit|Write`);
 * anything else is an unanchored regular expression (`^AskUserQuestion$`, `mcp__.*`).
 * An invalid regular expression matches nothing.
 */
export function matcherMatches(matcher: string | undefined, value: string | undefined): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (value === undefined) return false;
  if (/^[\w|]+$/.test(matcher)) return matcher.split('|').includes(value);
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return false;
  }
}
