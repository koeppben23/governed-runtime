/**
 * Postinstall patch for @stryker-mutator/vitest-runner.
 *
 * Stryker's vitest-runner hardcodes `pool: 'threads'` in `createVitest` options
 * (vitest-test-runner.js line 38). This prevents vitest from running with forks,
 * which breaks tests that use process.chdir() (not supported in worker threads).
 *
 * This patch replaces `pool: 'threads'` with `pool: 'forks'` to match the
 * `pool: 'forks'` setting in vitest.config.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const target = resolve(
  __dirname,
  '../node_modules/@stryker-mutator/vitest-runner/dist/src/vitest-test-runner.js',
);

const original = readFileSync(target, 'utf-8');
const patched = original.replace("pool: 'threads'", "pool: 'forks'");

if (patched === original) {
  console.log('[stryker-patch] No change needed (already patched or pool line not found)');
} else {
  writeFileSync(target, patched, 'utf-8');
  console.log('[stryker-patch] Patched Stryker vitest-runner: pool=threads → pool=forks');
}
