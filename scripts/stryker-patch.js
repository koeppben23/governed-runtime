/**
 * Pre-flight patch for @stryker-mutator/vitest-runner.
 *
 * Stryker's vitest-runner hardcodes `pool: 'threads'` in `createVitest` options
 * (vitest-test-runner.js line 38). This prevents vitest from running with forks,
 * which breaks tests that use process.chdir() (not supported in worker threads).
 *
 * This script runs BEFORE stryker run (via the "mutation" npm script).
 * It is NOT a postinstall hook — it only runs in the mutation testing context.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const TARGET = resolve(
  __dirname,
  '../node_modules/@stryker-mutator/vitest-runner/dist/src/vitest-test-runner.js',
);

const SEARCH = "pool: 'threads'";
const REPLACE = "pool: 'forks'";

let original;
try {
  original = readFileSync(TARGET, 'utf-8');
} catch (err) {
  const code = err?.code;
  if (code === 'ENOENT') {
    console.error(
      `[stryker-patch] ERROR: vitest-test-runner.js not found at ${TARGET}. ` +
        'Is @stryker-mutator/vitest-runner installed?',
    );
    process.exit(1);
  }
  console.error(`[stryker-patch] ERROR: Cannot read ${TARGET}: ${err?.message ?? err}`);
  process.exit(1);
}

if (original.includes(REPLACE)) {
  // Already patched from a previous mutation run.
  process.exit(0);
}

if (!original.includes(SEARCH)) {
  console.warn(
    `[stryker-patch] WARNING: Could not find '${SEARCH}' in vitest-test-runner.js. ` +
      'The Stryker vitest-runner version may have changed. ' +
      'Mutation testing may fail if pool=threads is still hardcoded.',
  );
  process.exit(0);
}

try {
  writeFileSync(TARGET, original.replace(SEARCH, REPLACE), 'utf-8');
} catch (err) {
  console.error(`[stryker-patch] ERROR: Cannot write ${TARGET}: ${err?.message ?? err}`);
  process.exit(1);
}
console.log('[stryker-patch] Patched Stryker vitest-runner: pool=threads → pool=forks');
