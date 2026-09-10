#!/usr/bin/env node

/**
 * check-agent-instructions.mjs
 *
 * Deterministic structural checks for repository instruction files and the thin
 * host bridges that point coding agents at the canonical root AGENTS.md.
 *
 * This linter detects mechanically verifiable drift. It does not prove
 * semantic consistency, instruction compliance, or policy enforcement.
 *
 * Run via: node scripts/check-agent-instructions.mjs
 */

import { readFileSync } from 'node:fs';
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

const bridgeDiagnostics = [];

function readBridge(path) {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch (error) {
    bridgeDiagnostics.push(`${path}: required coding-agent instruction bridge is missing or unreadable`);
    return null;
  }
}

const claudeBridge = readBridge('CLAUDE.md');
if (claudeBridge !== null && claudeBridge.trim() !== '@AGENTS.md') {
  bridgeDiagnostics.push('CLAUDE.md: must remain the thin canonical import `@AGENTS.md`');
}

const geminiBridge = readBridge('GEMINI.md');
if (geminiBridge !== null && geminiBridge.trim() !== '# Gemini CLI Repository Instructions\n\n@./AGENTS.md') {
  bridgeDiagnostics.push('GEMINI.md: must remain a thin import of `@./AGENTS.md`');
}

const copilotBridge = readBridge('.github/copilot-instructions.md');
if (copilotBridge !== null) {
  if (!copilotBridge.includes('root `AGENTS.md`')) {
    bridgeDiagnostics.push('.github/copilot-instructions.md: must point to the root `AGENTS.md`');
  }
  if (!copilotBridge.includes('do not\npropagate repository-development policy')) {
    bridgeDiagnostics.push(
      '.github/copilot-instructions.md: must preserve the repository-vs-product scope boundary',
    );
  }
  if (copilotBridge.split('\n').length > 20) {
    bridgeDiagnostics.push(
      '.github/copilot-instructions.md: keep the host bridge thin (20 lines maximum)',
    );
  }
}

const output = formatDiagnostics(result.diagnostics);
if (output) {
  console.error(output);
}
for (const diagnostic of bridgeDiagnostics) {
  console.error(diagnostic);
}

if (!result.ok || bridgeDiagnostics.length > 0) {
  console.error('\nSome checks failed.');
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}
