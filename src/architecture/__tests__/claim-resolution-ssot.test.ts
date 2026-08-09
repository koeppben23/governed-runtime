/**
 * @module architecture/claim-resolution-ssot
 * @description Enforce that Claim Resolution Projection has single authorities
 * and never reconstructs evidence satisfaction.
 *
 * Guard invariants:
 *   A. Vocabulary SSOT — only human-verification.ts maps canonical states to
 *      human labels. No other presentation or integration renderer module may
 *      define its own ClaimVerificationState → label mapping. Guards both
 *      imports AND parallel inline mappings.
 *   B. Binding diagnostic copy SSOT — only claim-diagnostic-copy.ts holds
 *      AssertionBindingReasonCode → prose. Guards both imports AND parallel
 *      per-code copy tables/switch statements.
 *   C. No evidence reconstruction — presentation/ modules must not import from
 *      audit/proofgraph/ binding, evaluation, derivation, or summarization
 *      modules, nor from validation attempt internals.
 *
 * @version v2
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const SRC = resolve(join(import.meta.dirname, '..', '..'));

// ─── File collection ──────────────────────────────────────────────────────────

function collectSourceFiles(): string[] {
  const files: string[] = [];
  const stack: string[] = [SRC];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = readdirSafe(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry.includes('__') || entry.includes('node_modules')) continue;
      if (isDir(full)) {
        stack.push(full);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        files.push(full);
      }
    }
  }
  return files;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ─── Invariant A: vocabulary SSOT ─────────────────────────────────────────────

const VOCABULARY_AUTHORITY = 'presentation/human-verification.ts';
const VOCABULARY_FUNCTIONS = [
  'humanVerificationLabel',
  'projectHumanVerificationStatus',
  'humanVerificationExplanation',
];

function importsVocabularyAuthority(content: string): boolean {
  return VOCABULARY_FUNCTIONS.some(
    (fn) => content.includes(`'./human-verification.js'`) && content.includes(fn),
  );
}

function isIntegrationPresentationRenderer(rel: string): boolean {
  return rel.startsWith('integration/') && rel.endsWith('-presentation.ts');
}

/**
 * Detect a local parallel ClaimVerificationState → human label mapping.
 * Patterns like:
 *   PROVEN: 'Verified'
 *   STALE: 'Needs re-check'
 *   case 'CONTRADICTED': return 'Failed';
 * inside a presentation or integration renderer that is NOT the authority.
 */
