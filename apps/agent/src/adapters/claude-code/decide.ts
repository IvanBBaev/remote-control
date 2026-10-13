import { ASK_USER_QUESTION } from '../../core/hook-dispatcher.js';
import type { PendingRequest } from '../../core/pending-store.js';
import type { AdapterDecision, QuestionAnswers } from '../../ports/agent-adapter.js';

/** The deny reason when the phone gave none. */
export const DEFAULT_DENY_MESSAGE = 'Denied from phone';
/** The deny reason for `agent.onExpire: "deny"` (D10). */
export const NO_DECISION_MESSAGE = 'No decision from phone';

type HookOutput = Readonly<Record<string, unknown>>;

/** No decision: Claude Code shows its own prompt (D10 handoff). */
const NO_DECISION: HookOutput = Object.freeze({});

function permissionOutput(decision: AdapterDecision): HookOutput {
  if (decision.behavior !== 'allow' && decision.behavior !== 'deny') return NO_DECISION;
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

/**
 * The `PreToolUse` answer for `AskUserQuestion` (04 §2.3): allow, with the questions
 * exactly as Claude Code sent them and the answers keyed by question text. The single
 * place the agent rewrites a tool input (D11), and only for this one tool.
 */
function answerOutput(request: PendingRequest, answer: QuestionAnswers): HookOutput {
  const toolInput = request.payload['tool_input'];
  if (request.payload['tool_name'] !== ASK_USER_QUESTION) return NO_DECISION;
  if (typeof toolInput !== 'object' || toolInput === null) return NO_DECISION;
  const { questions } = toolInput as Readonly<Record<string, unknown>>;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        questions,
        answers: answer.answers,
        ...(answer.response === undefined ? {} : { response: answer.response }),
      },
    },
  };
}

function questionOutput(request: PendingRequest, decision: AdapterDecision): HookOutput {
  if (decision.behavior === 'answer' && decision.answer !== undefined) {
    return answerOutput(request, decision.answer);
  }
  if (decision.behavior !== 'deny') return NO_DECISION;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.message ?? DEFAULT_DENY_MESSAGE,
    },
  };
}

/**
 * Builds the Claude Code hook output for a decision (04 §2.2–2.3). The only module the
 * argv gate lets emit `updatedInput` (D11), and it does so only to answer an
 * `AskUserQuestion`: a permission `allow` approves the tool input exactly as Claude Code
 * proposed it. Anything that does not fit its request kind hands off (D10).
 */
export function decideClaudeCode(request: PendingRequest, decision: AdapterDecision): HookOutput {
  return request.kind === 'question'
    ? questionOutput(request, decision)
    : permissionOutput(decision);
}
