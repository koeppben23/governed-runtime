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

import { readFileSync, readdirSync } from 'node:fs';
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

/**
 * Walks the source tree and collects every `code: 'FOO_BAR'` literal.
 *
 * Implementation note: uses `readdirSync(..., { withFileTypes: true })` to
 * obtain dirent kind in a single syscall, and reads file contents directly
 * (no separate existence check). This avoids the TOCTOU pattern flagged by
 * CodeQL `js/file-system-race` — there is no "check then use" window because
 * we never check before reading; we either succeed or surface the I/O error.
 *
 * Build-time only (vitest), no untrusted input, but the safer pattern is
 * trivial to apply and removes a static-analysis false-positive.
 */
function collectCodeLiterals(dir: string, acc: Set<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectCodeLiterals(fullPath, acc);
      continue;
    }
    if (!entry.isFile()) continue;
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

// P10c: reason code split validation
describe('P10c — reason code split', () => {
  it('all 103 codes from split arrays are registered exactly once (no duplicates)', async () => {
    const { PRECONDITION_REASONS } = await import('./reasons-precondition.js');
    const { VALIDATION_REASONS } = await import('./reasons-validation.js');
    const { INFRA_REASONS } = await import('./reasons-infra.js');

    const allSplitCodes = [
      ...PRECONDITION_REASONS.map((r: { code: string }) => r.code),
      ...VALIDATION_REASONS.map((r: { code: string }) => r.code),
      ...INFRA_REASONS.map((r: { code: string }) => r.code),
    ];

    expect(allSplitCodes).toHaveLength(104);
    // No duplicates across the 3 arrays
    expect(new Set(allSplitCodes).size).toBe(104);
    // All split codes are registered in the default registry
    for (const code of allSplitCodes) {
      expect(defaultReasonRegistry.get(code)).toBeDefined();
    }
  });

  it('PRECONDITION_REASONS has exactly 34 entries', async () => {
    const { PRECONDITION_REASONS } = await import('./reasons-precondition.js');
    expect(PRECONDITION_REASONS.length).toBe(34);
    for (const r of PRECONDITION_REASONS) {
      expect(r.category).toBe('precondition');
    }
  });

  it('VALIDATION_REASONS has exactly 43 entries', async () => {
    const { VALIDATION_REASONS } = await import('./reasons-validation.js');
    expect(VALIDATION_REASONS.length).toBe(43);
    const allowed = new Set(['input', 'state', 'config', 'admissibility']);
    for (const r of VALIDATION_REASONS) {
      expect(allowed.has(r.category)).toBe(true);
    }
  });

  it('INFRA_REASONS has exactly 27 entries', async () => {
    const { INFRA_REASONS } = await import('./reasons-infra.js');
    expect(INFRA_REASONS.length).toBe(27);
    const allowed = new Set(['adapter', 'identity']);
    for (const r of INFRA_REASONS) {
      expect(allowed.has(r.category)).toBe(true);
    }
  });
});
