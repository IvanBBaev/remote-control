import { digestCanonical } from './digest.js';
import { toHex } from './encoding.js';

/** What a request hash covers: a tool call, or a prompt started in a directory. */
export type RequestHashInput =
  | { readonly toolName: string; readonly toolInput: unknown }
  | { readonly prompt: string; readonly cwd: string };

/**
 * Hex SHA-256 binding a decision to the exact request (D7): the canonical JSON of
 * `{tool_name, tool_input}` for a tool call, or `{cwd, prompt}` for a prompt. Hashing a
 * JSON object rather than a concatenation keeps the two parts unambiguous.
 */
export async function requestHash(input: RequestHashInput): Promise<string> {
  const subject =
    'toolName' in input
      ? { tool_name: input.toolName, tool_input: input.toolInput }
      : { prompt: input.prompt, cwd: input.cwd };
  return toHex(await digestCanonical(subject));
}
