// `@remote-control/crypto/noble`: a separate entry so the web app and the agent, which use
// WebCrypto, never bundle `@noble/*` (ADR 0017).
export { nobleBackend } from './backends/noble.js';
