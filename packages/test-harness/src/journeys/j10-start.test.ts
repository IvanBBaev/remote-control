import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCanaries } from '../canaries.js';
import { scenario, type Scenario } from '../scenario.js';
import { decisionResult, JOURNEY, lastSnapshot, logEvents, userVerified } from './fixtures.js';

// The agent spawns `claude` from PATH without a shell; on Windows that is `claude.cmd`,
// which the harness shim cannot stand in for (ADR 0005).
describe.skipIf(process.platform === 'win32')(
  'J10 — start a session from the phone (M1-04)',
  () => {
    let running: Scenario | undefined;
    afterEach(async () => {
      await running?.close();
      running = undefined;
    });

    it(
      'lists the allow-list, asks for a passkey and spawns `claude --bg` with the exact argv in the repository',
      JOURNEY,
      async () => {
        running = await scenario({
          canaries: createCanaries('CANARY'),
          repositories: ['app'],
          env: { FAKE_CLAUDE_SCENARIO: 'stop' },
        });
        const { phone, agent, canaries } = running;
        const [root] = agent.repositories;

        // The snapshot names the allow-list; the phone can only pick from it.
        const snapshot = await lastSnapshot(phone);
        expect(snapshot.machine.agents[0]).toMatchObject({
          startSession: true,
          instructions: true,
        });
        expect(snapshot.repositories).toEqual([
          {
            id: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown,
            machineId: running.agentDeviceId,
            name: 'app',
            path: root,
          },
        ]);
        const repository = snapshot.repositories![0]!;

        const prompt = `Fix the build ${canaries.mint('PROMPT')}`;
        const get = vi.spyOn(phone.authenticator, 'get');
        const requestId = await phone.start(
          { machineId: repository.machineId, repositoryId: repository.id, prompt },
          repository.path,
        );
        // `start` needs a user-verifying assertion at the relay (D7).
        expect(get).toHaveBeenCalledOnce();
        const assertion = await (get.mock.results[0]!.value as ReturnType<
          typeof phone.authenticator.get
        >);
        expect(userVerified(assertion.response.authenticatorData)).toBe(true);

        expect(await decisionResult(phone, requestId)).toMatchObject({ result: 'accepted' });

        // D11, D13: the literal argv, the prompt as one element, the repository as cwd.
        const starts = (await agent.claudeRuns()).filter((run) => run.argv[0] === '--bg');
        expect(starts).toEqual([
          {
            cwd: root,
            argv: [
              '--bg',
              '--name',
              expect.stringMatching(/^rc-app-[0-9a-f]{8}$/) as unknown,
              prompt,
            ],
          },
        ]);
        expect(logEvents(agent.logs(), 'launch_started')).toHaveLength(1);

        // The prompt reached the agent sealed: not in the relay's logs, database or pushes,
        // nor in the agent's own log (I1, I3).
        await running.assertNoLeaks();
      },
    );
  },
);