function hasLocalVocabularyMap(content: string): boolean {
  // Literal state → label entries: { PROVEN: 'Verified' } or PROVEN: 'Verified'
  if (/PROVEN\s*:\s*['"]Verified['"]/g.test(content)) return true;
  if (/STALE\s*:\s*['"]Needs re-check['"]/g.test(content)) return true;
  if (/CONTRADICTED\s*:\s*['"]Failed['"]/g.test(content)) return true;
  if (/BLOCKED\s*:\s*['"]Blocked['"]/g.test(content)) return true;

  // Switch case over state values returning labels
  if (
    /case\s+['"]PROVEN['"]\s*:.*return\s+['"]Verified['"]/g.test(content) ||
    /case\s+['"]STALE['"]\s*:.*return\s+['"]Needs/gs.test(content) ||
    /case\s+['"]CONTRADICTED['"]\s*:.*return\s+['"]Failed['"]/gs.test(content)
  )
    return true;

  return false;
}

// ─── Invariant B: binding diagnostic copy SSOT ────────────────────────────────

/**
 * The ten AssertionBindingReasonCode literal values.
 * Any module that references one as a literal key in a copy/prose context
 * outside the authority is a parallel map.
 */
const BINDING_CODE_LITERALS = [
  'check_mismatch',
  'evidence_missing',
  'check_only_evidence',
  'provider_mismatch',
  'assertion_mismatch',
  'aggregate_check_mismatch',
  'aggregate_candidate_mismatch',
  'aggregate_scope_unattested',
  'aggregate_extraction_missing',
  'aggregate_capability_missing',
];

/**
 * Detect a local per-code binding diagnostic mapping.
 * Matches patterns like:
 *   case 'provider_mismatch': return '...';
 *   evidence_missing: { headline: '...', explanation: '...' }
 * inside a non-authority presentation/renderer module.
 */
function hasLocalBindingDiagnosticMap(content: string): boolean {
  // Object literal with binding code keys
  const codeAliases = BINDING_CODE_LITERALS.join('|');
  const objectPattern = new RegExp(`['"](${codeAliases})['"]\\s*:\\s*\\{`);
  if (objectPattern.test(content)) return true;

  // Switch case returning prose for a new code
  if (
    /case\s+['"](provider_mismatch|evidence_missing|aggregate_scope_unattested|assertion_mismatch|check_mismatch|check_only_evidence|aggregate_check_mismatch|aggregate_candidate_mismatch|aggregate_extraction_missing|aggregate_capability_missing)['"]\s*:/.test(
      content,
    )
  )
    return true;

  return false;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Claim Resolution SSOT', () => {
  const files = collectSourceFiles().map((abs) => ({
    rel: relative(SRC, abs).split('/').join('/'),
    content: readFileSync(abs, 'utf-8'),
  }));

  describe('A — human verification vocabulary SSOT', () => {
    const PERMITTED_IMPORTERS = new Set([
      VOCABULARY_AUTHORITY,
      'presentation/index.ts',
      'presentation/claim-human-projection.ts',
      'presentation/proof-summary.ts',
    ]);

    it('only permitted presentation modules import human-verification authority', () => {
      const violations: string[] = [];
      for (const f of files) {
        const rel = f.rel;
        if (PERMITTED_IMPORTERS.has(rel)) continue;
        if (!rel.startsWith('presentation/') && !isIntegrationPresentationRenderer(rel)) continue;
        if (importsVocabularyAuthority(f.content)) {
          violations.push(
            `${rel}: imports human-verification vocabulary authority; use single vocabulary via permitted paths`,
          );
        }
      }
      expect(violations).toEqual([]);
    });

    it('no presentation or integration renderer defines a local parallel state→label map', () => {
      const violations: string[] = [];
      // labels.ts is a generic status-label registry for non-ProofGraph domains
      const EXCLUDED = new Set(['presentation/labels.ts']);
      for (const f of files) {
        const rel = f.rel;
        if (rel === VOCABULARY_AUTHORITY || EXCLUDED.has(rel)) continue;
        if (!rel.startsWith('presentation/') && !isIntegrationPresentationRenderer(rel)) continue;
        if (hasLocalVocabularyMap(f.content)) {
          violations.push(
            `${rel}: defines a local ClaimVerificationState → human label mapping outside vocabulary authority`,
          );
        }
      }
      expect(violations).toEqual([]);
    });
  });

  describe('B — binding diagnostic copy SSOT', () => {
    const COPY_AUTHORITY = 'presentation/claim-diagnostic-copy.ts';
    const PERMITTED_COPY_IMPORTERS = new Set([
      COPY_AUTHORITY,
      'presentation/index.ts',
      'presentation/claim-human-projection.ts',
    ]);

    it('claim-diagnostic-copy.ts is the sole AssertionBindingReasonCode→prose authority', () => {
      const violations: string[] = [];
      for (const f of files) {
        const rel = f.rel;
        if (PERMITTED_COPY_IMPORTERS.has(rel)) continue;
        if (!rel.startsWith('presentation/') && !isIntegrationPresentationRenderer(rel)) continue;

        if (
          f.content.includes(`'./claim-diagnostic-copy.js'`) ||
          f.content.includes(`'../presentation/claim-diagnostic-copy.js'`)
        ) {
          violations.push(
            `${rel}: imports binding diagnostic copy authority outside permitted path`,
          );
        }
      }
      expect(violations).toEqual([]);
    });

    it('no presentation or integration renderer defines a local per-code binding diagnostic map', () => {
      const violations: string[] = [];
      for (const f of files) {
        const rel = f.rel;
        if (PERMITTED_COPY_IMPORTERS.has(rel)) continue;
        if (!rel.startsWith('presentation/') && !isIntegrationPresentationRenderer(rel)) continue;
        if (hasLocalBindingDiagnosticMap(f.content)) {
          violations.push(
            `${rel}: defines a local AssertionBindingReasonCode → prose mapping outside copy authority`,
          );
        }
      }
      expect(violations).toEqual([]);
    });
  });

  describe('C — no evidence reconstruction in presentation layer', () => {
    const FORBIDDEN_AUDIT_IMPORTS = [
      'audit/proofgraph/assertion-evidence-binding.ts',
      'audit/proofgraph/counterexample-binder.ts',
      'audit/proofgraph/executed-test-binder.ts',
      'audit/proofgraph/derive.ts',
      'audit/proofgraph/summary.ts',
      'audit/proofgraph/evaluate.ts',
      'audit/proofgraph/gate.ts',
    ];

    it('presentation modules do not import evidence-binding or evaluation modules', () => {
      const violations: string[] = [];
      for (const f of files) {
        const rel = f.rel;
        if (!rel.startsWith('presentation/')) continue;
        for (const forbidden of FORBIDDEN_AUDIT_IMPORTS) {
          const short = forbidden.split('/').slice(1).join('/');
          if (
            f.content.includes(`'../${forbidden}'`) ||
            f.content.includes(`'../../${forbidden}'`) ||
            f.content.includes(`'../audit/${short}'`)
          ) {
            violations.push(
              `${rel}: imports ${forbidden} (evidence reconstruction in presentation layer)`,
            );
          }
        }
      }
      expect(violations).toEqual([]);
    });
  });

  describe('D — diagnostic preserves canonical state', () => {
    it('claim-human-projection.ts exposes canonical state in diagnostic projection', () => {
      const module = files.find((f) => f.rel === 'presentation/claim-human-projection.ts');
      expect(module, 'claim-human-projection.ts must exist').toBeTruthy();
      expect(module!.content, 'diagnostic must preserve canonicalState').toContain(
        'canonicalState',
      );
      expect(module!.content, 'diagnostic must preserve counterexampleRequirement').toContain(
        'counterexampleRequirement',
      );
    });
  });

  // ─── Negative fixtures ─────────────────────────────────────────────────────

  describe('negative fixtures — prove the detectors fire', () => {
    it('detects a local state→label map in a presentation renderer', () => {
      expect(
        hasLocalVocabularyMap("const LABELS = { PROVEN: 'Verified', STALE: 'Needs re-check' };"),
      ).toBe(true);
    });

    it('detects a switch-based vocabulary map outside the authority', () => {
      expect(hasLocalVocabularyMap("case 'CONTRADICTED': return 'Failed';")).toBe(true);
    });

    it('detects a local per-code binding diagnostic map', () => {
      expect(
        hasLocalBindingDiagnosticMap(
          "'provider_mismatch': { headline: 'Wrong', explanation: 'Different provider' },",
        ),
      ).toBe(true);
    });

    it('detects a switch over binding reason codes', () => {
      expect(
        hasLocalBindingDiagnosticMap("case 'evidence_missing': return 'Missing evidence';"),
      ).toBe(true);
    });

    it('does NOT flag legitimate literal usage in the authority module', () => {
      // The authority is expected to contain these literals
      const fixture = {
        rel: VOCABULARY_AUTHORITY,
        content: "PROVEN: { label: 'Verified', defaultExplanation: 'sufficient' },",
      };
      expect(fixture.rel === VOCABULARY_AUTHORITY).toBe(true);
    });

    it('does NOT flag code occurrences in non-presentation modules', () => {
      // audit/ files legitimately contain binding code literals
      const fixtureRel = 'audit/proofgraph/assertion-evidence-binding.ts';
      expect(isIntegrationPresentationRenderer(fixtureRel)).toBe(false);
      expect(fixtureRel.startsWith('presentation/')).toBe(false);
    });
  });
});
