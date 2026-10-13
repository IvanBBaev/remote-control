import { DEFAULT_HOLD_SECONDS } from './agent-config.js';

/** The config file written on first `run`: an empty allow-list, the D10 defaults,
 * "Always" for the session only (D24) and turn notices off (M2-08). */
export function defaultConfigText(): string {
  const config = {
    repositories: [],
    hooks: { holdSeconds: DEFAULT_HOLD_SECONDS },
    agent: { onExpire: 'handoff' },
    always: { destinations: ['session'] },
    notifications: { turnFinished: false, needsInput: false },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}
