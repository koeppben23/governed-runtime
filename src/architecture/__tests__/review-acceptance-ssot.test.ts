/**
 * @module architecture/review-acceptance-ssot.test
 * @description Anti-drift guard (#434, finding M1): the blocked/consumed
 * acceptance-rejection decision for review findings has exactly ONE authority —
 * `getReviewFindingsAcceptanceRejection` in `integration/tools/review-validation.ts`.
 * The M1 defect class was divergent guards: the host-task path omitted the
 * blocked/consumed checks the strict path enforced, so reused/blocked evidence
 * could be accepted on one path but not the other.
 *
 * This guard is scoped HARD to `review-validation.ts` only (other status
 * domains legitimately compare `status === 'blocked'` elsewhere — a global scan
 * would be noisy). The two canonical branches of the authority
 * (`status === 'blocked'`, `status === 'consumed'`) are the budget; any
 * additional inline `status === 'blocked' | 'consumed'` comparison in this file
 * means a competing guard was reintroduced.
 *
 * Production scan excludes `*.test.ts`/`__tests__/`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REVIEW_VALIDATION_PATH = join(
  process.cwd(),
  'src',
  'integration',
  'tools',
  'review-validation.ts',
);

/**
 * Budget = the two branches of the canonical authority
 * `getReviewFindingsAcceptanceRejection` (blocked, consumed). Any inline
 * `status` comparison beyond these is a competing guard.
 */
const CANONICAL_AUTHORITY_BUDGET = 2;

/** An obligation/invocation `status` compared to the blocked/consumed literals. */
const STATUS_LITERAL_CMP = /\bstatus\s*(?:===|!==)\s*'(?:blocked|consumed)'/g;

function countStatusComparisons(content: string): number {
  const matches = content.match(STATUS_LITERAL_CMP);
  return matches ? matches.length : 0;
}

describe('review-acceptance SSOT (#434 M1 anti-drift)', () => {
  it('blocked/consumed acceptance guard lives only in the canonical authority', () => {
    const content = readFileSync(REVIEW_VALIDATION_PATH, 'utf8');
    const count = countStatusComparisons(content);
    if (count > CANONICAL_AUTHORITY_BUDGET) {
      console.error(
        `review-validation.ts has ${count} inline status blocked/consumed comparisons; ` +
          `only ${CANONICAL_AUTHORITY_BUDGET} (the canonical getReviewFindingsAcceptanceRejection ` +
          `branches) are permitted. A competing guard was reintroduced.`,
      );
    }
    expect(count).toBeLessThanOrEqual(CANONICAL_AUTHORITY_BUDGET);
  });

  describe('negative fixture — proves the detector fires', () => {
    it('detects an extra inline blocked/consumed status comparison', () => {
      const fixture =
        "if (status === 'blocked') {}\n" +
        "if (status === 'consumed') {}\n" +
        "const open = obligation.status !== 'blocked';";
      expect(countStatusComparisons(fixture)).toBeGreaterThan(CANONICAL_AUTHORITY_BUDGET);
    });
  });
});
