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
 * would be noisy). It is FUNCTION-SCOPE-AWARE: a `status === 'blocked' | 'consumed'`
 * comparison is permitted ONLY inside the body of the canonical authority
 * function. Any such comparison elsewhere in the file — even if the total count
 * stays small — means a competing inline guard was reintroduced. If the
 * authority function is missing/renamed, every comparison is flagged
 * (fail-closed: the single authority must exist).
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

/** The sole function permitted to compare obligation/invocation status. */
const AUTHORITY_FN = 'getReviewFindingsAcceptanceRejection';

/** An obligation/invocation `status` compared to the blocked/consumed literals. */
const STATUS_LITERAL_CMP = /\bstatus\s*(?:===|!==)\s*'(?:blocked|consumed)'/g;

interface OffsetRange {
  readonly start: number;
  readonly end: number;
}

interface Violation {
  readonly line: number;
  readonly snippet: string;
}

/** 1-based line number of a character offset within `content`. */
function lineOfOffset(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

/**
 * Char range [start,end] of the authority function body, or `null` if the
 * function is absent. The signature carries an inline object-type parameter
 * (`input: { ... }`), so the body brace is located by first matching the
 * parameter-list parentheses (paren-counting ignores braces inside inline
 * types), then taking the first `{` after the param list. The authority's
 * return type carries no braces, and its body contains no braces inside
 * string/comment literals, so brace matching is sufficient.
 */
function findAuthorityBody(content: string): OffsetRange | null {
  const sigIdx = content.indexOf(`function ${AUTHORITY_FN}`);
  if (sigIdx < 0) return null;
  const parenStart = content.indexOf('(', sigIdx);
  if (parenStart < 0) return null;
  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < content.length; i++) {
    const ch = content[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  if (parenEnd < 0) return null;
  const braceStart = content.indexOf('{', parenEnd);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { start: braceStart, end: i };
    }
  }
  return null;
}

function findStatusComparisonsOutsideAuthority(content: string): Violation[] {
  const body = findAuthorityBody(content);
  const out: Violation[] = [];
  STATUS_LITERAL_CMP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STATUS_LITERAL_CMP.exec(content)) !== null) {
    const inside = body !== null && m.index >= body.start && m.index <= body.end;
    if (!inside) {
      out.push({ line: lineOfOffset(content, m.index), snippet: m[0] });
    }
  }
  return out;
}

describe('review-acceptance SSOT (#434 M1 anti-drift)', () => {
  it('blocked/consumed status comparisons exist only inside the canonical authority', () => {
    const content = readFileSync(REVIEW_VALIDATION_PATH, 'utf8');
    const violations = findStatusComparisonsOutsideAuthority(content);
    if (violations.length > 0) {
      console.error(
        'Inline blocked/consumed status comparison(s) outside ' +
          `${AUTHORITY_FN} (a competing guard was reintroduced):`,
        violations,
      );
    }
    expect(violations).toEqual([]);
  });

  describe('negative fixture — proves the detector fires', () => {
    it('flags a status comparison OUTSIDE the authority even when total count is small', () => {
      const fixture =
        `function ${AUTHORITY_FN}(input) {\n` +
        "  if (obligation.status === 'blocked') return x;\n" +
        '}\n' +
        'function elsewhere() {\n' +
        "  const open = obligation.status !== 'consumed';\n" +
        '}\n';
      const violations = findStatusComparisonsOutsideAuthority(fixture);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.snippet).toContain('consumed');
    });

    it('fails closed when the authority function is absent (all comparisons flagged)', () => {
      const fixture = "if (obligation.status === 'blocked') {}";
      const violations = findStatusComparisonsOutsideAuthority(fixture);
      expect(violations).toHaveLength(1);
    });

    it('passes when both comparisons are inside the authority body', () => {
      const fixture =
        `function ${AUTHORITY_FN}(input) {\n` +
        "  if (obligation.status === 'blocked') return a;\n" +
        "  if (obligation.status === 'consumed') return b;\n" +
        '}\n';
      const violations = findStatusComparisonsOutsideAuthority(fixture);
      expect(violations).toEqual([]);
    });
  });
});
