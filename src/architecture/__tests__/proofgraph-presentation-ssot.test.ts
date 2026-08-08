/**
 * @module architecture/proofgraph-presentation-ssot
 * @description Enforce that ProofGraph presentation uses the single canonical
 *              authority: buildProofGraphSection() in presentation/proof-summary.ts.
 *
 * Protects the architectural invariant from PR #787:
 *
 *   - buildProofGraphSection() is the ONLY public entry point for wrapping
 *     rendered CompactProofPresentation data into a PresentationSection.
 *   - renderCompactProofSection is an internal implementation detail owned by
 *     proof-summary.ts and must NOT be directly imported by any other
 *     production module.
 *   - Test files are exempt — they may import renderCompactProofSection for
 *     unit-level rendering validation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const SRC = resolve(join(import.meta.dirname, '..', '..'));
const CANONICAL_MODULE = 'presentation/proof-summary.ts';

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

describe('ProofGraph presentation SSOT', () => {
  it('renderCompactProofSection is an implementation detail of proof-summary.ts', () => {
    const files = collectSourceFiles();
    const violations: string[] = [];

    for (const abs of files) {
      const rel = relative(SRC, abs);
      // The canonical module is the owner — it may import itself.
      if (rel === CANONICAL_MODULE) continue;
      // Skip test files and test helpers.
      if (rel.includes('.test.')) continue;

      const content = readFileSync(abs, 'utf-8');
      // Match both: import { renderCompactProofSection } and import { ..., renderCompactProofSection, ... }
      if (/\bimport\b[^;]*renderCompactProofSection[^;]*from/.test(content)) {
        violations.push(
          `${rel}: directly imports renderCompactProofSection outside of its canonical ${CANONICAL_MODULE} owner`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it('required governance document builders use the typed ProofGraph section', () => {
    const requiredBuilders = [
      'presentation/plan-review-card.ts',
      'presentation/evidence-review-card.ts',
      'presentation/architecture-review-card.ts',
      'presentation/review-report-card.ts',
      'integration/status-presentation.ts',
      'integration/why-presentation.ts',
      'integration/finish-presentation.ts',
    ];
    const violations = requiredBuilders.filter((rel) => {
      const content = readFileSync(join(SRC, rel), 'utf-8');
      return !content.includes('buildProofGraphSection(');
    });
    expect(violations).toEqual([]);
  });

  it('reserves ProofGraph Markdown rendering for the shared renderer', () => {
    const violations = collectSourceFiles().flatMap((abs) => {
      const rel = relative(SRC, abs);
      if (rel === 'presentation/markdown.ts' || rel === CANONICAL_MODULE) return [];
      const content = readFileSync(abs, 'utf-8');
      return /\bimport\b[^;]*renderProofGraphMarkdown[^;]*from/.test(content)
        ? [`${rel}: imports renderProofGraphMarkdown outside presentation/markdown.ts`]
        : [];
    });
    expect(violations).toEqual([]);
  });
});
