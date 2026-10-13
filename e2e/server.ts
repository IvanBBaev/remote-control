import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';

import {
  permissionRequestPayload,
  postToolUsePayload,
  preToolUsePayload,
  sessionStartPayload,
  stopPayload,
  userPromptSubmitPayload,
  writeAgentEntry,
} from '@remote-control/fake-claude-code';
import {
  createPhone,
  createRealClock,
  startAgent,
  startRelay,
  type HarnessAgent,
  type PairingRun,
} from '@remote-control/test-harness';

import { CONTROL_PORT, RELAY_PORT } from './ports.js';

/**
 * The e2e back end (M1-12, 07 §5.10): the harness relay on PGlite with wall time, serving
 * the built PWA on `http://localhost:<RELAY_PORT>` (the same origin as `/api` and `/ws`,
 * as in production), plus a test-only control API on `CONTROL_PORT` that mints invites,
 * drives harness agents and exposes the fake Web Push service. Specs talk to it through
 * `support/control.ts`; it never listens beyond loopback.
 */

const UNLIMITED = { max: 10_000, windowMs: 60_000 };

const clock = createRealClock();
const origin = `http://localhost:${String(RELAY_PORT)}`;
const relay = await startRelay({
  clock,
  rpId: 'localhost',
  origin,
  host: 'localhost',
  port: RELAY_PORT,
  publicDir: resolve(import.meta.dirname, '../apps/web/dist'),
  // Every spec registers its own account, all from 127.0.0.1.
  authLimits: { anyPerIp: UNLIMITED, registerPerIp: UNLIMITED, loginPerIp: UNLIMITED },
});

interface AgentEntry {
  readonly agent: HarnessAgent;
  pairing?: PairingRun;
}

const agents = new Map<string, AgentEntry>();
let nextAgent = 0;

/** The `rc-enroll:` token out of the command the pairing screen shows. */
function enrollToken(command: string): string {
  const token = /rc-enroll:\S+/.exec(command)?.[0];
  if (token === undefined) throw new Error(`no enrolment token in ${JSON.stringify(command)}`);
  return token;
}

function context(agent: HarnessAgent, sessionId: string) {
  return {
    sessionId,
    transcriptPath: join(agent.base, 'home', 'session.jsonl'),
    cwd: agent.repositories[0] ?? join(agent.base, 'repos'),
    permissionMode: 'default',
  };
}

type Body = Readonly<Record<string, unknown>>;

/** The hook events a spec can fire, built with the fake Claude Code's payloads. */
const HOOKS: Record<string, (agent: HarnessAgent, body: Body) => Record<string, unknown>> = {
  permission: (agent, body) =>
    permissionRequestPayload(context(agent, String(body['sessionId'])), {
      toolName: 'Bash',
      toolInput: { command: String(body['command']), description: 'Run a command' },
    }),
  question: (agent, body) =>
    preToolUsePayload(context(agent, String(body['sessionId'])), {
      toolName: 'AskUserQuestion',
      toolUseId: 'toolu_01E2eQuestion',
      toolInput: { questions: body['questions'] },
    }),
};

async function sessionTurn(agent: HarnessAgent, body: Body): Promise<void> {
  const sessionId = String(body['sessionId']);
  const ctx = { ...context(agent, sessionId), promptId: 'prompt_01' };
  writeAgentEntry(
    { HOME: join(agent.base, 'home') },
    {
      cwd: ctx.cwd,
      kind: 'background',
      startedAt: new Date(clock.now()).toISOString(),
      id: 'bg-e2e',
      state: 'working',
      pid: 4242,
      status: 'busy',
      sessionId,
      name: String(body['name']),
    },
  );
  await agent.fire(sessionStartPayload(ctx, 'startup'));
  await agent.fire(userPromptSubmitPayload(ctx, String(body['prompt'])));
  await agent.fire(
    postToolUsePayload(ctx, {
      toolName: 'Bash',
      toolInput: { command: 'npm run build', description: 'Build' },
      toolResponse: { stdout: 'built', stderr: '', interrupted: false, isImage: false },
      toolUseId: 'toolu_01',
      durationMs: 900,
    }),
  );
  await agent.fire(
    stopPayload(ctx, { stopHookActive: false, lastAssistantMessage: String(body['answer']) }),
  );
}

