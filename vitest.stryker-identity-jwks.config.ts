import { defineConfig } from 'vitest/config';

/** Focused mutation-test projection for the remote JWKS transport boundary. */
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/identity/key-resolver.test.ts'],
    globals: false,
    testTimeout: 60_000,
  },
});
