import { ApprovalRequest, requestHash } from '@remote-control/protocol';

import type { PendingRequest } from './pending-store.js';

/** `ApprovalRequest.content` cap (04 §5.2): longer content is cut and flagged. */
export const MAX_CONTENT_LENGTH = 4000;
const MAX_NAME_LENGTH = 200;

const TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  Bash: 'Run a command',
  Edit: 'Edit a file',
  MultiEdit: 'Edit a file',
  Write: 'Write a file',
  Read: 'Read a file',
  WebFetch: 'Fetch a web page',
});

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

/** A short human label for the tool ("Run a command", "Use Glob"). */
export function toolLabel(toolName: string): string {
  return (TOOL_LABELS[toolName] ?? `Use ${toolName}`).slice(0, MAX_NAME_LENGTH);
}

function stringField(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** What the phone shows: the command, else the file path, else the input as JSON. */
export function toolContent(toolInput: unknown): string {
  return (
    stringField(toolInput, 'command') ??
    stringField(toolInput, 'file_path') ??
    stringField(toolInput, 'url') ??
    JSON.stringify(toolInput)
  );
}

/**
 * The phone's view of a pending permission request (D7). `undefined` when the hook input
 * cannot be shown as an `ApprovalRequest` (no tool name, a session id the protocol does
 * not accept); such a request stays with the terminal.
 */
export function approvalView(request: PendingRequest, hash: string): ApprovalRequest | undefined {
  const { toolName, toolInput } = toolCall(request);
  const content = toolContent(toolInput);
  const truncated = content.length > MAX_CONTENT_LENGTH;
  const parsed = ApprovalRequest.safeParse({
    id: request.id,
    sessionId: request.sessionId,
    requestHash: hash,
    toolLabel: toolLabel(toolName),
    toolName,
    content: truncated ? content.slice(0, MAX_CONTENT_LENGTH) : content,
    truncated,
    suggestions: [],
    expiresAt: request.deadline,
    alwaysSupported: false,
  });
  return parsed.success ? parsed.data : undefined;
}
