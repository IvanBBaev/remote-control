import type { Capabilities } from '@remote-control/protocol';

import type { PendingRequest } from '../../core/pending-store.js';
import type { AdapterDecision, AgentAdapter, HookEvent } from '../../ports/agent-adapter.js';
import { DEFAULT_DENY_MESSAGE } from '../claude-code/decide.js';

/**
 * Codex CLI (M2-01, 04 §2.11, §5.9): approve or deny `PermissionRequest`. Codex has no
 * question tool its hooks can answer (04 A7), no "always" rules in the hook output, and a
 * follow-up through `codex exec resume` is unverified (04 §8), so all of those stay off.
 */
export const CODEX_CAPABILITIES: Capabilities = Object.freeze({
  agent: 'codex',
  always: false,
  questions: false,
  instructions: false,
  startSession: false,
});

type HookOutput = Readonly<Record<string, unknown>>;

/** No decision: Codex shows its own approval prompt (D10 handoff). */
const NO_DECISION: HookOutput = Object.freeze({});

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Maps a Codex hook payload (04 §2.11): the input fields match Claude Code's for the
 * events Codex shares; `null` for anything malformed or unmapped.
 */
export function codexHookEvent(raw: unknown): HookEvent | null {
  if (!isObject(raw)) return null;
  const sessionId = text(raw['session_id']);
  const cwd = text(raw['cwd']);
  if (sessionId === undefined || sessionId === '' || cwd === undefined) return null;
  switch (raw['hook_event_name']) {
    case 'PermissionRequest': {
      const toolName = text(raw['tool_name']);
      if (toolName === undefined || toolName === '') return null;
      return {
        kind: 'permission',
        sessionId,
        cwd,
        toolName,
        toolInput: raw['tool_input'] ?? null,
        suggestions: [],
        alwaysSupported: false,
      };
    }
    case 'SessionStart':
    case 'SessionEnd': {
      const transcriptPath = text(raw['transcript_path']);
      return {
        kind: 'session',
        phase: raw['hook_event_name'] === 'SessionStart' ? 'start' : 'end',
        sessionId,
        cwd,
        ...(transcriptPath === undefined ? {} : { transcriptPath }),
      };
    }
    default:
      return null;
  }
}

/**
 * The Codex `PermissionRequest` output (04 §2.11): `hookSpecificOutput.decision.behavior`
 * `allow` or `deny`, in Claude Code's shape. A permission `allow` approves the call
 * exactly as Codex proposed it: the tool input is never rewritten (D11). Anything else — "always",
 * an answer, a handoff, a request that is not a permission — returns no decision (D10).
 */
export function decideCodex(request: PendingRequest, decision: AdapterDecision): HookOutput {
  if (request.kind !== 'permission') return NO_DECISION;
  switch (decision.behavior) {
    case 'allow':
      return {
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      };
    case 'deny':
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: decision.message ?? DEFAULT_DENY_MESSAGE },
        },
      };
    default:
      return NO_DECISION;
  }
}

/** The Codex adapter (D12, M2-01). */
export const codexAdapter: AgentAdapter = Object.freeze({
  id: 'codex',
  capabilities: CODEX_CAPABILITIES,
  onHook: codexHookEvent,
  decide: decideCodex,
});
