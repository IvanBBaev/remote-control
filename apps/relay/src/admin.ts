import { runAdminCommand } from './admin-command.js';

// Entry point of `node dist/admin.js` (run as `railway run node dist/admin.js invite`).
process.exitCode = await runAdminCommand({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
