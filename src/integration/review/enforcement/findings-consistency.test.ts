import { describe, it, expect } from 'vitest';
import {
  validateReviewFindingsConsistency,
  validateReviewFindingsScope,
} from './findings-consistency.js';

// F12: canonical verdict/blocking-issues coherence invariant (strict emptiness).
// This is the single source of truth for the rule; both ingestion boundaries
// delegate here. The matrix below fully pins the rule so a refactor cannot
// silently narrow or widen it. Challenge/resolution consistency lives in the
// separate challenge-consistency authority (#747) and is tested there.
describe('review/enforcement/findings-consistency', () => {
  describe('BAD — accept with any blocking issue is incoherent (strict emptiness)', () => {
    it('accept + 1 blocking issue → incoherent', () => {
      const result = validateReviewFindingsConsistency({
        overallVerdict: 'accept',
        blockingIssueCount: 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected incoherent');
      expect(result.code).toBe('SUBAGENT_VERDICT_FINDINGS_INCOHERENT');
      expect(result.details).toEqual({ overallVerdict: 'accept', blockingIssueCount: 1 });
    });

    it('accept + many blocking issues → incoherent, count preserved', () => {
      const result = validateReviewFindingsConsistency({
        overallVerdict: 'accept',
        blockingIssueCount: 4,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected incoherent');
      expect(result.details.blockingIssueCount).toBe(4);
    });
  });

  describe('HAPPY — coherent combinations pass', () => {
    it('P3: accept + zero blocking issues is the only accepted zero-claim case', () => {
      expect(
        validateReviewFindingsConsistency({ overallVerdict: 'accept', blockingIssueCount: 0 }),
      ).toEqual({ ok: true });
    });

    it('changes_requested + blocking issues → ok (non-accept verdicts are unconstrained)', () => {
      expect(
        validateReviewFindingsConsistency({
          overallVerdict: 'changes_requested',
          blockingIssueCount: 3,
        }),
      ).toEqual({ ok: true });
    });

    it('changes_requested + 0 blocking issues → ok', () => {
      expect(
        validateReviewFindingsConsistency({
          overallVerdict: 'changes_requested',
          blockingIssueCount: 0,
        }),
      ).toEqual({ ok: true });
    });

    it('unable_to_review + 0 blocking issues → ok (own SSOT path, not this rule)', () => {
      expect(
        validateReviewFindingsConsistency({
          overallVerdict: 'unable_to_review',
          blockingIssueCount: 0,
        }),
      ).toEqual({ ok: true });
    });
  });

  describe('GUARD — rule keys ONLY on blocking issues, not on other findings', () => {
    it('the check receives only verdict + blocking count; advisory data elsewhere cannot trip it', () => {
      // The input contract deliberately excludes majorRisks/missingVerification/etc.
      // so "accept must be findings-free" can never be implemented by accident.
      expect(
        validateReviewFindingsConsistency({ overallVerdict: 'accept', blockingIssueCount: 0 }),
      ).toEqual({ ok: true });
    });
  });

  describe('validateReviewFindingsScope', () => {
    it('path matching a scope entry is valid', () => {
      const result = validateReviewFindingsScope({
        findings: [{ location: 'src/foo.ts' }],
        reviewedFileScope: ['src/foo.ts', 'src/bar.ts'],
      });
      expect(result.ok).toBe(true);
    });

    it('path outside scope is rejected', () => {
      const result = validateReviewFindingsScope({
        findings: [{ location: 'src/baz.ts' }],
        reviewedFileScope: ['src/foo.ts'],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.code).toBe('REVIEW_FINDING_OUT_OF_SCOPE');
      expect(result.details.outOfScopePaths).toContain('src/baz.ts');
    });

    it('./ prefix is normalized before comparison', () => {
      const result = validateReviewFindingsScope({
        findings: [{ location: './src/foo.ts' }],
        reviewedFileScope: ['src/foo.ts'],
      });
      expect(result.ok).toBe(true);
    });

    it('path traversal via ../ is caught and normalized', () => {
      const result = validateReviewFindingsScope({
        findings: [{ location: 'src/../etc/passwd' }],
        reviewedFileScope: ['src/foo.ts'],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.details.outOfScopePaths).toContain('src/../etc/passwd');
    });

    it('legacy obligation without reviewedFileScope → scope_unverifiable', () => {
      const result = validateReviewFindingsScope({
        findings: [{ location: 'src/foo.ts' }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.code).toBe('REVIEW_FINDING_SCOPE_UNVERIFIABLE');
    });

    it('findings without locations pass scope check', () => {
      const result = validateReviewFindingsScope({
        findings: [{ message: 'no location' }],
        reviewedFileScope: ['src/foo.ts'],
      });
      expect(result.ok).toBe(true);
    });

    it('same out-of-scope finding rejected regardless of finding source (symmetry)', () => {
      const outOfScope = { location: 'src/secret.ts', severity: 'critical' };
      const scope = ['src/foo.ts'];
      expect(
        validateReviewFindingsScope({ findings: [outOfScope], reviewedFileScope: scope }).ok,
      ).toBe(false);
      const combined = [{ location: 'src/foo.ts' }, outOfScope, { location: 'src/bar.ts' }];
      const result = validateReviewFindingsScope({
        findings: combined,
        reviewedFileScope: ['src/foo.ts', 'src/bar.ts'],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.details.outOfScopePaths).toEqual(['src/secret.ts']);
    });
  });

  describe('validateReviewFindingsScope — path candidate extraction', () => {
    const SCOPE = ['src/foo/TaskService.java', 'src/foo/CreateTaskRequest.java'];

    it('extracts path with line range and method decoration', () => {
      const result = validateReviewFindingsScope({
        findings: [{ location: 'src/foo/TaskService.java:34-43 (createTask method)' }],
        reviewedFileScope: SCOPE,
      });
      expect(result.ok).toBe(true);
    });

    it('extracts path with line annotation and field decoration', () => {
      const result = validateReviewFindingsScope({
        findings: [{ location: 'src/foo/CreateTaskRequest.java (dueDate field)' }],
        reviewedFileScope: SCOPE,
      });
      expect(result.ok).toBe(true);
    });

    it('extracts path from mixed prose/path location separated by semicolon', () => {
      const result = validateReviewFindingsScope({
        findings: [{ location: 'ADR Decision section; src/foo/TaskService.java:26-32 (getTask)' }],
        reviewedFileScope: SCOPE,
      });
      expect(result.ok).toBe(true);
    });

    it('rejects path in mixed prose when path is out of scope', () => {
      const result = validateReviewFindingsScope({
        findings: [{ location: 'ADR Decision section; src/other/Secret.java:10-20 (leak)' }],
        reviewedFileScope: SCOPE,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.code).toBe('REVIEW_FINDING_OUT_OF_SCOPE');
    });

    it('extracts multiple paths from a single location string', () => {
      const result = validateReviewFindingsScope({
        findings: [
          {
            location:
              'See src/foo/TaskService.java and src/foo/CreateTaskRequest.java for the mismatch',
          },
        ],
        reviewedFileScope: SCOPE,
      });
      expect(result.ok).toBe(true);
    });

    it('blocks when one of multiple extracted paths is out of scope', () => {
      const result = validateReviewFindingsScope({
        findings: [
          {
            location: 'src/foo/TaskService.java + src/other/OutOfScope.java mismatch',
          },
        ],
        reviewedFileScope: SCOPE,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.code).toBe('REVIEW_FINDING_OUT_OF_SCOPE');
    });

    it('blocks when 2 in-scope + 2 out-of-scope paths in same location', () => {
      const result = validateReviewFindingsScope({
        findings: [
          {
            location:
              'src/foo/TaskService.java, src/foo/CreateTaskRequest.java, src/other/A.java, src/other/B.java',
          },
        ],
        reviewedFileScope: SCOPE,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.code).toBe('REVIEW_FINDING_OUT_OF_SCOPE');
    });

    it('pure prose location with zero paths passes scope check', () => {
      const result = validateReviewFindingsScope({
        findings: [{ location: 'ADR Decision section, lines 45-53 (updateTask)' }],
        reviewedFileScope: SCOPE,
      });
      expect(result.ok).toBe(true);
    });

    it('non-path prose tokens do not cause false positives', () => {
      const result = validateReviewFindingsScope({
        findings: [
          {
            location:
              'ADR Decision section; src/foo/TaskService.java:26-32 (getTask), lines 45-53 (updateTask)',
          },
        ],
        reviewedFileScope: SCOPE,
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('validateReviewFindingsScope — discriminated union ReviewedScope', () => {
    const SCOPE_FILES = {
      kind: 'files' as const,
      paths: ['src/foo.ts'],
    };

    it('kind=files with matching path passes', () => {
      const result = validateReviewFindingsScope({
        findings: [{ location: 'src/foo.ts' }],
        reviewedFileScope: SCOPE_FILES,
      });
      expect(result.ok).toBe(true);
    });

    it('kind=files with out-of-scope path is rejected', () => {
      const result = validateReviewFindingsScope({
        findings: [{ location: 'src/bar.ts' }],
        reviewedFileScope: SCOPE_FILES,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.code).toBe('REVIEW_FINDING_OUT_OF_SCOPE');
    });

    it('kind=not_applicable always passes regardless of findings', () => {
      const result = validateReviewFindingsScope({
        findings: [{ location: 'src/anywhere/Secret.ts' }],
        reviewedFileScope: { kind: 'not_applicable', reason: 'architecture_obligation' },
      });
      expect(result.ok).toBe(true);
    });

    it('kind=unavailable yields scope_unverifiable', () => {
      const result = validateReviewFindingsScope({
        findings: [{ location: 'src/foo.ts' }],
        reviewedFileScope: { kind: 'unavailable', reason: 'diff_resolution_failed' },
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.code).toBe('REVIEW_FINDING_SCOPE_UNVERIFIABLE');
    });

    it('empty files array rejects any finding with a path', () => {
      const result = validateReviewFindingsScope({
        findings: [{ location: 'src/foo.ts' }],
        reviewedFileScope: { kind: 'files', paths: [] },
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.code).toBe('REVIEW_FINDING_OUT_OF_SCOPE');
    });

    it('empty files array passes findings without locations', () => {
      const result = validateReviewFindingsScope({
        findings: [{ message: 'no location' }],
        reviewedFileScope: { kind: 'files', paths: [] },
      });
      expect(result.ok).toBe(true);
    });
  });
});
