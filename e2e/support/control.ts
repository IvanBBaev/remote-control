import { CONTROL_PORT } from '../ports.js';

/** What `fire` returns: the hook's stdout, as Claude Code would read it. */
export interface HookResult {
  readonly stdout: string;
  readonly output: Readonly<Record<string, unknown>> | undefined;
}

export interface PushTarget {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface ReceivedPush {
  readonly endpoint: string;
  readonly plaintext: string | null;
}

export interface ClaudeRun {
  readonly cwd: string;
  readonly argv: readonly string[];
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${String(CONTROL_PORT)}${path}`, {
    method,
    ...(body !== undefined && {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(`control ${method} ${path}: ${String(value.error)}`);
  return value;
}

/** A harness agent (the real `remotectl` on a temp HOME) driven through `server.ts`. */
export interface ControlAgent {
  readonly id: string;
  /** `remotectl login`, with the command the pairing screen shows. */
  login(command: string): Promise<void>;
  /** Starts `remotectl pair`; resolves with the code it prints. */
  pair(): Promise<string>;
  /** Waits for `remotectl pair` to exit 0. */
  paired(): Promise<void>;
  run(): Promise<void>;
  /** Fires one hook event; resolves when the hook answers (a decision or fall-through). */
  fire(
    hook: 'permission' | 'question',
    body: Readonly<Record<string, unknown>>,
  ): Promise<HookResult>;
  /** SessionStart, a prompt, one command and the answer, in a background session. */
  session(body: { sessionId: string; name: string; prompt: string; answer: string }): Promise<void>;
  claudeRuns(): Promise<ClaudeRun[]>;
  /** The daemon's log lines (JSON), the CLI's stderr and the shared relay's latest lines. */
  logs(): Promise<{ lines: string[]; stderr: string; relay: string[] }>;
  close(): Promise<void>;
}

export const control = {
  mintInvite: async () => (await call<{ code: string }>('POST', '/invite')).code,
  /** Registers an account with a software passkey; resolves with its session cookie. */
  createAccount: async () =>
    (await call<{ sessionCookie: string }>('POST', '/accounts')).sessionCookie,
  subscribePush: () => call<PushTarget>('POST', '/push/subscribe'),
  receivedPushes: () => call<ReceivedPush[]>('GET', '/push/received'),
  async startAgent(name: string, repositories: readonly string[] = []): Promise<ControlAgent> {
    const { id } = await call<{ id: string }>('POST', '/agents', { name, repositories });
    const at = `/agents/${id}`;
    return {
      id,
      login: (command) => call('POST', `${at}/login`, { command }),
      pair: async () => (await call<{ code: string }>('POST', `${at}/pair`)).code,
      paired: () => call('POST', `${at}/paired`),
      run: () => call('POST', `${at}/run`),
      fire: (hook, body) => call('POST', `${at}/fire`, { ...body, hook }),
      session: (body) => call('POST', `${at}/session`, body),
      claudeRuns: () => call('GET', `${at}/claude-runs`),
      logs: () => call('GET', `${at}/logs`),
      close: () => call('DELETE', at),
    };
  },
};
