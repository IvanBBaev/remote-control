import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @remote-control/relay db:generate` writes forward-only SQL migrations
// into drizzle/ (committed). `drizzle-kit push` is never used (D17).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
