/**
 * Hook stdin payloads, field for field as documented in 04 §2.1–2.4. Where 04 §2 shows no
 * example the fields come from its prose; assumptions are marked and verified in M0-23.
 */

export interface PayloadContext {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly cwd: string;
  readonly permissionMode: string;
  /** Present on turn-scoped events (04 §2.1). */
  readonly promptId?: string;
}

type Payload = Record<string, unknown> & { hook_event_name: string };

function common(ctx: PayloadContext, event: string, turnScoped: boolean): Payload {
  return {
    session_id: ctx.sessionId,
    ...(turnScoped && ctx.promptId !== undefined ? { prompt_id: ctx.promptId } : {}),
    transcript_path: ctx.transcriptPath,
    cwd: ctx.cwd,
    permission_mode: ctx.permissionMode,
    hook_event_name: event,
  };
}

/** 04 §2.1 example: tool events add `tool_name`, `tool_input`, `tool_use_id`. */
export function preToolUsePayload(
  ctx: PayloadContext,
  tool: { toolName: string; toolInput: Record<string, unknown>; toolUseId: string },
): Payload {
  return {
    ...common(ctx, 'PreToolUse', true),
    tool_name: tool.toolName,
    tool_input: tool.toolInput,
    tool_use_id: tool.toolUseId,
  };
}

/**
 * 04 §2.2 example: adds `tool_name`, `tool_input`, `permission_suggestions`; **no**
 * `tool_use_id`. Assumption: no `prompt_id` (the documented example has none).
 */
export function permissionRequestPayload(
  ctx: PayloadContext,
  tool: {
    toolName: string;
    toolInput: Record<string, unknown>;
    permissionSuggestions?: readonly unknown[];
  },
): Payload {
  return {
    ...common(ctx, 'PermissionRequest', false),
    tool_name: tool.toolName,
    tool_input: tool.toolInput,
    ...(tool.permissionSuggestions !== undefined
      ? { permission_suggestions: tool.permissionSuggestions }
      : {}),
  };
}

/** 04 §2.4 / 07 §2.1: `tool_input`, `tool_response`, `tool_use_id`, `duration_ms`. */
export function postToolUsePayload(
  ctx: PayloadContext,
  tool: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolResponse: unknown;
    toolUseId: string;
    durationMs: number;
  },
): Payload {
  return {
    ...common(ctx, 'PostToolUse', true),
    tool_name: tool.toolName,
    tool_input: tool.toolInput,
    tool_response: tool.toolResponse,
    tool_use_id: tool.toolUseId,
    duration_ms: tool.durationMs,
  };
}

/** 04 §2.4: `UserPromptSubmit` carries `prompt`. */
export function userPromptSubmitPayload(ctx: PayloadContext, prompt: string): Payload {
  return { ...common(ctx, 'UserPromptSubmit', true), prompt };
}

/**
 * 04 §2.4 example: `message`, `title`, `notification_type`. The documented example has no
 * `permission_mode`, so the fake omits it too.
 */
export function notificationPayload(
  ctx: PayloadContext,
  notification: { message: string; title: string; notificationType: string },
): Payload {
  return {
    session_id: ctx.sessionId,
    transcript_path: ctx.transcriptPath,
    cwd: ctx.cwd,
    hook_event_name: 'Notification',
    message: notification.message,
    title: notification.title,
    notification_type: notification.notificationType,
  };
}

/** 04 §2.4: `stop_hook_active`, `last_assistant_message`, `background_tasks[]`, `session_crons[]`. */
export function stopPayload(
  ctx: PayloadContext,
  stop: { stopHookActive: boolean; lastAssistantMessage: string },
): Payload {
  return {
    ...common(ctx, 'Stop', true),
    stop_hook_active: stop.stopHookActive,
    last_assistant_message: stop.lastAssistantMessage,
    background_tasks: [],
    session_crons: [],
  };
}

/** 04 §2.4: `SubagentStop` adds `agent_id`, `agent_type`, `agent_transcript_path` to Stop's fields. */
export function subagentStopPayload(
  ctx: PayloadContext,
  stop: {
    stopHookActive: boolean;
    lastAssistantMessage: string;
    agentId: string;
    agentType: string;
    agentTranscriptPath: string;
  },
): Payload {
  return {
    ...stopPayload(ctx, stop),
    hook_event_name: 'SubagentStop',
    agent_id: stop.agentId,
    agent_type: stop.agentType,
    agent_transcript_path: stop.agentTranscriptPath,
  };
}

/** 04 §2.4: `source` = `startup` | `resume` | `clear` | `compact` (07 adds `fork`). */
export function sessionStartPayload(ctx: PayloadContext, source: string): Payload {
  return { ...common(ctx, 'SessionStart', false), source };
}

/** 04 §2.4: `SessionEnd` carries `reason`. */
export function sessionEndPayload(ctx: PayloadContext, reason: string): Payload {
  return { ...common(ctx, 'SessionEnd', false), reason };
}

/**
 * 04 §2.1: `PreCompact` matchers test `trigger`. Assumption: `custom_instructions` is
 * present (empty for `auto`), as in the hooks reference; 04 §2 does not list it.
 */
export function preCompactPayload(
  ctx: PayloadContext,
  compact: { trigger: 'manual' | 'auto'; customInstructions: string },
): Payload {
  return {
    ...common(ctx, 'PreCompact', false),
    trigger: compact.trigger,
    custom_instructions: compact.customInstructions,
  };
}

/** The literal JSON examples of 04 §2.1–2.4, for `fake-claude fire --fixture <name>`. */
export const DOCUMENTED_EXAMPLES: Readonly<Record<string, Payload>> = {
  'bash-npm-test': {
    session_id: 'abc123',
    prompt_id: 'prompt_01',
    transcript_path: '/home/synthetic/.claude/projects/-home-synthetic-project/abc123.jsonl',
    cwd: '/home/synthetic/project',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_use_id: 'toolu_01ABC123',
  },
  'bash-rm-rf': {
    session_id: 'abc123',
    transcript_path: '/home/synthetic/.claude/projects/-home-synthetic-project/abc123.jsonl',
    cwd: '/home/synthetic/project',
    permission_mode: 'default',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf node_modules', description: 'Remove node_modules directory' },
    permission_suggestions: [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'rm -rf node_modules' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ],
  },
  'ask-framework': {
    session_id: 'abc123',
    prompt_id: 'prompt_01',
    transcript_path: '/home/synthetic/.claude/projects/-home-synthetic-project/abc123.jsonl',
    cwd: '/home/synthetic/project',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        {
          question: 'Which framework?',
          header: 'Framework',
          options: [
            { label: 'React', description: 'Component library' },
            { label: 'Vue', description: 'Progressive framework' },
          ],
          multiSelect: false,
        },
      ],
    },
    tool_use_id: 'toolu_01ASK',
  },
  'notification-permission': {
    session_id: 'abc123',
    transcript_path: '/home/synthetic/.claude/projects/-home-synthetic-project/abc123.jsonl',
    cwd: '/home/synthetic/project',
    hook_event_name: 'Notification',
    message: 'Claude needs your permission',
    title: 'Permission needed',
    notification_type: 'permission_prompt',
  },
};
