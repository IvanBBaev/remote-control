import { digestCanonical } from './digest.js';
import { toHex } from './encoding.js';

/**
 * What a request hash covers: a tool call, a prompt started in a directory (a new
 * session), or a prompt sent to a running session (a follow-up instruction, M1-04).
 */
export type RequestHashInput =
  | { readonly toolName: string; readonly toolInput: unknown }
  | { readonly prompt: string; readonly cwd: string; readonly permissionMode?: string | undefined }
  | { readonly prompt: string; readonly sessionId: string };

/** The canonical object a request hash covers (snake_case keys, as the vectors show). */
export function requestHashSubject(input: RequestHashInput): Record<string, unknown> {
  if ('toolName' in input) return { tool_name: input.toolName, tool_input: input.toolInput };
  if ('cwd' in input) {
    return input.permissionMode === undefined
      ? { prompt: input.prompt, cwd: input.cwd }
      : { prompt: input.prompt, cwd: input.cwd, permission_mode: input.permissionMode };
  }
  return { prompt: input.prompt, session_id: input.sessionId };
}

/**
 * Hex SHA-256 binding a decision to the exact request (D7): the canonical JSON of
 * `{tool_name, tool_input}` for a tool call, `{cwd, prompt}` for a new session's prompt
 * (plus `permission_mode` when the phone picked one, M2-09), or `{prompt, session_id}`
 * for a follow-up. Hashing a JSON object rather than a
 * concatenation keeps the parts unambiguous.
 */
export async function requestHash(input: RequestHashInput): Promise<string> {
  return toHex(await digestCanonical(requestHashSubject(input)));
}
