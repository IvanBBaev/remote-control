import { request } from 'node:http';

/**
 * The logic of `hook.cjs`, the command Claude Code runs for every hook event (D11).
 * Contract: it never fails. Any problem — agent down, wrong token, bad answer, its own
 * deadline — ends with empty stdout and exit 0, so Claude Code shows its own prompt
 * (D10 handoff). Only Node builtins; it is bundled to one CommonJS file.
 */

/** Default `T` when argv carries none: Claude Code's default command-hook timeout. */
export const DEFAULT_HOOK_TIMEOUT_SECONDS = 600;
/** The hook gives up `T − 5 s` after start (D10), leaving Claude Code time to read it. */
export const HOOK_MARGIN_MS = 5_000;
/** Largest response printed; anything bigger is not a hook answer. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_HOOK_TIMEOUT_SECONDS = 86_400;

export interface HookDeps {
  /**
   * Arguments after the script: `[T]`, the installed timeout in seconds, optionally
   * followed by `--adapter <id>` for an agent other than Claude Code (M2-01).
   */
  readonly argv: readonly string[];
  /** The hook input (Claude Code writes it to stdin). */
  readStdin(): Promise<string>;
  /** The text of `agent.json`. */
  readEndpoint(): Promise<string>;
  /** Writes to stdout and resolves once flushed. */
  write(text: string): Promise<void>;
}

interface Endpoint {
  readonly port: number;
  readonly token: string;
}

/** `T` from argv, in seconds; fractions are accepted (tests), garbage falls back. */
export function hookTimeoutSeconds(argv: readonly string[]): number {
  const raw = argv[0];
  if (raw === undefined || !/^\d+(?:\.\d+)?$/.test(raw)) return DEFAULT_HOOK_TIMEOUT_SECONDS;
  const seconds = Number(raw);
  return seconds > 0 && seconds <= MAX_HOOK_TIMEOUT_SECONDS
    ? seconds
    : DEFAULT_HOOK_TIMEOUT_SECONDS;
}

/** `--adapter <id>` from argv, or `undefined` (Claude Code); a malformed id is ignored. */
export function hookAdapter(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--adapter');
  const id = index === -1 ? undefined : argv[index + 1];
  return id !== undefined && /^[a-z][a-z0-9-]{0,31}$/.test(id) ? id : undefined;
}

/** The hook's own budget: `T − 5 s`, or half of `T` for very short timeouts. */
export function hookBudgetMs(seconds: number): number {
  const total = seconds * 1000;
  return total - Math.min(HOOK_MARGIN_MS, total / 2);
}

function parseEndpoint(text: string): Endpoint | undefined {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null) return undefined;
  const { port, token } = value as Record<string, unknown>;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  if (typeof token !== 'string' || token.length === 0) return undefined;
  return { port, token };
}

function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** POSTs the input; resolves with the body of a 200 answer, otherwise `undefined`. */
function post(
  endpoint: Endpoint,
  body: string,
  seconds: number,
  adapter: string | undefined,
  signal: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: endpoint.port,
        path: '/hook',
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-remotectl-hook-timeout': String(seconds),
          ...(adapter === undefined ? {} : { 'x-remotectl-agent': adapter }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy();
            resolve(undefined);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve(res.statusCode === 200 ? Buffer.concat(chunks).toString('utf8') : undefined);
        });
        res.on('error', () => resolve(undefined));
      },
    );
    req.on('error', () => resolve(undefined));
    req.end(body);
  });
}

async function exchange(
  deps: HookDeps,
  seconds: number,
  signal: AbortSignal,
): Promise<string | undefined> {
  const input = await deps.readStdin();
  const endpoint = parseEndpoint(await deps.readEndpoint());
  if (endpoint === undefined || signal.aborted) return undefined;
  const answer = await post(endpoint, input, seconds, hookAdapter(deps.argv), signal);
  return answer !== undefined && isJsonObject(answer) ? answer : undefined;
}

/**
 * Reads the hook input, posts it to the agent and prints the agent's JSON verbatim.
 * Resolves (never rejects) once stdout is written; the caller exits with 0.
 */
export async function runHook(deps: HookDeps): Promise<void> {
  const seconds = hookTimeoutSeconds(deps.argv);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, hookBudgetMs(seconds));
  });
  let answer: string | undefined;
  try {
    answer = await Promise.race([exchange(deps, seconds, controller.signal), deadline]);
  } catch {
    answer = undefined;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  if (answer === undefined) return;
  try {
    await deps.write(answer);
  } catch {
    // stdout is gone; nothing left to do.
  }
}
