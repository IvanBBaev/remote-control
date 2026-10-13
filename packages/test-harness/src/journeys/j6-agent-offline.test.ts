import { afterEach, describe, expect, it } from 'vitest';

import { createCanaries } from '../canaries.js';
import { scenario, type Scenario } from '../scenario.js';
import { JOURNEY, permissionRequest } from './fixtures.js';

describe('J6 — the agent is down: the hook falls through (M0-22)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('prints nothing and exits 0, so Claude Code prompts in the terminal', JOURNEY, async () => {
    running = await scenario({ canaries: createCanaries('CANARY') });
    const { phone, agent, canaries } = running;

    await agent.stop();
    const result = await agent.fire(permissionRequest(canaries));
    expect(result).toEqual({ stdout: '', output: undefined });
    // Nothing reached the phone: the request never left the machine.
    expect(phone.of('request')).toEqual([]);

    await running.assertNoLeaks();
  });
});
