#!/usr/bin/env node

/**
 * check-agent-instructions.mjs
 *
 * Deterministic structural checks for repository instruction files.
 *
 * This linter detects mechanically verifiable drift. It does not prove
 * semantic consistency, instruction compliance, or policy enforcement.
 *
 * Run via: node scripts/check-agent-instructions.mjs
 */

import { resolve } from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_IGNORED_PATHS,
  formatDiagnostics,
  lintAgentInstructions,
} from './agent-instruction-linter.mjs';

const root = process.argv[2]
  ? resolve(process.argv[2])
  : join(dirname(fileURLToPath(import.meta.url)), '..');

const result = lintAgentInstructions({
  root,
  ignoredPaths: DEFAULT_IGNORED_PATHS,
});

const output = formatDiagnostics(result.diagnostics);
if (output) {
  console.error(output);
}

if (!result.ok) {
  console.error('\nSome checks failed.');
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}
