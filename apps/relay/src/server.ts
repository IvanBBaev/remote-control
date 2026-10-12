import { startServer } from './main.js';

// Process entry point (`node dist/server.js`). Everything testable lives in main.ts.
try {
  await startServer({ env: process.env, signals: process, exit: (code) => process.exit(code) });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
