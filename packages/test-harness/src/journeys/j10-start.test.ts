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
            maxPermissionMode: 'default',
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

    it(
      'starts in a picked mode within the folder bound and refuses one above it (M2-09)',
      JOURNEY,
      async () => {
        running = await scenario({
          repositories: [{ name: 'app', maxPermissionMode: 'acceptEdits' }, 'docs'],
          env: { FAKE_CLAUDE_SCENARIO: 'stop' },
        });
        const { phone, agent } = running;
        const [root] = agent.repositories;
        const snapshot = await lastSnapshot(phone);
        const [app, docs] = snapshot.repositories!;
        expect(app).toMatchObject({ name: 'app', maxPermissionMode: 'acceptEdits' });
        expect(docs).toMatchObject({ name: 'docs', maxPermissionMode: 'default' });

        const accepted = await phone.start(
          {
            machineId: app!.machineId,
            repositoryId: app!.id,
            prompt: 'Edit away',
            permissionMode: 'acceptEdits',
          },
          app!.path,
        );
        expect(await decisionResult(phone, accepted)).toMatchObject({ result: 'accepted' });
        // D11 as amended by ADR 0006: the one literal mode flag, right after `--bg`.
        expect((await agent.claudeRuns()).filter((run) => run.argv[0] === '--bg')).toEqual([
          {
            cwd: root,
            argv: [
              '--bg',
              '--permission-mode',
              'acceptEdits',
              '--name',
              expect.stringMatching(/^rc-app-[0-9a-f]{8}$/) as unknown,
              'Edit away',
            ],
          },
        ]);

        // A signed, hash-bound mode above the folder's bound still runs nothing (D13).
        const refused = await phone.start(
          {
            machineId: docs!.machineId,
            repositoryId: docs!.id,
            prompt: 'Edit away',
            permissionMode: 'acceptEdits',
          },
          docs!.path,
        );
        expect(await decisionResult(phone, refused)).toMatchObject({
          result: 'rejected',
          reason: 'not_allowed',
        });
        expect((await agent.claudeRuns()).filter((run) => run.argv[0] === '--bg')).toHaveLength(1);
        expect(logEvents(agent.logs(), 'launch_refused')).toEqual([
          expect.objectContaining({ reason: 'permission_mode_above_bound' }),
        ]);
      },
    );
  },
);
