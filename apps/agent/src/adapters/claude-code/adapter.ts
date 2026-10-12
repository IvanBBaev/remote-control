import type { Capabilities } from '@remote-control/protocol';

import type { AgentAdapter, HookEvent } from '../../ports/agent-adapter.js';
import { decideClaudeCode } from './decide.js';

/**
 * Claude Code in M0: approve or deny `PermissionRequest`. "Always" (M1-02), questions
 * (M1-01), follow-up and starting sessions turn on with their work packages.
 */
export const CLAUDE_CODE_CAPABILITIES: Capabilities = Object.freeze({
  agent: 'claude-code',
  always: false,
  questions: false,
  instructions: false,
  startSession: false,
});

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Maps a Claude Code hook payload (04 §2.1–2.2); `null` for anything malformed or unmapped. */
export function claudeCodeHookEvent(raw: unknown): HookEvent | null {
  if (!isObject(raw)) return null;
  const sessionId = text(raw['session_id']);
  const cwd = text(raw['cwd']);
  if (sessionId === undefined || sessionId === '' || cwd === undefined) return null;
  switch (raw['hook_event_name']) {
    case 'PermissionRequest': {
      const toolName = text(raw['tool_name']);
      if (toolName === undefined || toolName === '') return null;
      const rawSuggestions = raw['permission_suggestions'];
      const suggestions = Array.isArray(rawSuggestions) ? [...(rawSuggestions as unknown[])] : [];
      return {
        kind: 'permission',
        sessionId,
        cwd,
        toolName,
        toolInput: raw['tool_input'] ?? null,
        suggestions,
        alwaysSupported: suggestions.length > 0,
      };
    }
    case 'SessionStart':
    case 'SessionEnd': {
      const start = raw['hook_event_name'] === 'SessionStart';
      const transcriptPath = text(raw['transcript_path']);
      const detail = text(raw[start ? 'source' : 'reason']);
      return {
        kind: 'session',
        phase: start ? 'start' : 'end',
        sessionId,
        cwd,
        ...(transcriptPath === undefined ? {} : { transcriptPath }),
        ...(detail === undefined ? {} : { detail }),
      };
    }
    default:
      return null;
  }
}

/** The Claude Code adapter (D11, D12). */
export const claudeCodeAdapter: AgentAdapter = Object.freeze({
  id: 'claude-code',
  capabilities: CLAUDE_CODE_CAPABILITIES,
  onHook: claudeCodeHookEvent,
  decide: decideClaudeCode,
});
