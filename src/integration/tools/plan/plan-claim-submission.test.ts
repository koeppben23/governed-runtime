import { describe, expect, it } from 'vitest';
import { classifyPlanClaimSubmission } from './plan-claim-submission.js';
import { makeState, PLAN_RECORD } from '../../../fixtures.js';
import { canonicalJsonStringify } from '../../../shared/canonical-json.js';
import { hashText } from '../../../shared/hashing.js';
import { normalizePlanClaims } from '../../../state/proofgraph-approval.js';
import type { PlanArgs } from './plan-types.js';

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
    expect(classifyPlanClaimSubmission({}, prior, hashText).kind).toBe('blocked');
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
