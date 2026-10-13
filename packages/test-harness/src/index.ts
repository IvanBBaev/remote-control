export const packageName = '@remote-control/test-harness';

export { startAgent } from './agent.js';
export type {
  ClaudeRun,
  HarnessAgent,
  HookResult,
  PairingRun,
  StartAgentOptions,
} from './agent.js';
export { createCanaries } from './canaries.js';
export type { Canaries } from './canaries.js';
export { eventually } from './eventually.js';
export { createFakeClock, FAKE_CLOCK_START } from './fake-clock.js';
export type { FakeClock, TimerHandle } from './fake-clock.js';
export { createPhone } from './phone.js';
export type { CreatePhoneOptions, HeadlessPhone, Paired, Received } from './phone.js';
export { assertNoLeaks, findLeaks, PrivacyLeakError } from './privacy-gate.js';
export type { Leak, LeakSource } from './privacy-gate.js';
export { RELAY_ORIGIN, RELAY_RP_ID, startRelay } from './relay.js';
export type { HarnessRelay, StartRelayOptions } from './relay.js';
export { scenario } from './scenario.js';
export type { Scenario, ScenarioOptions } from './scenario.js';
