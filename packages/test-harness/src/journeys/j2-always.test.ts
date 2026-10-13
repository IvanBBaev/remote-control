import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCanaries } from '../canaries.js';
import { scenario, type Scenario } from '../scenario.js';
import {
  decisionResult,
  JOURNEY,
  nextRequest,
  permissionRequest,
  userVerified,
} from './fixtures.js';

describe('J2 variant — "Always (this session)" from the phone (M1-02, D24)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it(
    'grants the suggested rule for this session only, behind a user-verifying passkey',
    JOURNEY,
    async () => {
      running = await scenario({ canaries: createCanaries('CANARY') });
      const { phone, agent, canaries } = running;
      const ruleContent = `echo ${canaries.mint('RULE')}`;
      // Claude Code proposes the project's local settings file (04 §2.2); M1 never writes it.
      const input = permissionRequest(canaries, [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ]);

      const hook = agent.fire(input);
      const { request } = await nextRequest(phone);
      expect(request).toMatchObject({
        alwaysSupported: true,
        suggestions: [`Bash(${ruleContent})`],
      });

      const get = vi.spyOn(phone.authenticator, 'get');
      await phone.decide('always', request);
      // "Always" widens what the agent may do, so it needs the same UV assertion as Allow.
      expect(get).toHaveBeenCalledOnce();
      const assertion = await (get.mock.results[0]!.value as ReturnType<
        typeof phone.authenticator.get
      >);
      expect(userVerified(assertion.response.authenticatorData)).toBe(true);

      expect(await decisionResult(phone, request.id)).toMatchObject({ result: 'accepted' });
      const result = await hook;
      expect(result.output).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedPermissions: [
              {
                type: 'addRules',
                rules: [{ toolName: 'Bash', ruleContent }],
                behavior: 'allow',
                destination: 'session',
              },
            ],
          },
        },
      });

      await running.assertNoLeaks();
    },
  );

  it('offers no "Always" when Claude Code suggested no rule', JOURNEY, async () => {
    running = await scenario({ canaries: createCanaries('CANARY') });
    const { phone, agent, canaries } = running;
    void agent.fire(permissionRequest(canaries));
    const { request } = await nextRequest(phone);
    expect(request).toMatchObject({ alwaysSupported: false, suggestions: [] });
  });
});
