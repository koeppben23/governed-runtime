import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewObligationType } from './evidence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..');

const PRODUCER_BY_OBLIGATION_TYPE: Readonly<Record<string, string>> = {
  plan: 'integration/tools/plan.ts',
  implement: 'integration/tools/implement.ts',
  architecture: 'integration/tools/architecture.ts',
  review: 'integration/tools/review-tool/obligation.ts',
};

const TEMPLATE_BY_OBLIGATION_TYPE: Readonly<Record<string, string>> = {
  plan: 'templates/commands/plan.ts',
  implement: 'templates/commands/implement.ts',
  architecture: 'templates/commands/architecture.ts',
  review: 'templates/commands/review.ts',
};

function readSource(relativePath: string): string {
  return readFileSync(join(SRC_ROOT, relativePath), 'utf-8');
}

describe('state/ReviewObligationType completeness', () => {
  describe('HAPPY', () => {
    it('has a producer tool for each obligation type', () => {
      expect(Object.keys(PRODUCER_BY_OBLIGATION_TYPE).sort()).toEqual(
        [...ReviewObligationType.options].sort(),
      );
    });
  });

  describe('BAD', () => {
    it('each producer emits its matching obligationType literal', () => {
      for (const obligationType of ReviewObligationType.options) {
        expect(readSource(PRODUCER_BY_OBLIGATION_TYPE[obligationType])).toContain(
          `obligationType: '${obligationType}'`,
        );
      }
    });
  });

  describe('CORNER', () => {
    it('each command template documents unable_to_review handling for its obligation type', () => {
      const sharedReviewLoop = readSource('templates/commands/shared-review-loop.ts');
      for (const obligationType of ReviewObligationType.options) {
        const template = readSource(TEMPLATE_BY_OBLIGATION_TYPE[obligationType]);
        const combined = template + sharedReviewLoop;
        expect(combined).toContain('unable_to_review');
        expect(combined).toContain('SUBAGENT_UNABLE_TO_REVIEW');
      }
    });
  });

  // ── FG-267: Shared review-loop drift guard ───────────────────
  describe('FG-267 shared review-loop drift', () => {
    const REVIEW_TEMPLATES = [
      'templates/commands/plan.ts',
      'templates/commands/implement.ts',
      'templates/commands/architecture.ts',
    ] as const;

    it('all three templates import and call SHARED_REVIEW_LOOP', () => {
      for (const templatePath of REVIEW_TEMPLATES) {
        const source = readSource(templatePath);
        expect(source).toContain('SHARED_REVIEW_LOOP');
        expect(source).toContain('SHARED_REVIEW_LOOP({');
      }
    });

    it('branching instructions live only in shared-review-loop.ts, not in individual templates', () => {
      for (const templatePath of REVIEW_TEMPLATES) {
        const source = readSource(templatePath);
        // Remove the SHARED_REVIEW_LOOP({...}) call block — the individual
        // template must not contain its own copy of the branching instructions.
        const stripped = source.replace(/\$\{SHARED_REVIEW_LOOP\([{][\s\S]*?[}]\)\}/m, '');
        expect(stripped).not.toContain('SUBAGENT_UNABLE_TO_REVIEW');
        expect(stripped).not.toContain('STRICT_REVIEW_ORCHESTRATION_FAILED');
        expect(stripped).not.toContain('ORCHESTRATION_PERMANENTLY_FAILED');
      }
    });
  });

  describe('EDGE', () => {
    it('producer and template maps do not contain stale obligation types', () => {
      const expected = [...ReviewObligationType.options].sort();
      expect(Object.keys(PRODUCER_BY_OBLIGATION_TYPE).sort()).toEqual(expected);
      expect(Object.keys(TEMPLATE_BY_OBLIGATION_TYPE).sort()).toEqual(expected);
    });
  });
});
