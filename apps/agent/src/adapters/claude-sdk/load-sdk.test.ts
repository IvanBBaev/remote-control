import { describe, expect, it } from 'vitest';

import { AGENT_SDK_PACKAGE, loadAgentSdk } from './load-sdk.js';

describe('loadAgentSdk', () => {
  it('names the optional peer package', () => {
    expect(AGENT_SDK_PACKAGE).toBe('@anthropic-ai/claude-agent-sdk');
  });

  it('is undefined when the package is not installed', async () => {
    const missing = () => Promise.reject(new Error('Cannot find package'));
    expect(await loadAgentSdk({}, missing)).toBeUndefined();
  });

  it('is undefined when the module has no query function', async () => {
    expect(await loadAgentSdk({}, () => Promise.resolve({ default: {} }))).toBeUndefined();
  });

  it('passes the agent environment to every query', async () => {
    const sdk = await loadAgentSdk({ ANTHROPIC_API_KEY: 'test-key' }, () =>
      Promise.resolve({ query: (params: unknown) => params }),
    );
    const params = sdk!.query({
      prompt: (async function* () {})(),
      options: {
        cwd: '/w',
        canUseTool: () => Promise.resolve({ behavior: 'allow' as const }),
        hooks: {},
        settingSources: [],
      },
    }) as unknown as { options: Record<string, unknown> };
    expect(params.options).toMatchObject({ cwd: '/w', env: { ANTHROPIC_API_KEY: 'test-key' } });
  });
});
