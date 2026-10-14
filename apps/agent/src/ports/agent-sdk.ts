import type { PermissionMode } from '@remote-control/protocol';

/**
 * The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, 04 §2.9) reduced to what SDK
 * sessions use (04 W15, ADR 0015). Structural on purpose: the package is an optional peer
 * that the agent loads only when `agent.sessions` is `"sdk"`, so nothing else imports its
 * types.
 */

/** A user turn sent into a streaming-input query. */
export interface SdkUserMessage {
  readonly type: 'user';
  readonly message: { readonly role: 'user'; readonly content: string };
  readonly parent_tool_use_id: null;
  readonly session_id: string;
}

/**
 * One message out of a query. Only `system`/`init` (the session id and `apiKeySource`)
 * and `result` (end of a turn) are read; everything else is skipped.
 */
export interface SdkMessage {
  readonly type: string;
  readonly subtype?: string;
  readonly session_id?: string;
  readonly apiKeySource?: string;
  readonly [field: string]: unknown;
}

/**
 * `canUseTool`'s answer (04 §2.9). An allow never rewrites the tool input: the SDK then
 * runs the tool with the input it asked about.
 */
export type SdkPermissionResult =
  | { readonly behavior: 'allow'; readonly updatedPermissions?: readonly unknown[] }
  | { readonly behavior: 'deny'; readonly message: string };

export interface SdkPermissionOptions {
  readonly signal: AbortSignal;
  readonly suggestions?: readonly unknown[];
  /** The SDK forbids a persistent "don't ask again" rule for this ask. */
  readonly suppressAlwaysAllowRule?: boolean;
}

export type SdkCanUseTool = (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  options: SdkPermissionOptions,
) => Promise<SdkPermissionResult>;

/** A hook callback: the input and the output have the shapes of the CLI hook's JSON. */
export type SdkHookCallback = (
  input: Readonly<Record<string, unknown>>,
  toolUseId: string | undefined,
  options: { readonly signal: AbortSignal },
) => Promise<Readonly<Record<string, unknown>>>;

export interface SdkHookMatcher {
  readonly matcher?: string;
  readonly hooks: readonly SdkHookCallback[];
  /** Seconds, as in a settings-file hook. */
  readonly timeout: number;
}

export interface SdkQueryOptions {
  readonly cwd: string;
  readonly permissionMode?: PermissionMode;
  readonly canUseTool: SdkCanUseTool;
  readonly hooks: Readonly<Record<string, readonly SdkHookMatcher[]>>;
  /** Which settings files the session reads; never `user` (ADR 0015). */
  readonly settingSources: readonly ('project' | 'local')[];
  /** A session to continue (a follow-up after its live query ended). */
  readonly resume?: string;
}

/** A running query: the message stream, closed when the agent stops. */
export interface SdkQuery extends AsyncIterable<SdkMessage> {
  close(): void;
}

export interface AgentSdk {
  query(params: {
    readonly prompt: AsyncIterable<SdkUserMessage>;
    readonly options: SdkQueryOptions;
  }): SdkQuery;
}
