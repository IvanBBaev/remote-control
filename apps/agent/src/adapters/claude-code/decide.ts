import type { PendingRequest } from '../../core/pending-store.js';
import type { AdapterDecision } from '../../ports/agent-adapter.js';

/** The deny reason when the phone gave none. */
export const DEFAULT_DENY_MESSAGE = 'Denied from phone';
/** The deny reason for `agent.onExpire: "deny"` (D10). */
export const NO_DECISION_MESSAGE = 'No decision from phone';

/** No decision: Claude Code shows its own prompt (D10 handoff). */
const NO_DECISION: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * Builds the Claude Code hook output for a decision (04 §2.2). The only module the argv
 * gate lets emit `updatedInput` (D11); in M0 it never does — `allow` approves the tool
 * input exactly as Claude Code proposed it. A question request has no answer path until
 * M1-01, so every decision on it hands off.
 */
export function decideClaudeCode(
  request: PendingRequest,
  decision: AdapterDecision,
): Readonly<Record<string, unknown>> {
  if (request.kind !== 'permission' || decision.behavior === 'handoff') return NO_DECISION;
  const verdict =
    decision.behavior === 'allow'
      ? { behavior: 'allow' }
      : {
          behavior: 'deny',
          message: decision.message ?? DEFAULT_DENY_MESSAGE,
          interrupt: false,
        };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: verdict } };
}
