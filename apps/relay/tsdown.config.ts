import { defineConfig } from 'tsdown';

// One ESM file for the image: workspace packages (TypeScript sources) are bundled in,
// npm runtime dependencies stay external and come from `pnpm deploy --prod`.
export default defineConfig({
  entry: { server: 'src/server.ts' },
  platform: 'node',
  target: 'node22',
  format: 'esm',
  fixedExtension: false,
  // `tsc -b` writes declarations into dist/ as well; keep them.
  clean: false,
  dts: false,
  // npm packages are imported for their exports only; this drops imports the bundle
  // never uses (e.g. the agent-only `pino-roll` behind @remote-control/log).
  treeshake: { moduleSideEffects: 'no-external' },
  deps: {
    alwaysBundle: [/^@remote-control\//],
    neverBundle: true,
    onlyImport: ['@fastify/static', 'fastify', 'pg', 'pino', 'zod'],
  },
});
