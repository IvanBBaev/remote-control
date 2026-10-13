/** The relay and the PWA it serves (one origin, as in production). */
export const RELAY_PORT = Number(process.env['E2E_RELAY_PORT'] ?? 4173);
/** The test-only control API of `server.ts`. */
export const CONTROL_PORT = Number(process.env['E2E_CONTROL_PORT'] ?? 4174);
