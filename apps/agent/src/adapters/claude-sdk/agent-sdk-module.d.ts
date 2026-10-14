/**
 * The optional peer is not installed in this workspace (ADR 0015); `load-sdk.ts` checks
 * the module's shape at run time instead of trusting its types.
 */
declare module '@anthropic-ai/claude-agent-sdk';
