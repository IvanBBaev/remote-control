import type { Capabilities } from '@remote-control/protocol';

import { ASK_USER_QUESTION } from '../../core/hook-dispatcher.js';
import type {
  AgentAdapter,
  HookEvent,
  QuestionEventItem,
  QuestionEventOption,
} from '../../ports/agent-adapter.js';
import { decideClaudeCode } from './decide.js';

/**
 * Claude Code: approve or deny `PermissionRequest`, answer `AskUserQuestion` (M1-01).
 * "Always" (M1-02), follow-up and starting sessions turn on with their work packages.
 */
export const CLAUDE_CODE_CAPABILITIES: Capabilities = Object.freeze({
  agent: 'claude-code',
  always: false,
  questions: true,
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

function option(raw: unknown): QuestionEventOption | undefined {
  if (!isObject(raw)) return undefined;
  const label = text(raw['label']);
  if (label === undefined) return undefined;
  const description = text(raw['description']);
  return description === undefined ? { label } : { label, description };
}

function questionItem(raw: unknown): QuestionEventItem | undefined {
  if (!isObject(raw) || !Array.isArray(raw['options'])) return undefined;
  const question = text(raw['question']);
  const options = (raw['options'] as unknown[]).map(option);
  if (question === undefined || options.some((entry) => entry === undefined)) return undefined;
  const header = text(raw['header']);
  return {
    question,
    ...(header === undefined ? {} : { header }),
    options: options as QuestionEventOption[],
    multiSelect: raw['multiSelect'] === true,
  };
}

/** The `AskUserQuestion` input as questions; `undefined` when any part is malformed. */
function questionItems(toolInput: unknown): QuestionEventItem[] | undefined {
  if (!isObject(toolInput) || !Array.isArray(toolInput['questions'])) return undefined;
  const items = (toolInput['questions'] as unknown[]).map(questionItem);
  if (items.length === 0 || items.some((item) => item === undefined)) return undefined;
  return items as QuestionEventItem[];
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
    case 'PreToolUse': {
      if (raw['tool_name'] !== ASK_USER_QUESTION) return null;
      const questions = questionItems(raw['tool_input']);
      return questions === undefined ? null : { kind: 'question', sessionId, cwd, questions };
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
