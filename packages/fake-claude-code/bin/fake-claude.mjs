#!/usr/bin/env node
// `fake-claude` entry point: loads the TypeScript sources through tsx (no build step).
import { register } from 'tsx/esm/api';

register();
const { runFromProcess } = await import(new URL('../src/process-main.ts', import.meta.url).href);
await runFromProcess();
