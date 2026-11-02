/** Focused security mutation scope. Invoke via npm run mutation so Vitest-5 preflight runs. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/shared/strict-json-object.test.ts',
      'src/state/review-message-capture.test.ts',
      'src/integration/review/dispatch/durable-dispatch.test.ts',
    ],
    globals: false,
    testTimeout: 60_000,
  },
});
