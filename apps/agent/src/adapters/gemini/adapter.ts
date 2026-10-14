import type { Capabilities } from '@remote-control/protocol';

import type { PendingRequest } from '../../core/pending-store.js';
import type { AdapterDecision, AgentAdapter, HookEvent } from '../../ports/agent-adapter.js';
import { DEFAULT_DENY_MESSAGE } from '../claude-code/decide.js';

/**
 * Gemini CLI (M3, 04 W14, §2.12, §5.9): observe and deny only. Gemini has no approval
 * hook: `BeforeTool` can block a call but an `allow` does not answer Gemini's own
 * confirmation (04 A6), so the phone can only deny. No questions, no "always" rules, no
 * follow-up.
 */
export const GEMINI_CAPABILITIES: Capabilities = Object.freeze({
  agent: 'gemini',
  always: false,
  questions: false,
  instructions: false,
  startSession: false,
});

type HookOutput = Readonly<Record<string, unknown>>;

/** No decision: the call goes on to Gemini's own confirmation in the terminal (D10). */
const NO_DECISION: HookOutput = Object.freeze({});

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Maps a Gemini hook payload (04 §2.12): `BeforeTool` is the gate, `SessionStart` and
 * `SessionEnd` seed the session list; `null` for anything malformed or unmapped.
 */
export function geminiHookEvent(raw: unknown): HookEvent | null {
  if (!isObject(raw)) return null;
  const sessionId = text(raw['session_id']);
  const cwd = text(raw['cwd']);
  if (sessionId === undefined || sessionId === '' || cwd === undefined) return null;
  switch (raw['hook_event_name']) {
    case 'BeforeTool': {
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
 * The Gemini `BeforeTool` output (04 §2.12): `{"decision":"deny","reason":…}` blocks the
 * call; `reason` is required on a deny. Everything else — allow, "always", an answer, a
 * handoff — returns no decision, so Gemini shows its own confirmation and the phone
 * never grants a call (ADR 0013). The tool input is never rewritten (D11).
 */
export function decideGemini(request: PendingRequest, decision: AdapterDecision): HookOutput {
  if (request.kind !== 'permission' || decision.behavior !== 'deny') return NO_DECISION;
  return { decision: 'deny', reason: decision.message ?? DEFAULT_DENY_MESSAGE };
}

/** The Gemini adapter (D12, 04 W14). */
export const geminiAdapter: AgentAdapter = Object.freeze({
  id: 'gemini',
  capabilities: GEMINI_CAPABILITIES,
  onHook: geminiHookEvent,
  decide: decideGemini,
});
