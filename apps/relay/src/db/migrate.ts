import { runMigrateCommand } from './migrate-command.js';

// Entry point of `node dist/migrate.js` (Railway pre-deploy, D17). Logic in migrate-command.ts.
process.exitCode = await runMigrateCommand({ env: process.env });
