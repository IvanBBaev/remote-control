import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { scenario, type Scenario } from '../scenario.js';
import { decisionResult, JOURNEY, lastSnapshot, logEvents } from './fixtures.js';

describe.skipIf(process.platform === 'win32')(
  'J11 — a start outside the allow-list is refused (M1-04, D13)',
  () => {
    let running: Scenario | undefined;
    afterEach(async () => {
      await running?.close();
      running = undefined;
    });

    it(
      'refuses an unknown repository id and a vanished root, spawns nothing and logs both',
      JOURNEY,
      async () => {
        running = await scenario({ repositories: ['app', 'gone'] });
        const { phone, agent } = running;
        const snapshot = await lastSnapshot(phone);
        const gone = snapshot.repositories!.find((repository) => repository.name === 'gone')!;

        // An id the agent never offered: the phone cannot name a folder itself.
        const forged = await phone.start(
          { machineId: running.agentDeviceId, repositoryId: 'f'.repeat(32), prompt: 'rm -rf /' },
          '/',
        );
        expect(await decisionResult(phone, forged)).toMatchObject({
          result: 'rejected',
          reason: 'not_allowed',
        });

        // A configured root that no longer resolves is re-checked at launch time and refused.
        await rm(gone.path, { recursive: true, force: true });
        const vanished = await phone.start(
          { machineId: gone.machineId, repositoryId: gone.id, prompt: 'Build it' },
          gone.path,
        );
        expect(await decisionResult(phone, vanished)).toMatchObject({
          result: 'rejected',
          reason: 'not_allowed',
        });

        expect((await agent.claudeRuns()).filter((run) => run.argv.includes('--bg'))).toEqual([]);
        // The audit trail: ids and reasons, never the prompt or the path (I3).
        const rejected = logEvents(agent.logs(), 'command_rejected');
        expect(rejected).toEqual([
          expect.objectContaining({ request_id: forged, kind: 'start', reason: 'not_allowed' }),
        ]);
        expect(logEvents(agent.logs(), 'launch_refused')).toEqual([
          expect.objectContaining({ repository_id: gone.id }),
        ]);
        const text = agent.logs().join('\n');
        expect(text).not.toContain('rm -rf');
        expect(text).not.toContain(gone.path);
      },
    );
  },
);
