import { permissionRequestPayload, preToolUsePayload } from '@remote-control/fake-claude-code';
import type { QuestionMessage, RequestMessage } from '@remote-control/protocol';

import type { Canaries } from '../canaries.js';
import { eventually } from '../eventually.js';
import type { HeadlessPhone } from '../phone.js';

/** Per-journey budget: PGlite migrations plus the run (the AC is < 60 s for all six). */
export const JOURNEY = { timeout: 30_000 } as const;

/** The Claude Code session every journey's requests come from. */
export const JOURNEY_SESSION_ID = '5d3c9a1e-7b2f-4c8d-9e6a-1f0b2c3d4e5f';

/** The flag a user-verifying assertion sets in `authenticatorData` (WebAuthn §6.1). */
const FLAG_UV = 0x04;

/**
 * A `PermissionRequest` hook input whose tool input, working directory and transcript
 * path all carry canaries (07 §5.12): the phone must see them, the relay never. Pass
 * `permissionSuggestions` for the rules Claude Code offers to "always" allow (04 §2.2).
 */
export function permissionRequest(
  canaries: Canaries,
  permissionSuggestions?: readonly unknown[],
): Record<string, unknown> & {
  hook_event_name: string;
} {
  return permissionRequestPayload(
    {
      sessionId: JOURNEY_SESSION_ID,
      transcriptPath: `/home/synthetic/.claude/projects/${canaries.mint('PATH')}/session.jsonl`,
      cwd: `/home/synthetic/${canaries.mint('CWD')}`,
      permissionMode: 'default',
    },
    {
      toolName: 'Bash',
      toolInput: {
        command: `echo ${canaries.mint('TOOLINPUT')}`,
        description: canaries.mint('DESCRIPTION'),
      },
      ...(permissionSuggestions !== undefined ? { permissionSuggestions } : {}),
    },
  );
}

/**
 * A `PreToolUse` hook input for `AskUserQuestion` (04 §2.3, M1-01): two questions, one
 * single- and one multi-select, whose texts, headers, option labels and descriptions are
 * canaries, so the phone must see them and the relay never.
 */
export function questionRequest(canaries: Canaries): Record<string, unknown> & {
  hook_event_name: string;
} {
  return preToolUsePayload(
    {
      sessionId: JOURNEY_SESSION_ID,
      transcriptPath: `/home/synthetic/.claude/projects/${canaries.mint('PATH')}/session.jsonl`,
      cwd: `/home/synthetic/${canaries.mint('CWD')}`,
      permissionMode: 'default',
    },
    {
      toolName: 'AskUserQuestion',
      toolUseId: 'toolu_01HarnessQuestion',
      toolInput: {
        questions: [
          {
            question: `Which framework for ${canaries.mint('QUESTION')}?`,
            header: canaries.mint('HEADER'),
            options: [
              { label: canaries.mint('OPTION'), description: canaries.mint('OPTIONDESC') },
              { label: canaries.mint('OPTION') },
            ],
            multiSelect: false,
          },
          {
            question: `Which checks for ${canaries.mint('QUESTION')}?`,
            options: [{ label: canaries.mint('OPTION') }, { label: canaries.mint('OPTION') }],
            multiSelect: true,
          },
        ],
      },
    },
  );
}

/** Waits until the phone holds `count` decrypted `question` messages; returns the last. */
export async function nextQuestion(phone: HeadlessPhone, count = 1): Promise<QuestionMessage> {
  await eventually(() => phone.of('question').length >= count, 'phone: no question message');
  return phone.of('question')[count - 1]!;
}

/** Waits until the phone holds `count` decrypted `request` messages; returns the last. */
export async function nextRequest(phone: HeadlessPhone, count = 1): Promise<RequestMessage> {
  await eventually(() => phone.of('request').length >= count, 'phone: no request message');
  return phone.of('request')[count - 1]!;
}

/** Waits for the agent's `decision_result` for `requestId`. */
export async function decisionResult(phone: HeadlessPhone, requestId: string) {
  await eventually(
    () => phone.of('decision_result').some((result) => result.requestId === requestId),
    'phone: no decision_result',
  );
  return phone.of('decision_result').find((result) => result.requestId === requestId)!;
}

/** True when a WebAuthn assertion's `authenticatorData` (base64url) has the UV flag. */
export function userVerified(authenticatorData: string): boolean {
  const flags = Buffer.from(authenticatorData, 'base64url')[32] ?? 0;
  return (flags & FLAG_UV) !== 0;
}
