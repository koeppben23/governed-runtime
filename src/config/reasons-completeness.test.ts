/**
 * @module config/reasons-completeness.test
 * @description Build-time guard: every code-string referenced as a `code:`
 * literal in non-test source files MUST be registered in SEED_REASONS.
 *
 * Prevents F1-class regressions where a new error path emits a code that
 * has no recovery steps. Runtime formatting marks unregistered codes visibly,
 * but production code should not rely on that fallback for governance paths.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultReasonRegistry } from './reasons.js';

const SRC_ROOT = join(process.cwd(), 'src');
const CODE_LITERAL_PATTERN = /code:\s*['"]([A-Z][A-Z0-9_]+)['"]/g;
// Reason codes are also emitted positionally via helper calls such as
// `formatBlocked('CODE')` / `strictBlockedOutput('CODE')`. These are NOT
// `code:` object properties, so the property pattern above misses them. Guard
// them explicitly to prevent unregistered-code regressions on those paths.
const BLOCK_HELPER_PATTERN = /(?:formatBlocked|strictBlockedOutput)\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g;
// ProofGraph enforcement mapping (audit/proofgraph/reason-code-mapping.ts)
// emits registry codes as OBJECT-MAP VALUES and switch RETURNS — e.g.
// `evidence_missing: 'PROOFGRAPH_ASSERTION_EVIDENCE_MISSING'` or
// `return 'PROOFGRAPH_AGGREGATE_SCOPE_UNATTESTED'`. These are neither `code:`
// properties nor formatBlocked('CODE') calls, so both patterns above miss
// them. Scan mapping-value literals explicitly so the F1 guard also covers
// ProofGraph enforcement outputs (gate and status consume this mapping).
const MAPPING_CODE_PATTERN = /['"]([A-Z][A-Z0-9_]+)['"]/g;
const PROOFGRAPH_MAPPING_FILE = 'reason-code-mapping.ts';

// These codes are NOT registry codes — they are CRITICAL/error severities,
// audit event codes, or external library codes. Excluded explicitly.
const EXCLUDED_CODES: ReadonlySet<string> = new Set([
  'CRITICAL',
  'REVIEW_FAILED',
  'STATUS_ACTION_PROJECTION_MISSING_METADATA',
  'STATUS_DECISION_PROJECTION_EMPTY',
  'WHY_DECISION_PROJECTION_EMPTY',
  'WHY_ACTION_PROJECTION_EMPTY',
  'WHY_TERMINAL_PROJECTION_EMPTY',
  'FINISH_TERMINAL_PROJECTION_EMPTY',
  'RAIL_DECISION_PROJECTION_EMPTY',
  'RAIL_TERMINAL_PROJECTION_EMPTY',
  // CLI error codes — not reason registry codes
  'TARBALL_CHECKSUMS_UNREADABLE',
  'TARBALL_DUPLICATE_ENTRY',
  'TARBALL_NOT_FOUND',
  'TARBALL_SHA256_MISMATCH',
  'TARBALL_NAME_INVALID',
  'TARBALL_VERSION_MISMATCH',
  'TARBALL_INTEGRITY_FAILED',
  'MISSING_CORE_TARBALL',
  'CONFIG_INCOMPATIBLE_FLAGS',
  'ALREADY_INSTALLED',
  'DEPENDENCY_INSTALL_FAILED',
  'INSTALL_LOCK_CONFLICT',
  'REVIEWER_CONFIG_REJECTED',
  'REVIEWER_CONFIG_INVALID',
  'REVIEWER_TUNING_UNSUPPORTED',
  // Diagnostic-only host-capability log code (diagnosticLog.warn), not a
  // governance reason code — mirrors the CRITICAL/error-severity exclusions above.
  'HOST_CAPABILITY_MISMATCH',
  // Pass-state registry code derived by reason-code-mapping.ts for PROVEN
  // claims (ClaimEnforcementState.registryCode). Never a blocking reason:
  // blockingStateFor('PROVEN') is null, so this code can never surface as a
  // blocked recovery path. Excluded from the registration guard deliberately.
  'PROOFGRAPH_EVIDENCE_PROVEN',
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
      // Skip __tests__/ trees: non-.test.ts helpers there (e.g. probe
      // harnesses) carry diagnostic-only outcome codes, not governance
      // reason codes, and must not be held to registry completeness.
      if (entry.name === '__tests__') continue;
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
    while ((match = BLOCK_HELPER_PATTERN.exec(content)) !== null) {
      const code = match[1];
      if (code !== undefined && !EXCLUDED_CODES.has(code)) {
        acc.add(code);
      }
    }
    if (fullPath.endsWith(PROOFGRAPH_MAPPING_FILE)) {
      while ((match = MAPPING_CODE_PATTERN.exec(content)) !== null) {
        const code = match[1];
        if (code !== undefined && !EXCLUDED_CODES.has(code)) {
          acc.add(code);
        }
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
  it('all 231 codes from split arrays are registered exactly once (no duplicates)', async () => {
    const { PRECONDITION_REASONS } = await import('./reasons-precondition.js');
    const { VALIDATION_REASONS } = await import('./reasons-validation.js');
    const { INFRA_REASONS } = await import('./reasons-infra.js');
    const { PROOFGRAPH_REASONS } = await import('./reasons-proofgraph.js');

    const allSplitCodes = [
      ...PRECONDITION_REASONS.map((r: { code: string }) => r.code),
      ...VALIDATION_REASONS.map((r: { code: string }) => r.code),
      ...INFRA_REASONS.map((r: { code: string }) => r.code),
      ...PROOFGRAPH_REASONS.map((r: { code: string }) => r.code),
    ];

    expect(allSplitCodes).toHaveLength(231);
    // No duplicates across the 4 arrays
    expect(new Set(allSplitCodes).size).toBe(231);
    // All split codes are registered in the default registry
    for (const code of allSplitCodes) {
      expect(defaultReasonRegistry.get(code)).toBeDefined();
    }
  });

  it('PRECONDITION_REASONS has exactly 86 entries', async () => {
    const { PRECONDITION_REASONS } = await import('./reasons-precondition.js');
    expect(PRECONDITION_REASONS.length).toBe(86);
    for (const r of PRECONDITION_REASONS) {
      expect(r.category).toBe('precondition');
    }
  });

  it('VALIDATION_REASONS has exactly 82 entries', async () => {
    const { VALIDATION_REASONS } = await import('./reasons-validation.js');
    expect(VALIDATION_REASONS.length).toBe(82);
    const allowed = new Set(['input', 'state', 'config', 'admissibility']);
    for (const r of VALIDATION_REASONS) {
      expect(allowed.has(r.category)).toBe(true);
    }
  });

  it('INFRA_REASONS has exactly 39 entries', async () => {
    const { INFRA_REASONS } = await import('./reasons-infra.js');
    const { PROOFGRAPH_REASONS } = await import('./reasons-proofgraph.js');
    expect(INFRA_REASONS.length).toBe(39);
    const allowed = new Set(['adapter', 'identity']);
    for (const r of INFRA_REASONS) {
      expect(allowed.has(r.category)).toBe(true);
    }
  });
});
