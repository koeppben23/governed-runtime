#!/usr/bin/env node

/**
 * update-template-hashes.mjs
 *
 * Explicit refresh path for the committed golden manifest
 * `scripts/template-hashes.json`.
 *
 * The hash authority is the vitest suite
 * (`src/cli/templates-hash.test.ts`): only the test runner can load the
 * TypeScript template tree. This wrapper runs that suite twice: first with
 * `TEMPLATE_HASHES_WRITE=1` to refresh the manifest from the live templates,
 * then without the flag to verify the committed bytes independently.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

execFileSync(NPX, ['vitest', 'run', 'src/cli/templates-hash.test.ts'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  env: { ...process.env, TEMPLATE_HASHES_WRITE: '1' },
});

// Independent verification run: no write flag, so the suite reads the manifest
// just committed to disk and compares it against the live templates.
execFileSync(NPX, ['vitest', 'run', 'src/cli/templates-hash.test.ts'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});

console.log('[update-template-hashes] golden manifest refreshed and verified');
