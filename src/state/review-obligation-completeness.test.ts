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
  review: 'integration/tools/simple-tools.ts',
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
      for (const obligationType of ReviewObligationType.options) {
        const template = readSource(TEMPLATE_BY_OBLIGATION_TYPE[obligationType]);
        expect(template).toContain('unable_to_review');
        expect(template).toContain('SUBAGENT_UNABLE_TO_REVIEW');
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
