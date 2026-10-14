import {
  postToolUsePayload,
  seededRandom,
  stopPayload,
  TranscriptWriter,
  transcriptPath,
  writeAgentEntry,
} from '@remote-control/fake-claude-code';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCanaries } from '../canaries.js';
import { eventually } from '../eventually.js';
import { scenario, type Scenario } from '../scenario.js';
import { JOURNEY } from './fixtures.js';

/** A session that ran before the agent started watching it. */
const SESSION_ID = '7c1e3a5b-9d2f-4b6a-8e0c-4a2c6e8b0d1f';
/** The agent's roster poll (04 §5.3), on the fake clock. */
const ROSTER_POLL_MS = 10_000;

describe.skipIf(process.platform === 'win32')(
  'J8 — a session the agent first sees is rebuilt from its transcript (M3, 04 W11)',
  () => {
    let running: Scenario | undefined;
    afterEach(async () => {
      await running?.close();
      running = undefined;
    });

    it(
      'shows the turn so far from the transcript, without the live step twice',
      JOURNEY,
      async () => {
        running = await scenario({
          canaries: createCanaries('CANARY'),
          repositories: ['app'],
          env: { FAKE_CLAUDE_SCENARIO: 'stop' },
          config: { transcripts: { backfill: true } },
        });
        const { phone, agent, clock, canaries } = running;
        const [root] = agent.repositories;
        const home = join(agent.base, 'home');
        const path = transcriptPath({ HOME: home }, root!, SESSION_ID);
        const ctx = {
          sessionId: SESSION_ID,
          transcriptPath: path,
          cwd: root!,
          permissionMode: 'default',
          promptId: 'prompt_02',
        };

        // The history: a finished turn, then the current one up to its first command.
        const earlier = `Add a test ${canaries.mint('EARLIER')}`;
        const prompt = `Fix the build ${canaries.mint('PROMPT')}`;
        const output = canaries.mint('OUTPUT');
        const transcript = new TranscriptWriter({
          path,
          clock,
          random: seededRandom(7),
          sessionId: SESSION_ID,
          cwd: root!,
        });
        transcript.user(earlier);
        transcript.assistantText(`Added it. ${canaries.mint('ANSWER')}`);
        transcript.user(prompt);
        transcript.toolUse('toolu_01', 'Bash', { command: 'npm run build' });
        transcript.toolResult('toolu_01', output, false);
        transcript.toolUse('toolu_02', 'Bash', { command: 'npm test' });
        transcript.toolResult('toolu_02', canaries.mint('TESTS'), false);

        writeAgentEntry(
          { HOME: home },
          {
            cwd: root!,
            kind: 'background',
            startedAt: new Date(clock.now()).toISOString(),
            id: 'bg-1',
            state: 'working',
            pid: 4242,
            status: 'busy',
            sessionId: SESSION_ID,
            name: 'rc-app-0000back',
          },
        );
        // The first hook the agent sees is a step the transcript already holds; the
        // transcript also holds the next one, whose hook comes later.
        await agent.fire(
          postToolUsePayload(ctx, {
            toolName: 'Bash',
            toolInput: { command: 'npm run build' },
            toolResponse: { stdout: output, stderr: '', interrupted: false, isImage: false },
            toolUseId: 'toolu_01',
            durationMs: 900,
          }),
        );
        clock.advance(ROSTER_POLL_MS);
        await eventually(
          () =>
            phone
              .of('snapshot')
              .some((snapshot) =>
                snapshot.sessions.some(
                  (session) => session.id === SESSION_ID && session.lastPrompt === prompt,
                ),
              ),
          'phone: the session was never rebuilt from its transcript',
        );
        const rebuilt = phone
          .of('snapshot')
          .at(-1)!
          .sessions.find((session) => session.id === SESSION_ID);
        const steps = ['Run a command: npm run build', 'Run a command: npm test'];
        expect(rebuilt).toMatchObject({ lastPrompt: prompt, lastAnswer: null, steps, feedSeq: 2 });

        // The later hook for the step already shown is not streamed again; the next is.
        await agent.fire(
          postToolUsePayload(ctx, {
            toolName: 'Bash',
            toolInput: { command: 'npm test' },
            toolResponse: { stdout: 'ok', stderr: '', interrupted: false, isImage: false },
            toolUseId: 'toolu_02',
            durationMs: 900,
          }),
        );
        const answer = `The build passes now. ${canaries.mint('ANSWER')}`;
        await agent.fire(stopPayload(ctx, { stopHookActive: false, lastAssistantMessage: answer }));
        await eventually(
          () => phone.of('event').some((event) => event.event.kind === 'stop'),
          'phone: no answer',
        );
        expect(phone.of('event').map((event) => [event.seq, event.event.kind])).toEqual([
          [1, 'tool'],
          [3, 'stop'],
        ]);
        phone.disconnect();
        const before = phone.of('snapshot').length;
        await phone.connect();
        await phone.handshake(running.agentDeviceId, running.agentPublicKey);
        await eventually(() => phone.of('snapshot').length > before, 'phone: no snapshot');
        expect(
          phone
            .of('snapshot')
            .at(-1)!
            .sessions.find((session) => session.id === SESSION_ID),
        ).toMatchObject({ lastPrompt: prompt, lastAnswer: answer, steps, feedSeq: 3 });

        // The transcript stayed on the computer: sealed to the phone, and the agent logs
        // only counts (I1, I3).
        await running.assertNoLeaks();
      },
    );
  },
);
