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

import { runCli } from './agent-instruction-linter.mjs';

runCli();
