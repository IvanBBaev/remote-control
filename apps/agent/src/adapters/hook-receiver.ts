import type { AddressInfo } from 'node:net';

import { bytesEqual } from '@remote-control/crypto';
import fastify from 'fastify';

import type { HookHandler, HookInput } from '../core/hook-dispatcher.js';
import type { AgentAdapterId } from '../ports/agent-adapter.js';

/** The receiver binds to IPv4 loopback only (D11, §1). */
export const HOOK_HOST = '127.0.0.1';
/** Header `hook.js` sends with its own timeout `T` in seconds. */
export const HOOK_TIMEOUT_HEADER = 'x-remotectl-hook-timeout';
/** Header `hook.js` sends with `--adapter <id>`; absent means `claude-code` (M2-01). */
export const HOOK_AGENT_HEADER = 'x-remotectl-agent';
/** The agents whose hooks the receiver accepts. */
const HOOK_AGENTS: readonly AgentAdapterId[] = ['claude-code', 'codex'];
/** Largest hook body accepted (tool inputs can carry whole files). */
export const HOOK_BODY_LIMIT = 8 * 1024 * 1024;
const MAX_HOOK_TIMEOUT_SECONDS = 86_400;

export interface HookReceiverOptions {
  /** 0 picks a free port. */
  readonly port: number;
  /** The bearer token `hook.js` reads from `agent.json`. */
  readonly token: string;
  readonly handler: HookHandler;
  /** Used when a request carries no valid timeout header. */
  readonly defaultHookTimeoutMs: number;
}

export interface HookReceiver {
  /** The bound port. */
  readonly port: number;
  close(): Promise<void>;
}

/** Thrown when the loopback port cannot be bound; the agent exits (D11). */
export class HookReceiverBindError extends Error {
  override readonly name = 'HookReceiverBindError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHookInput(value: unknown): value is HookInput {
  return (
    isRecord(value) &&
    typeof value['hook_event_name'] === 'string' &&
    typeof value['session_id'] === 'string'
  );
}

function hookTimeoutMs(header: string | string[] | undefined, fallback: number): number {
  if (typeof header !== 'string' || !/^\d+(?:\.\d+)?$/.test(header)) return fallback;
  const seconds = Number(header);
  if (!(seconds > 0) || seconds > MAX_HOOK_TIMEOUT_SECONDS) return fallback;
  return Math.round(seconds * 1000);
}

/** The agent named by the header, `claude-code` when absent, `undefined` when unknown. */
function hookAgent(header: string | string[] | undefined): AgentAdapterId | undefined {
  if (header === undefined) return 'claude-code';
  return HOOK_AGENTS.find((agent) => agent === header);
}

const encoder = new TextEncoder();

/**
 * The loopback endpoint `hook.js` posts to (D11, 04 §5.2). Checks, in order: no browser
 * `Origin` (a web page cannot reach it, even by DNS rebinding), `Host` is the loopback
 * address with our port, bearer token (constant-time compare). The routes are
 * `POST /hook` and `GET /health` (the `remotectl status` probe, M1-07); there is no decide
 * route — decisions enter through the relay channel (I1).
 */
export async function startHookReceiver(options: HookReceiverOptions): Promise<HookReceiver> {
  const app = fastify({
    logger: false,
    bodyLimit: HOOK_BODY_LIMIT,
    // A blocking request is held for up to `T − 10 s`.
    requestTimeout: 0,
    connectionTimeout: 0,
    forceCloseConnections: true,
  });
  const expectedToken = encoder.encode(options.token);
  let boundPort = options.port;

  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.origin !== undefined) {
      return reply.code(403).send({ error: 'origin_rejected' });
    }
    const host = request.headers.host;
    if (host !== `${HOOK_HOST}:${boundPort}` && host !== `localhost:${boundPort}`) {
      return reply.code(403).send({ error: 'host_rejected' });
    }
    const authorization = request.headers.authorization ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!bytesEqual(encoder.encode(token), expectedToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return undefined;
  });

  app.get('/health', async (_request, reply) => reply.code(204).send());

  app.post('/hook', async (request, reply) => {
    if (!isHookInput(request.body)) {
      return reply.code(400).send({ error: 'invalid_hook_input' });
    }
    const agent = hookAgent(request.headers[HOOK_AGENT_HEADER]);
    if (agent === undefined) return reply.code(400).send({ error: 'unknown_agent' });
    const controller = new AbortController();
    const onClose = (): void => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    reply.raw.once('close', onClose);
    const result = await options.handler(request.body, {
      hookTimeoutMs: hookTimeoutMs(
        request.headers[HOOK_TIMEOUT_HEADER],
        options.defaultHookTimeoutMs,
      ),
      signal: controller.signal,
      agent,
    });
    if (result.status === 204) return reply.code(204).send();
    return reply.code(200).type('application/json').send(JSON.stringify(result.body));
  });

  try {
    await app.listen({ host: HOOK_HOST, port: options.port });
  } catch (error) {
    await app.close();
    throw new HookReceiverBindError(
      `cannot listen on ${HOOK_HOST}:${options.port}: ${(error as Error).message}`,
    );
  }
  boundPort = (app.server.address() as AddressInfo).port;
  return {
    port: boundPort,
    close: () => app.close(),
  };
}
