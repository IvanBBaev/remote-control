import { geminiBeforeToolPayload } from '@remote-control/fake-claude-code';
import { afterEach, describe, expect, it } from 'vitest';

import { createCanaries, type Canaries } from '../canaries.js';
import { scenario, type Scenario } from '../scenario.js';
import { decisionResult, JOURNEY, nextRequest } from './fixtures.js';

const GEMINI_SESSION_ID = 'c0ffee00-1111-4222-8333-444455556666';
/** Gemini's own hook timeout is in milliseconds; `hook.cjs T` stays in seconds. */
const HOLD_SECONDS = 1800;

/** A Gemini `BeforeTool` (04 §2.12) whose private fields are canaries. */
function geminiBeforeTool(canaries: Canaries): Record<string, unknown> {
  return geminiBeforeToolPayload(
    {
      sessionId: GEMINI_SESSION_ID,
      transcriptPath: `/home/synthetic/.gemini/tmp/${canaries.mint('PATH')}.json`,
      cwd: `/home/synthetic/${canaries.mint('CWD')}`,
      timestamp: '2026-10-14T09:00:00.000Z',
    },
    {
      toolName: 'run_shell_command',
      toolInput: { command: `echo ${canaries.mint('TOOLINPUT')}` },
    },
  );
}

describe('J2/J3 — Gemini BeforeTool: observe and deny only (04 W14)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('blocks the call on a phone deny, with the reason Gemini requires', JOURNEY, async () => {
    running = await scenario({ canaries: createCanaries('CANARY') });
    const { phone, agent, canaries } = running;

    const hook = agent.fire(geminiBeforeTool(canaries), HOLD_SECONDS, 'gemini');
    const { request } = await nextRequest(phone);
    expect(request).toMatchObject({ sessionId: GEMINI_SESSION_ID });
    await phone.decide('deny', request);

    expect(await decisionResult(phone, request.id)).toMatchObject({ result: 'accepted' });
    expect((await hook).output).toEqual({ decision: 'deny', reason: 'Denied from phone' });
    await running.assertNoLeaks();
  });

  it(
    'never grants: a phone allow leaves the call to Gemini’s own confirmation',
    JOURNEY,
    async () => {
      running = await scenario({ canaries: createCanaries('CANARY') });
      const { phone, agent, canaries } = running;

      const hook = agent.fire(geminiBeforeTool(canaries), HOLD_SECONDS, 'gemini');
      const { request } = await nextRequest(phone);
      await phone.decide('allow', request);

      expect(await decisionResult(phone, request.id)).toMatchObject({ result: 'accepted' });
      expect((await hook).output).toEqual({});
      await running.assertNoLeaks();
    },
  );

  it('never holds a Gemini AfterTool: it only feeds the session list', JOURNEY, async () => {
    running = await scenario({ canaries: createCanaries('CANARY') });
    const { agent, canaries } = running;

    const input = { ...geminiBeforeTool(canaries), hook_event_name: 'AfterTool' };
    expect((await agent.fire(input, undefined, 'gemini')).output).toBeUndefined();
    await running.assertNoLeaks();
  });
});
