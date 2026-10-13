import { fileURLToPath } from 'node:url';

// Every module here sits directly in src/, and tsdown bundles it into dist/*.js, so in
// dev, tests and the image these resolve against the package root the same way.

export const PACKAGE_JSON = new URL('../package.json', import.meta.url);
export const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));
/** The M0-03 device spike page, shipped next to dist/ in the image (`files`). */
export const SPIKE_DIR = fileURLToPath(new URL('../spike', import.meta.url));
/** Generated SQL migrations (`drizzle-kit generate`), shipped next to dist/ in the image. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));
