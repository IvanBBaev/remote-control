import {
  postToolUsePayload,
  sessionStartPayload,
  stopPayload,
  userPromptSubmitPayload,
  writeAgentEntry,
} from '@remote-control/fake-claude-code';
import { applyFeedEvent, MAX_MESSAGE_BYTES, messageBytes } from '@remote-control/protocol';
import type { Session } from '@remote-control/protocol';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCanaries } from '../canaries.js';
import { eventually } from '../eventually.js';
import { scenario, type Scenario } from '../scenario.js';
import { JOURNEY } from './fixtures.js';

/** A background session running in the repository. */
const SESSION_ID = '3b5d7f9a-1c2e-4a6b-8d0f-2e4a6c8e0b1d';
/** The agent's roster poll (04 §5.3), on the fake clock. */
const ROSTER_POLL_MS = 10_000;

describe.skipIf(process.platform === 'win32')(
  'J8 — sessions list and the live feed of a session (M1-05)',
  () => {
    let running: Scenario | undefined;
    afterEach(async () => {
      await running?.close();
      running = undefined;
    });

    it(
      'lists the session, streams prompt, steps, changed files and the answer, and resyncs on reconnect',
      JOURNEY,
      async () => {
        running = await scenario({
          canaries: createCanaries('CANARY'),
          repositories: ['app'],
          env: { FAKE_CLAUDE_SCENARIO: 'stop' },
        });
        const { phone, agent, clock, canaries } = running;
        const [root] = agent.repositories;
        const ctx = {
          sessionId: SESSION_ID,
          transcriptPath: join(agent.base, 'home', 'session.jsonl'),
          cwd: root!,
          permissionMode: 'default',
          promptId: 'prompt_01',
        };

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
            name: 'rc-app-0000feed',
          },
        );
        await agent.fire(sessionStartPayload(ctx, 'startup'));
        clock.advance(ROSTER_POLL_MS);
        await eventually(
          () =>
            phone
              .of('snapshot')
              .some((snapshot) =>
                snapshot.sessions.some((session) => session.id === SESSION_ID && session.followUp),
              ),
          'phone: the session was never listed',
        );
        // The sessions list: the session under this computer, with its state.
        const listed = phone
          .of('snapshot')
          .at(-1)!
          .sessions.find((session) => session.id === SESSION_ID)!;
        expect(listed).toMatchObject({
          machineId: running.agentDeviceId,
          name: 'rc-app-0000feed',
          state: 'working',
          followUp: true,
          steps: [],
        });

        // One turn: the prompt, a command, an edit and the answer.
        const prompt = `Fix the build ${canaries.mint('PROMPT')}`;
        const output = canaries.mint('OUTPUT');
        const body = canaries.mint('FILEBODY');
        const answer = `The build passes now. ${canaries.mint('ANSWER')}`;
        await agent.fire(userPromptSubmitPayload(ctx, prompt));
        await agent.fire(
          postToolUsePayload(ctx, {
            toolName: 'Bash',
            toolInput: { command: 'npm run build', description: 'Build' },
            toolResponse: { stdout: output, stderr: '', interrupted: false, isImage: false },
            toolUseId: 'toolu_01',
            durationMs: 900,
          }),
        );
        await agent.fire(
          postToolUsePayload(ctx, {
            toolName: 'Edit',
            toolInput: {
              file_path: join(root!, 'src', 'build.ts'),
              old_string: 'a\nb',
              new_string: 'a\nc\nd',
            },
            toolResponse: { filePath: join(root!, 'src', 'build.ts'), originalFile: body },
            toolUseId: 'toolu_02',
            durationMs: 5,
          }),
        );
        await agent.fire(stopPayload(ctx, { stopHookActive: false, lastAssistantMessage: answer }));

        await eventually(() => phone.of('event').length >= 4, 'phone: no live feed events');
        const events = phone.of('event');
        expect(events.map((event) => [event.sessionId, event.seq, event.event.kind])).toEqual([
          [SESSION_ID, 1, 'prompt'],
          [SESSION_ID, 2, 'tool'],
          [SESSION_ID, 3, 'tool'],
          [SESSION_ID, 4, 'stop'],
        ]);
        // The phone's view, as the PWA folds the events into the listed session.
        let view: Session = listed;
        for (const event of events) view = applyFeedEvent(view, event.event);
        const expected = {
          lastPrompt: prompt,
          steps: ['Run a command: npm run build', 'Edit a file: src/build.ts'],
          changedFiles: [{ name: join(root!, 'src', 'build.ts'), added: 2, removed: 1 }],
          lastAnswer: answer,
        };
        expect(view).toMatchObject(expected);
        expect(events[1]!.event).toMatchObject({ response: output });
        // No diff bodies (D21): the edit's file contents never leave the computer.
        expect(JSON.stringify(phone.messages.map((received) => received.message))).not.toContain(
          body,
        );
        for (const event of events)
          expect(messageBytes(event)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);

        // A phone that reconnects gets the content in the snapshot, with the events it holds.
        phone.disconnect();
        const before = phone.of('snapshot').length;
        await phone.connect();
        await phone.handshake(running.agentDeviceId, running.agentPublicKey);
        await eventually(() => phone.of('snapshot').length > before, 'phone: no snapshot');
        const resynced = phone
          .of('snapshot')
          .at(-1)!
          .sessions.find((session) => session.id === SESSION_ID);
        expect(resynced).toMatchObject({ ...expected, feedSeq: 4 });

        // Prompts, outputs and answers reached the phone sealed: not in the relay's logs,
        // database or pushes, nor in the agent's own log (I1, I3).
        await running.assertNoLeaks();
      },
    );
  },
);
