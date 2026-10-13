import { codexPermissionRequestPayload } from '@remote-control/fake-claude-code';
import { afterEach, describe, expect, it } from 'vitest';

import { createCanaries, type Canaries } from '../canaries.js';
import { scenario, type Scenario } from '../scenario.js';
import { decisionResult, JOURNEY, nextRequest } from './fixtures.js';

const CODEX_SESSION_ID = '0199a3c4-5e6f-7a8b-9c0d-1e2f3a4b5c6d';

/** A Codex `PermissionRequest` (04 §2.11) whose private fields are canaries. */
function codexPermissionRequest(canaries: Canaries): Record<string, unknown> {
  return codexPermissionRequestPayload(
    {
      sessionId: CODEX_SESSION_ID,
      turnId: 'turn-1',
      model: 'gpt-5-codex',
      transcriptPath: `/home/synthetic/.codex/sessions/${canaries.mint('PATH')}.jsonl`,
      cwd: `/home/synthetic/${canaries.mint('CWD')}`,
      permissionMode: 'default',
    },
    {
      toolName: 'shell',
      toolInput: { command: ['bash', '-lc', `echo ${canaries.mint('TOOLINPUT')}`] },
      toolUseId: 'call_1',
    },
  );
}

describe('J2/J3 — Codex PermissionRequest through the same phone flow (M2-01)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('answers Codex `allow` in its own output shape', JOURNEY, async () => {
    running = await scenario({ canaries: createCanaries('CANARY') });
    const { phone, agent, canaries } = running;

    const hook = agent.fire(codexPermissionRequest(canaries), undefined, 'codex');
    const { request } = await nextRequest(phone);
    expect(request).toMatchObject({ sessionId: CODEX_SESSION_ID });
    await phone.decide('allow', request);

    expect(await decisionResult(phone, request.id)).toMatchObject({ result: 'accepted' });
    expect((await hook).output).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    await running.assertNoLeaks();
  });

  it('answers Codex `deny` with a message and no Claude-only fields', JOURNEY, async () => {
    running = await scenario({ canaries: createCanaries('CANARY') });
    const { phone, agent, canaries } = running;

    const hook = agent.fire(codexPermissionRequest(canaries), undefined, 'codex');
    const { request } = await nextRequest(phone);
    await phone.decide('deny', request);

    expect(await decisionResult(phone, request.id)).toMatchObject({ result: 'accepted' });
    expect((await hook).output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Denied from phone' },
      },
    });
    await running.assertNoLeaks();
  });

  it('never holds a Codex PreToolUse: it only feeds the session list', JOURNEY, async () => {
    running = await scenario({ canaries: createCanaries('CANARY') });
    const { agent, canaries } = running;

    const input = {
      ...codexPermissionRequest(canaries),
      hook_event_name: 'PreToolUse',
    };
    expect((await agent.fire(input, undefined, 'codex')).output).toBeUndefined();
    await running.assertNoLeaks();
  });
});
