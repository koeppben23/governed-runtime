/**
 * @module architecture/claim-resolution-ssot
 * @description Enforce that Claim Resolution Projection has single authorities
 * and never reconstructs evidence satisfaction.
 *
 * Guard invariants:
 *   A. Vocabulary SSOT — only human-verification.ts maps canonical states to
 *      human labels. No other presentation or integration renderer module may
 *      define its own ClaimVerificationState → label mapping.
 *   B. Binding diagnostic copy SSOT — only claim-diagnostic-copy.ts holds
 *      AssertionBindingReasonCode → prose. No renderer may define a parallel
 *      per-code copy map.
 *   C. No evidence reconstruction — presentation/ modules must not import from
 *      audit/proofgraph/ binding, evaluation, derivation, or summarization
 *      modules, nor from validation attempt internals.
 *
 * @version v1
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

        // Any module outside the authority importing BINDING_DIAGNOSTIC_COPY
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
      expect(module!.content, 'diagnostic must preserve bindingReason').toContain('bindingReason');
    });
  });
});
