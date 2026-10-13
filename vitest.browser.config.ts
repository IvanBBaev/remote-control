import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// 07 W9: the crypto known-answer vectors run in real Chromium and WebKit, not only in Node.
// Kept out of `pnpm check` because it needs Playwright browsers; CI runs it in `e2e`.
export default defineConfig({
  test: {
    name: 'browser-crypto',
    include: ['packages/crypto/src/vectors.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }, { browser: 'webkit' }],
    },
  },
});
