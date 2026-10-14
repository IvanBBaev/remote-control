import { encodeAnswerPayload } from '@remote-control/protocol';
import { DEFAULT_HOLD_SECONDS, type AgentSdk, type SdkQueryOptions } from 'remotectl';
import { afterEach, describe, expect, it } from 'vitest';

import { createCanaries } from '../canaries.js';
import { scenario, type Scenario } from '../scenario.js';
import {
  decisionResult,
  JOURNEY,
  lastSnapshot,
  logEvents,
  nextQuestion,
  nextRequest,
  questionRequest,
} from './fixtures.js';

/** A placeholder, never a real key: the SDK stand-in reads nothing from it. */
const API_KEY = 'test-key';
const SDK_SESSION_ID = '5d1e9c62-0b7a-4f0e-9d2c-3c1b7f4a8e21';

interface SdkRun {
  readonly options: SdkQueryOptions;
  readonly prompts: string[];
}

/**
 * The Agent SDK as an API-key user's session sees it: `init` with the environment's key on
 * the first turn, then a `result` per turn until the agent ends the input.
 */
function agentSdkStandIn(apiKeySource = 'ANTHROPIC_API_KEY'): {
  sdk: AgentSdk;
  runs: SdkRun[];
} {
  const runs: SdkRun[] = [];
  const sdk: AgentSdk = {
    query({ prompt, options }) {
      const run: SdkRun = { options, prompts: [] };
      runs.push(run);
      return {
        close: () => {},
        async *[Symbol.asyncIterator]() {
          let first = true;
          for await (const message of prompt) {
            run.prompts.push(message.message.content);
            if (first) {
              first = false;
              yield { type: 'system', subtype: 'init', apiKeySource, session_id: SDK_SESSION_ID };
            }
            yield { type: 'result', subtype: 'success', session_id: SDK_SESSION_ID };
          }
        },
      };
    },
  };
  return { sdk, runs };
}

const signal = new AbortController().signal;

describe('J2 — Claude Code sessions through the Agent SDK for API-key users (04 W15)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it(
    'starts the session through the SDK and answers its permissions and questions from the phone',
    JOURNEY,
    async () => {
      const { sdk, runs } = agentSdkStandIn();
      running = await scenario({
        canaries: createCanaries('CANARY'),
        repositories: ['app'],
        env: { ANTHROPIC_API_KEY: API_KEY },
        agentSdk: sdk,
      });
      const { phone, agent, clock, canaries } = running;
      const [root] = agent.repositories;
      const repository = (await lastSnapshot(phone)).repositories![0]!;

      const prompt = `Fix the build ${canaries.mint('PROMPT')}`;
      const started = await phone.start(
        { machineId: repository.machineId, repositoryId: repository.id, prompt },
        repository.path,
      );
      expect(await decisionResult(phone, started)).toMatchObject({ result: 'accepted' });
      // The SDK runs the session; no `claude` process was spawned for it.
      expect(runs).toHaveLength(1);
      const [run] = runs;
      expect(run!.prompts).toEqual([prompt]);
      expect(run!.options).toMatchObject({ cwd: root, settingSources: ['project', 'local'] });
      expect((await agent.claudeRuns()).filter((entry) => entry.argv[0] === '--bg')).toEqual([]);
      expect(logEvents(agent.logs(), 'launch_started')).toEqual([
        expect.objectContaining({ session_id: SDK_SESSION_ID }),
      ]);
      const { canUseTool, hooks } = run!.options;

      // Allow: the SDK runs the tool with the input it asked about.
      const allowed = canUseTool('Bash', { command: `ls ${canaries.mint('COMMAND')}` }, { signal });
      const { request: first } = await nextRequest(phone);
      expect(first).toMatchObject({ sessionId: SDK_SESSION_ID });
      await phone.decide('allow', first);
      expect(await allowed).toEqual({ behavior: 'allow' });

      // Deny.
      const denied = canUseTool('Bash', { command: `rm ${canaries.mint('COMMAND')}` }, { signal });
      const { request: second } = await nextRequest(phone, 2);
      await phone.decide('deny', second);
      expect(await denied).toEqual({ behavior: 'deny', message: 'Denied from phone' });

      // AskUserQuestion: held by the SDK `PreToolUse` hook, answered with the hook's output.
      const input = { ...questionRequest(canaries), session_id: SDK_SESSION_ID, cwd: root };
      const asked = hooks['PreToolUse']![0]!.hooks[0]!(input, 'toolu_01Sdk', { signal });
      const { question } = await nextQuestion(phone);
      await phone.decide(
        'answer',
        question,
        encodeAnswerPayload({
          answers: question.questions.map((entry) => ({ labels: [entry.options[0]!.label] })),
        }),
      );
      expect(await decisionResult(phone, question.id)).toMatchObject({ result: 'accepted' });
      expect(await asked).toMatchObject({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      });

      // Nobody answers: there is no terminal to hand off to, so the SDK gets a deny.
      const unanswered = canUseTool('Bash', { command: 'make' }, { signal });
      await nextRequest(phone, 3);
      clock.advance((DEFAULT_HOLD_SECONDS - 10) * 1000);
      expect(await unanswered).toEqual({ behavior: 'deny', message: 'No decision from phone' });

      // The SDK path keeps I1/I3: prompts, commands and answers stay sealed.
      await running.assertNoLeaks();
    },
  );

  it(
    'refuses a session that runs on a claude.ai login instead of the key (SDK-O)',
    JOURNEY,
    async () => {
      const { sdk, runs } = agentSdkStandIn('/login managed key');
      running = await scenario({
        repositories: ['app'],
        env: { ANTHROPIC_API_KEY: API_KEY },
        agentSdk: sdk,
      });
      const { phone, agent } = running;
      const repository = (await lastSnapshot(phone)).repositories![0]!;
      const started = await phone.start(
        { machineId: repository.machineId, repositoryId: repository.id, prompt: 'Go' },
        repository.path,
      );
      expect(await decisionResult(phone, started)).toMatchObject({ result: 'rejected' });
      expect(runs).toHaveLength(1);
      expect(logEvents(agent.logs(), 'sdk_auth_refused')).toEqual([
        expect.objectContaining({ api_key_source: '/login managed key' }),
      ]);
    },
  );

  it('starts nothing without ANTHROPIC_API_KEY', JOURNEY, async () => {
    const { sdk, runs } = agentSdkStandIn();
    running = await scenario({ repositories: ['app'], agentSdk: sdk });
    const { phone, agent } = running;
    const repository = (await lastSnapshot(phone)).repositories![0]!;
    const started = await phone.start(
      { machineId: repository.machineId, repositoryId: repository.id, prompt: 'Go' },
      repository.path,
    );
    expect(await decisionResult(phone, started)).toMatchObject({ result: 'rejected' });
    expect(runs).toHaveLength(0);
    expect(logEvents(agent.logs(), 'sdk_no_api_key')).toHaveLength(1);
  });
});
