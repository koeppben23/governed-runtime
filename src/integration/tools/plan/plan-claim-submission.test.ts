import { describe, expect, it } from 'vitest';
import { classifyPlanClaimSubmission } from './plan-claim-submission.js';
import { makeState, PLAN_RECORD } from '../../../fixtures.js';
import { canonicalJsonStringify } from '../../../shared/canonical-json.js';
import { hashText } from '../../../shared/hashing.js';
import { normalizePlanClaims } from '../../../state/proofgraph-approval.js';
import type { PlanArgs } from './plan-types.js';
import { formatBlocked } from '../../blocked-result.js';

const claim = {
  statement: 'the API rejects invalid requests',
  critical: false,
  claimScope: 'specific_behavior' as const,
  expectedCheckId: 'test',
  authoritySectionId: 'step-1',
};
const state = makeState('TICKET', {
  activeChecks: ['test'],
  verificationCandidates: [
    {
      candidateId: 'vc_test_junit',
      kind: 'test',
      command: 'npm test',
      source: 'package.json:scripts.test',
      confidence: 'high',
      reason: 'test script',
      assertionCapability: 'structured',
      assertionReport: {
        collection: 'snapshot_diff',
        transport: 'file',
        format: 'junit_xml',
        providerId: 'junit',
        standardPatterns: ['reports/TEST-*.xml'],
      },
    },
  ],
});

describe('plan claim admission boundary', () => {
  it('retains valid declarations and filters only nonblocking unsatisfiable declarations', () => {
    const args: PlanArgs = {
      planText: '## Plan',
      claims: [
        claim,
        {
          ...claim,
          statement: 'mutation evidence proves the suite',
          mutationProfile: 'proofgraph-evaluator',
        },
      ],
    };
    const result = classifyPlanClaimSubmission(args, state, hashText);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.args.claims).toEqual([claim]);
    expect(result.diagnostics?.rejectedClaims).toMatchObject([
      { disposition: 'rejected_non_blocking' },
    ]);
    expect(result.diagnostics?.submittedClaimDeclarationsDigest).toBe(
      hashText(
        canonicalJsonStringify({
          flow: 'plan',
          version: 'v2',
          claims: normalizePlanClaims(args.claims),
        }),
      ),
    );
    expect(result.diagnostics?.acceptedClaimDeclarationsDigest).toBe(
      hashText(
        canonicalJsonStringify({
          flow: 'plan',
          version: 'v2',
          claims: normalizePlanClaims([claim]),
        }),
      ),
    );
  });

  it.each([true, false])(
    'blocks incomplete declarations regardless of criticality (%s)',
    (critical) => {
      const result = classifyPlanClaimSubmission(
        { claims: [{ ...claim, critical, expectedCheckId: 'inactive' }] },
        state,
        hashText,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind !== 'blocked') return;
      const response = JSON.parse(result.message);
      expect(response.error).toBe(true);
      expect(response.code).toBe('PROOFGRAPH_CLAIM_NOT_DECLARED');
      expect(response.claimSubmissionDiagnostics.rejectedClaims).toMatchObject([
        { critical, disposition: 'rejected_blocking' },
      ]);
      expect(response.presentation.markdown).toContain('blocked');
    },
  );

  it('preserves set-level error precedence', () => {
    const result = classifyPlanClaimSubmission({ claims: [claim, claim] }, state, hashText);
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(JSON.parse(result.message).code).toBe('PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE');
  });

  it('appends every rejection cause and recovery while preserving the canonical blocked envelope', () => {
    const before = canonicalJsonStringify(state);
    const result = classifyPlanClaimSubmission(
      {
        claims: [
          {
            ...claim,
            critical: true,
            counterexampleRequirement: { kind: 'aggregate_check', checkId: 'test' },
          },
          { ...claim, statement: 'request validation is complete', expectedCheckId: 'inactive' },
        ],
      },
      state,
      hashText,
    );
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    const response = JSON.parse(result.message);
    const rejected = response.claimSubmissionDiagnostics.rejectedClaims;
    expect(rejected).toHaveLength(2);
    expect(rejected[0].reason).toContain('assertion counterexample requirement');
    expect(rejected[1].reason).toContain('expectedCheckId');
    expect(rejected[1].reason).toContain('not an active check');
    for (const entry of rejected) {
      expect(response.presentation.markdown).toContain(entry.statement);
      expect(response.presentation.markdown).toContain(entry.disposition);
      expect(response.presentation.markdown).toContain(entry.reason);
      for (const step of entry.recovery) expect(response.presentation.markdown).toContain(step);
    }
    const canonical = JSON.parse(
      formatBlocked('PROOFGRAPH_CLAIM_NOT_DECLARED', {
        claimRef: rejected[0].claimRef,
        field: 'declaration admission',
        detail:
          'blocking declarations must be corrected or explicitly withdrawn before admitting this revision',
        consequence: 'No plan version or independent review was created by this rejected call.',
      }),
    );
    expect(response.presentation.markdown.startsWith(canonical.presentation.markdown)).toBe(true);
    for (const key of [
      'error',
      'code',
      'message',
      'recovery',
      'quickFix',
      'diagnostics',
      'headline',
    ]) {
      expect(response[key]).toEqual(canonical[key]);
    }
    expect(response.claimSubmissionDiagnosticsOrigin).toBe('submitted');
    expect(canonicalJsonStringify(state)).toBe(before);
  });

  it('blocks carried diagnostics but honors explicit withdrawal and fresh valid replacement', () => {
    const invalid = classifyPlanClaimSubmission(
      { claims: [{ ...claim, critical: true }] },
      state,
      hashText,
    );
    expect(invalid.kind).toBe('blocked');
    if (invalid.kind !== 'blocked') return;
    const prior = makeState('PLAN', {
      ...state,
      phase: 'PLAN',
      plan: {
        ...PLAN_RECORD,
        claimSubmissionDiagnostics: JSON.parse(invalid.message).claimSubmissionDiagnostics,
      },
    });
    const before = canonicalJsonStringify(prior);
    const carried = classifyPlanClaimSubmission({}, prior, hashText);
    expect(carried.kind).toBe('blocked');
    if (carried.kind !== 'blocked') return;
    const response = JSON.parse(carried.message);
    expect(response.claimSubmissionDiagnosticsOrigin).toBe('historical');
    expect(response.presentation.markdown).toContain(
      'Historical rejected declarations (carried over)',
    );
    expect(response.claimSubmissionDiagnostics).toEqual(prior.plan?.claimSubmissionDiagnostics);
    for (const entry of response.claimSubmissionDiagnostics.rejectedClaims) {
      expect(response.presentation.markdown).toContain(entry.reason);
      for (const step of entry.recovery) expect(response.presentation.markdown).toContain(step);
    }
    expect(canonicalJsonStringify(prior)).toBe(before);
    expect(classifyPlanClaimSubmission({ claims: [] }, prior, hashText)).toEqual({
      kind: 'ok',
      args: { claims: [] },
    });
    expect(classifyPlanClaimSubmission({ claims: [claim] }, prior, hashText)).toEqual({
      kind: 'ok',
      args: { claims: [claim] },
    });
  });
});
