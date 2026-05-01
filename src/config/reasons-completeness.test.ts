/**
 * @module config/reasons-completeness.test
 * @description Build-time guard: every code-string referenced as a `code:`
 * literal in non-test source files MUST be registered in SEED_REASONS.
 *
 * Prevents F1-class regressions where a new error path emits a code that
 * has no recovery steps. An unregistered code falls back to a generic
 * "Blocked: {code}" message with empty recovery[], which gives LLMs
 * (and humans) no actionable guidance.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultReasonRegistry } from './reasons.js';

const SRC_ROOT = join(process.cwd(), 'src');
const CODE_LITERAL_PATTERN = /code:\s*['"]([A-Z][A-Z0-9_]+)['"]/g;

// These codes are NOT registry codes — they are CRITICAL/error severities,
// audit event codes, or external library codes. Excluded explicitly.
const EXCLUDED_CODES: ReadonlySet<string> = new Set([
  'CRITICAL', // severity tag in error fixtures, not a registry reason
  'REVIEW_FAILED', // audit-test fixture, not a runtime block
]);

function collectCodeLiterals(dir: string, acc: Set<string>): void {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      collectCodeLiterals(fullPath, acc);
      continue;
    }
    if (!fullPath.endsWith('.ts')) continue;
    if (fullPath.endsWith('.test.ts')) continue;
    if (fullPath.endsWith('reasons.ts')) continue; // registry self-reference
    const content = readFileSync(fullPath, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = CODE_LITERAL_PATTERN.exec(content)) !== null) {
      const code = match[1];
      if (code !== undefined && !EXCLUDED_CODES.has(code)) {
        acc.add(code);
      }
    }
  }
}

describe('SEED_REASONS completeness (F1 guard)', () => {
  const usedCodes = new Set<string>();
  collectCodeLiterals(SRC_ROOT, usedCodes);

  it('every referenced reason code is registered in the default registry', () => {
    const registered = new Set(defaultReasonRegistry.codes());
    const missing = [...usedCodes].filter((code) => !registered.has(code)).sort();
    expect(missing).toEqual([]);
  });

  it('every registered code has at least one non-empty recovery step', () => {
    const codes = defaultReasonRegistry.codes();
    const offenders: string[] = [];
    for (const code of codes) {
      const formatted = defaultReasonRegistry.format(code);
      if (formatted.recovery.length === 0) {
        offenders.push(code);
      }
    }
    expect(offenders).toEqual([]);
  });
});
