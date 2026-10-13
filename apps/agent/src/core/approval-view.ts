import { ApprovalRequest, requestHash, toolInfo } from '@remote-control/protocol';
import type { ToolKind } from '@remote-control/protocol';

import type { PendingRequest } from './pending-store.js';

/** `ApprovalRequest.content` cap (04 §5.2): longer content is cut and flagged. */
export const MAX_CONTENT_LENGTH = 4000;
/** `ApprovalRequest.project` cap, as `Repository.name`. */
const MAX_PROJECT_LENGTH = 128;

/** The tool name and input of a permission hook, as Claude Code sends them. */
export interface ToolCall {
  readonly toolName: string;
  readonly toolInput: unknown;
}

export function toolCall(request: PendingRequest): ToolCall {
  const name = request.payload['tool_name'];
  return {
    toolName: typeof name === 'string' ? name : '',
    toolInput: request.payload['tool_input'] ?? null,
  };
}

/** The D7 request hash over the tool name and input the hook received. */
export function pendingRequestHash(request: PendingRequest): Promise<string> {
  return requestHash(toolCall(request));
}

/** The protocol's plain-word label (01 W4): "Run a command", "github: create issue". */
export function toolLabel(toolName: string): string {
  return toolInfo(toolName).label;
}

/**
 * The last segment of a working directory (D21: the folder name, never the full path).
 * `undefined` when there is none to show.
 */
export function projectName(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string') return undefined;
  const name = cwd.split(/[\\/]+/).findLast((segment) => segment !== '');
  return name === undefined ? undefined : name.slice(0, MAX_PROJECT_LENGTH);
}

function stringField(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Input fields that say what each kind of tool will do, most telling first. */
const CONTENT_FIELDS: Readonly<Record<ToolKind, readonly string[]>> = {
  command: ['command'],
  file: ['file_path', 'notebook_path', 'path'],
  search: ['pattern'],
  web: ['url', 'query'],
  agent: ['description', 'prompt', 'skill'],
  plan: ['plan'],
  question: [],
  mcp: [],
  other: ['command', 'file_path', 'url'],
};

/**
 * What the phone shows (01 W4): the command, the file path, the search pattern (with its
 * folder), the URL or query, the subagent's task; anything else is the input as JSON.
 */
export function toolContent(toolInput: unknown, toolName = ''): string {
  const { kind } = toolInfo(toolName);
  for (const field of CONTENT_FIELDS[kind]) {
    const value = stringField(toolInput, field);
    if (value === undefined) continue;
    const where = kind === 'search' ? stringField(toolInput, 'path') : undefined;
    return where === undefined ? value : `${value}\nin ${where}`;
  }
  return JSON.stringify(toolInput);
}

/**
 * The phone's view of a pending permission request (D7). `undefined` when the hook input
 * cannot be shown as an `ApprovalRequest` (no tool name, a session id the protocol does
 * not accept); such a request stays with the terminal.
 */
export function approvalView(request: PendingRequest, hash: string): ApprovalRequest | undefined {
  const { toolName, toolInput } = toolCall(request);
  const content = toolContent(toolInput, toolName);
  const project = projectName(request.payload['cwd']);
  const truncated = content.length > MAX_CONTENT_LENGTH;
  const parsed = ApprovalRequest.safeParse({
    id: request.id,
    sessionId: request.sessionId,
    requestHash: hash,
    toolLabel: toolLabel(toolName),
    toolName,
    ...(project === undefined ? {} : { project }),
    content: truncated ? content.slice(0, MAX_CONTENT_LENGTH) : content,
    truncated,
    suggestions: [],
    expiresAt: request.deadline,
    alwaysSupported: false,
  });
  return parsed.success ? parsed.data : undefined;
}
