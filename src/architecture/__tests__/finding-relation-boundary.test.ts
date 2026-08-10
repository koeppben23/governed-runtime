/**
 * @module architecture/finding-relation-boundary
 * @description Keeps the finding-relation projection display-only: review,
 *              evidence, Git, and ProofGraph authorities must not cross this boundary.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');
const FINDING_RELATION_PROJECTION = 'presentation/finding-relation.ts';

const PRESENTATION_FORBIDDEN_IMPORTS = [
  'integration/review/enforcement/',
  'integration/review/evidence-binding.js',
  'integration/tools/review-validation.js',
  'adapters/git',
  'state/proofgraph.js',
] as const;

const CANONICAL_AUTHORITIES = [
  'state/evidence-review.ts',
  'integration/review/enforcement/findings-consistency.ts',
  'integration/review/evidence-binding.ts',
  'integration/tools/review-validation.ts',
] as const;

function importSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const importPattern =
    /^import\s+(?:(?:type\s+)?(?:\{[^}]*\}|[^;{}]+)\s+from\s+)?['"]([^'"]+)['"]|^export\s+(?:\{[^}]*\}|[^;{}]+)\s+from\s+['"]([^'"]+)['"]|^export\s+from\s+['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(content)) !== null) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function forbiddenFindingRelationImports(content: string): string[] {
  return importSpecifiers(content).filter((specifier) =>
    PRESENTATION_FORBIDDEN_IMPORTS.some((forbidden) => specifier.includes(forbidden)),
  );
}

function presentationImports(content: string): string[] {
  return importSpecifiers(content).filter((specifier) => specifier.includes('/presentation/'));
}

describe('finding-relation presentation boundary', () => {
  it('does not import review enforcement, evidence binding, review validation, Git, or ProofGraph authority', () => {
    const content = readFileSync(join(SRC_ROOT, FINDING_RELATION_PROJECTION), 'utf8');
    expect(forbiddenFindingRelationImports(content)).toEqual([]);
  });

  it('keeps canonical review authorities independent of presentation', () => {
    const violations = CANONICAL_AUTHORITIES.flatMap((authority) => {
      const content = readFileSync(join(SRC_ROOT, authority), 'utf8');
      return presentationImports(content).map((specifier) => `${authority}: imports ${specifier}`);
    });
    expect(violations).toEqual([]);
  });

  describe('negative fixtures', () => {
    it('detects a forbidden authority import from the projection', () => {
      const fixture =
        "import { validateReviewFindingsConsistency } from '../integration/review/enforcement/findings-consistency.js';";
      expect(forbiddenFindingRelationImports(fixture)).toEqual([
        '../integration/review/enforcement/findings-consistency.js',
      ]);
    });

    it('detects a presentation import from a canonical authority', () => {
      const fixture =
        "import { formatFindingAffected } from '../../../presentation/finding-relation.js';";
      expect(presentationImports(fixture)).toEqual(['../../../presentation/finding-relation.js']);
    });
  });
});