async function readBody(request: IncomingMessage): Promise<Body> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return text === '' ? {} : (JSON.parse(text) as Body);
}

function entry(id: string | undefined): AgentEntry {
  const found = id === undefined ? undefined : agents.get(id);
  if (found === undefined) throw new Error(`no agent ${String(id)}`);
  return found;
}

async function route(method: string, path: string, body: Body): Promise<unknown> {
  const [, resource, id, action] = path.split('/');
  if (method === 'POST' && resource === 'invite') return { code: await relay.mintInvite() };
  // An account registered with a software passkey, for engines without the CDP virtual
  // authenticator (WebKit): the spec signs in by setting the session cookie.
  if (method === 'POST' && resource === 'accounts') {
    const phone = await createPhone({ relay, clock, name: 'WebKit' });
    await phone.register(await relay.mintInvite());
    return { sessionCookie: phone.sessionCookie };
  }
  if (resource === 'push') {
    if (method === 'POST' && id === 'subscribe') return relay.push.subscribe();
    if (method === 'GET' && id === 'received') {
      return relay.push.received.map(({ endpoint, plaintext }) => ({ endpoint, plaintext }));
    }
  }
  if (resource !== 'agents') throw new Error(`unknown route ${method} ${path}`);
  if (method === 'POST' && id === undefined) {
    const agent = await startAgent({
      relayUrl: relay.wsOrigin,
      clock,
      name: String(body['name']),
      repositories: (body['repositories'] as string[] | undefined) ?? [],
      env: { FAKE_CLAUDE_SCENARIO: 'stop' },
    });
    const key = String(nextAgent++);
    agents.set(key, { agent });
    return { id: key };
  }
  const current = entry(id);
  const { agent } = current;
  switch (`${method} ${action ?? ''}`) {
    case 'POST login':
      await agent.login(enrollToken(String(body['command'])));
      return {};
    case 'POST pair':
      current.pairing = agent.pair();
      return { code: await current.pairing.code };
    case 'POST paired': {
      const exit = await current.pairing?.done;
      if (exit !== 0) throw new Error(`remotectl pair exited ${String(exit)}: ${agent.stderr()}`);
      return {};
    }
    case 'POST run':
      await agent.run();
      return {};
    case 'POST session':
      await sessionTurn(agent, body);
      return {};
    case 'POST fire': {
      const build = HOOKS[String(body['hook'])];
      if (build === undefined) throw new Error(`unknown hook ${String(body['hook'])}`);
      return agent.fire(build(agent, body));
    }
    case 'GET claude-runs':
      return agent.claudeRuns();
    case 'GET logs':
      return { lines: agent.logs(), stderr: agent.stderr(), relay: relay.logs().slice(-300) };
    case 'DELETE ':
      agents.delete(id!);
      await agent.close();
      return {};
    default:
      throw new Error(`unknown route ${method} ${path}`);
  }
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

const control = createServer((request, response) => {
  void readBody(request)
    .then((body) => route(request.method ?? 'GET', request.url ?? '/', body))
    .then(
      (value) => reply(response, 200, value ?? {}),
      (error: unknown) => reply(response, 500, { error: String(error) }),
    );
});
await new Promise<void>((done) => control.listen(CONTROL_PORT, '127.0.0.1', done));
process.stdout.write(`e2e: relay ${origin}, control http://127.0.0.1:${String(CONTROL_PORT)}\n`);

const shutdown = () => {
  control.close();
  void Promise.all([...agents.values()].map(({ agent }) => agent.close()))
    .then(() => relay.close())
    .finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
