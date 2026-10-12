/**
 * The hook events the fake fires (04 §2.1, the set D11 installs) and their per-event
 * contract: which input field the matcher tests, the default timeout and what exit 2 means.
 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

export function isHookEventName(value: string): value is HookEventName {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * Input field a matcher is tested against (04 §2.1: `tool_name` for tool events,
 * `notification_type`, `source`, `trigger`). `null` = the event ignores matchers.
 * Assumption: `SessionEnd` ignores matchers (04 §2 is silent on matching `reason`).
 */
export const MATCHER_FIELD: Record<HookEventName, string | null> = {
  PreToolUse: 'tool_name',
  PermissionRequest: 'tool_name',
  PostToolUse: 'tool_name',
  UserPromptSubmit: null,
  Notification: 'notification_type',
  Stop: null,
  SubagentStop: null,
  SessionStart: 'source',
  SessionEnd: null,
  PreCompact: 'trigger',
};

/** 04 §2.1: 600 s for `command`, 30 s on `UserPromptSubmit`, 1.5 s budget on `SessionEnd`. */
export function defaultTimeoutSeconds(event: HookEventName): number {
  if (event === 'UserPromptSubmit') return 30;
  if (event === 'SessionEnd') return 1.5;
  return 600;
}

/** 04 §2.1: the `SessionEnd` budget is raisable to 60 s, never beyond. */
export const SESSION_END_MAX_SECONDS = 60;

/**
 * What exit 2 does per event (04 §2.1–2.4). `block` = the event is blocked and stderr is
 * the reason; `ignored` = treated as a non-blocking error.
 * 04 §2.2: exit 2 is **not** honoured for `PermissionRequest`.
 * Assumption: `PostToolUse` exit 2 feeds stderr back to Claude (the tool already ran),
 * reported as `block`; `Notification`, `SessionStart`, `SessionEnd` and `PreCompact`
 * cannot block (04 §2 lists no blocking for them).
 */
export const EXIT2_BLOCKS: Record<HookEventName, boolean> = {
  PreToolUse: true,
  PermissionRequest: false,
  PostToolUse: true,
  UserPromptSubmit: true,
  Notification: false,
  Stop: true,
  SubagentStop: true,
  SessionStart: false,
  SessionEnd: false,
  PreCompact: false,
};
