import { DEFAULT_HOLD_SECONDS } from './agent-config.js';

/** The config file written on first `run`: an empty allow-list and the D10 defaults. */
export function defaultConfigText(): string {
  const config = {
    repositories: [],
    hooks: { holdSeconds: DEFAULT_HOLD_SECONDS },
    agent: { onExpire: 'handoff' },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}
