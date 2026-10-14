import type { AgentSdk, SdkQueryOptions } from '../../ports/agent-sdk.js';

/**
 * The SDK package, an optional peer (ADR 0015): installed next to `remotectl` only by
 * API-key users who set `agent.sessions` to `"sdk"`.
 */
export const AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

type SdkModule = {
  readonly query: (params: {
    readonly prompt: unknown;
    readonly options: SdkQueryOptions & {
      readonly env: Readonly<Record<string, string | undefined>>;
    };
  }) => ReturnType<AgentSdk['query']>;
};

function isSdkModule(value: unknown): value is SdkModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { query?: unknown }).query === 'function'
  );
}

/** The literal import, kept out of the bundle (`--external`) and resolved at run time. */
export const importAgentSdk = (): Promise<unknown> => import('@anthropic-ai/claude-agent-sdk');

/**
 * Imports the SDK on first use; `undefined` when it is not installed or is not the SDK.
 * Every query gets `env` (the agent's environment, where `ANTHROPIC_API_KEY` lives): the
 * key is never read from or written to a config file.
 */
export async function loadAgentSdk(
  env: Readonly<Record<string, string | undefined>>,
  load: () => Promise<unknown> = importAgentSdk,
): Promise<AgentSdk | undefined> {
  let module: unknown;
  try {
    module = await load();
  } catch {
    return undefined;
  }
  if (!isSdkModule(module)) return undefined;
  const sdk = module;
  return {
    query: ({ prompt, options }) => sdk.query({ prompt, options: { ...options, env } }),
  };
}
