import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCanaries } from '../canaries.js';
import { scenario, type Scenario } from '../scenario.js';
import { decisionResult, JOURNEY, nextRequest, permissionRequest } from './fixtures.js';

describe('J3 — PermissionRequest denied (M0-22)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('answers Claude Code `deny` and logs the deciding phone by device id', JOURNEY, async () => {
    running = await scenario({ canaries: createCanaries('CANARY') });
    const { phone, agent, canaries } = running;

    const hook = agent.fire(permissionRequest(canaries));
    const { request } = await nextRequest(phone);
    const get = vi.spyOn(phone.authenticator, 'get');
    await phone.decide('deny', request);
    // Deny needs no passkey (D7).
    expect(get).not.toHaveBeenCalled();

    expect(await decisionResult(phone, request.id)).toMatchObject({ result: 'accepted' });
    expect((await hook).output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Denied from phone', interrupt: false },
      },
    });
    const applied = agent
      .logs()
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => JSON.stringify(entry).includes('decision_applied'));
    expect(applied).toHaveLength(1);
    expect(JSON.stringify(applied[0])).toContain(phone.deviceId);
    expect(JSON.stringify(applied[0])).toContain(request.id);

    await running.assertNoLeaks();
  });
});
