import { AlwaysDestination } from '@remote-control/protocol';

import type { PendingRequest } from './pending-store.js';

/** `ApprovalRequest.suggestions` caps: what the phone can show for "Always". */
const MAX_RULES = 10;
const MAX_LABEL_LENGTH = 200;

/** One Claude Code permission rule (`Bash(npm test)` is `{ toolName, ruleContent }`). */
export interface PermissionRule {
  readonly toolName: string;
  readonly ruleContent?: string;
}

/** The `updatedPermissions` entry "Always" emits: allow rules for one destination. */
export interface AlwaysRuleUpdate {
  readonly type: 'addRules';
  readonly rules: readonly PermissionRule[];
  readonly behavior: 'allow';
  readonly destination: AlwaysDestination;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rule(value: unknown): PermissionRule | undefined {
  if (!isObject(value)) return undefined;
  const { toolName, ruleContent } = value;
  if (typeof toolName !== 'string' || toolName === '') return undefined;
  if (ruleContent === undefined) return { toolName };
  return typeof ruleContent === 'string' ? { toolName, ruleContent } : undefined;
}

/** How the phone shows a rule, in Claude Code's own notation: `Bash(npm test)`. */
export function ruleLabel(entry: PermissionRule): string {
  return entry.ruleContent === undefined
    ? entry.toolName
    : `${entry.toolName}(${entry.ruleContent})`;
}

/**
 * The allow rules Claude Code suggested for a permission request (`permission_suggestions`,
 * 04 §2.2), each re-targeted to `destination` (D24, M2-07): whatever settings file Claude
 * Code proposed, the rules go only where the phone picked from the agent's
 * `always.destinations`, and to the session by default. Only `addRules`
 * with `behavior: "allow"` qualify — mode changes, directory grants and deny/ask rules are
 * not offered. Fails closed: a malformed rule, or more rules than the phone can show in
 * full, means no "Always" at all, so the user always sees every rule they grant.
 */
export function alwaysRules(
  request: PendingRequest,
  destination: AlwaysDestination = 'session',
): AlwaysRuleUpdate[] {
  const raw = request.payload['permission_suggestions'];
  if (request.kind !== 'permission' || !Array.isArray(raw)) return [];
  const updates: AlwaysRuleUpdate[] = [];
  let count = 0;
  for (const suggestion of raw as unknown[]) {
    if (!isObject(suggestion)) return [];
    if (suggestion['type'] !== 'addRules' || suggestion['behavior'] !== 'allow') continue;
    const rawRules = suggestion['rules'];
    if (!Array.isArray(rawRules) || rawRules.length === 0) return [];
    const rules = (rawRules as unknown[]).map(rule);
    if (rules.some((entry) => entry === undefined)) return [];
    const valid = rules as PermissionRule[];
    if (valid.some((entry) => ruleLabel(entry).length > MAX_LABEL_LENGTH)) return [];
    count += valid.length;
    if (count > MAX_RULES) return [];
    updates.push({ type: 'addRules', rules: valid, behavior: 'allow', destination });
  }
  return updates;
}

/** The labels of every rule in `updates`, in order: what the "Always" button grants. */
export function alwaysRuleLabels(updates: readonly AlwaysRuleUpdate[]): string[] {
  return updates.flatMap((update) => update.rules.map(ruleLabel));
}

/**
 * Where an `always` decision sends its rules: its signed payload (M2-07), `null` meaning the
 * session. `undefined` when that destination is not in the agent's `always.destinations`,
 * so a phone can never pick a settings file the user did not turn on.
 */
export function alwaysDestination(
  payload: string | null,
  allowed: readonly AlwaysDestination[],
): AlwaysDestination | undefined {
  const parsed = AlwaysDestination.safeParse(payload ?? 'session');
  return parsed.success && allowed.includes(parsed.data) ? parsed.data : undefined;
}
