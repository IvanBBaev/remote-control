import { writeAgentEntry, sessionStartPayload } from '@remote-control/fake-claude-code';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCanaries } from '../canaries.js';
import { eventually } from '../eventually.js';
import { scenario, type Scenario } from '../scenario.js';
import { decisionResult, JOURNEY, logEvents } from './fixtures.js';

/** A background session already running in the repository (started earlier). */
const SESSION_ID = '7a1c3e5f-2b4d-4f6a-8c0e-1d3f5a7b9c2e';
const UNKNOWN_SESSION_ID = '0e9d8c7b-6a5f-4e3d-9c2b-1a0f9e8d7c6b';
/** The agent's roster poll (04 §5.3), on the fake clock. */
const ROSTER_POLL_MS = 10_000;

describe.skipIf(process.platform === 'win32')(
  'J9 — a follow-up instruction to a background session (M1-04)',
  () => {
    let running: Scenario | undefined;
    afterEach(async () => {
      await running?.close();
      running = undefined;
    });

    it(
      'sends `claude --resume <uuid> --bg <text>` in the session folder and refuses an unknown session',
      JOURNEY,
      async () => {
        running = await scenario({
          canaries: createCanaries('CANARY'),
          repositories: ['app'],
          env: { FAKE_CLAUDE_SCENARIO: 'stop' },
        });
        const { phone, agent, clock, canaries } = running;
        const [root] = agent.repositories;

        // A live background session: in the roster, and its hooks reach the agent.
        writeAgentEntry(
          { HOME: join(agent.base, 'home') },
          {
            cwd: root!,
            kind: 'background',
            startedAt: new Date(clock.now()).toISOString(),
            id: 'bg-1',
            state: 'working',
            pid: 4242,
            status: 'busy',
            sessionId: SESSION_ID,
            name: 'rc-app-0000beef',
          },
        );
        await agent.fire(
          sessionStartPayload(
            {
              sessionId: SESSION_ID,
              transcriptPath: join(agent.base, 'home', 'session.jsonl'),
              cwd: root!,
              permissionMode: 'default',
            },
            'startup',
          ),
        );
        // The next roster read tells the agent it is a background session.
        clock.advance(ROSTER_POLL_MS);
        await eventually(
          () =>
            phone
              .of('snapshot')
              .some((snapshot) =>
                snapshot.sessions.some((session) => session.id === SESSION_ID && session.followUp),
              ),
          'phone: the session never offered a follow-up',
        );

        const text = `Now add a test ${canaries.mint('INSTRUCTION')}`;
        const requestId = await phone.instruct(SESSION_ID, text);
        expect(await decisionResult(phone, requestId)).toMatchObject({
          result: 'accepted',
          sessionId: SESSION_ID,
        });
        const resumes = (await agent.claudeRuns()).filter((run) => run.argv[0] === '--resume');
        expect(resumes).toEqual([{ cwd: root, argv: ['--resume', SESSION_ID, '--bg', text] }]);

        // A session the agent does not know takes no follow-up, and nothing runs.
        const refused = await phone.instruct(UNKNOWN_SESSION_ID, 'hello');
        expect(await decisionResult(phone, refused)).toMatchObject({
          result: 'rejected',
          reason: 'follow_up_unsupported',
        });
        expect((await agent.claudeRuns()).filter((run) => run.argv[0] === '--resume')).toHaveLength(
          1,
        );
        expect(logEvents(agent.logs(), 'instruct_sent')).toHaveLength(1);

        await running.assertNoLeaks();
      },
    );
  },
);
