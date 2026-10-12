import { anonymiseMain } from './anonymise-dir.js';

process.exitCode = anonymiseMain(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
