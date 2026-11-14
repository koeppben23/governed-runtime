/**
 * Structural preflight contracts: evidence design, finding responses, claim lineage.
 * These tests prove declaration completeness only, never semantic sufficiency.
 */
import { describe, expect, it } from 'vitest';
import {
  mintProofGraphClaimId,
  type PlanClaimDeclaration,
} from '../../../state/proofgraph-approval.js';
import type { ReviewFindings } from '../../../state/evidence.js';
import type { VerificationCandidate } from '../../../state/discovery-schemas.js';
import { runPlanPreflight } from './plan-preflight.js';

const witness = {
  providerId: 'junit',
  localId: 'com.example.SessionTest#rejectInvalidState',
} as const;

function claim(
  statement: string,
  overrides: Partial<PlanClaimDeclaration> = {},
): PlanClaimDeclaration {
  const authoritySectionId = overrides.authoritySectionId ?? 'implementation-step-1';
  return {
    claimId: mintProofGraphClaimId({ domain: 'plan', authoritySectionId, statement }),
    statement,
    critical: true,
    claimScope: 'specific_behavior',
    authoritySectionId,
    expectedCheckId: 'test',
    counterexampleRequirement: {
      kind: 'assertion',
      checkId: 'build',
      assertion: witness,
    },
    ...overrides,
  };
}

const candidate = (kind: string, candidateId: string): VerificationCandidate =>
  ({
    candidateId,
    kind,
    command: `npm run ${kind}`,
    source: 'package.json',
    confidence: 'high',
    reason: 'fixture',
    assertionCapability: 'structured',
    assertionReport: { providerId: 'junit', transport: 'stdout', format: 'junit-xml' },
  }) as VerificationCandidate;

const candidates = [candidate('test', 'vc-test'), candidate('build', 'vc-build')];

function designMany(
  claims: readonly { readonly statement: string; readonly authoritySectionId: string }[],
  patch: Record<string, string> = {},
): string {
  return [
    '```flowguard-evidence-design',
    JSON.stringify({
      version: 1,
      claims: claims.map((claim) => ({
        authoritySectionId: claim.authoritySectionId,
        statement: claim.statement,
        positiveObservable: 'the positive test observes rejection',
        faultyVariant: 'remove the validation that rejects invalid state',
        expectedFailure: 'the bound assertion fails',
        executionRoute: 'vc-build',
        ...patch,
      })),
    }),
    '```',
  ].join('\n');
}

function design(statement: string, patch: Record<string, string> = {}): string {
  return designMany([{ statement, authoritySectionId: 'implementation-step-1' }], patch);
}

function finding(id: string): ReviewFindings['blockingIssues'][number] {
  const location = { path: 'src/foo.ts', revision: 'head' as const };
  return {
    findingId: id,
    severity: 'critical',
    category: 'correctness',
    message: 'missing evidence',
    relation: {
      subjectAnchors: [{ kind: 'repository_location', location }],
      evidenceLocations: [],
    },
  };
}

const obligation = {
  obligationId: '11111111-1111-4111-8111-111111111111',
  iteration: 0,
  planVersion: 1,
};

describe('plan preflight evidence design', () => {
  it('accepts a complete design for every critical claim', () => {
    const critical = claim('Invalid state is rejected.');
    expect(
      runPlanPreflight({
        planText: design(critical.statement),
        currentClaims: [critical],
        priorClaims: [],
        verificationCandidates: candidates,
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('requires a design block when a critical claim exists', () => {
    const critical = claim('Invalid state is rejected.');
    const result = runPlanPreflight({
      planText: '# Plan',
      currentClaims: [critical],
      priorClaims: [],
      verificationCandidates: candidates,
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.code).toBe('PLAN_EVIDENCE_DESIGN_REQUIRED');
  });

  it('rejects placeholders and a route that does not name the active candidate', () => {
    const critical = claim('Invalid state is rejected.');
    for (const patch of [{ faultyVariant: 'TBD' }, { executionRoute: 'some other check' }]) {
      const result = runPlanPreflight({
        planText: design(critical.statement, patch),
        currentClaims: [critical],
        priorClaims: [],
        verificationCandidates: candidates,
      });
      expect(result.kind).toBe('blocked');
    }
  });
});

describe('plan preflight claim lineage', () => {
  const prior = claim('Invalid state is rejected.');

  it('accepts an unchanged retained critical claim without a ledger', () => {
    expect(
      runPlanPreflight({
        planText: design(prior.statement),
        currentClaims: [prior],
        priorClaims: [prior],
        verificationCandidates: candidates,
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('forbids a same-identity critical downgrade', () => {
    const downgraded = { ...prior, critical: false };
    const result = runPlanPreflight({
      planText: design(prior.statement),
      currentClaims: [downgraded],
      priorClaims: [prior],
      verificationCandidates: candidates,
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked')
      expect(result.code).toBe('PLAN_CRITICAL_CLAIM_DOWNGRADE_FORBIDDEN');
  });

  it('requires a withdrawal declaration when a prior critical claim disappears', () => {
    const result = runPlanPreflight({
      planText: '# Plan',
      currentClaims: [],
      priorClaims: [prior],
      verificationCandidates: candidates,
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.code).toBe('PLAN_CLAIM_LINEAGE_REQUIRED');
  });

  it('supports one-to-many critical replacement', () => {
    const first = claim('Invalid identifiers are rejected.', {
      authoritySectionId: 'implementation-step-2',
    });
    const second = claim('Missing identifiers return not found.', {
      authoritySectionId: 'implementation-step-2',
    });
    const block = [
      '```flowguard-claim-changes',
      JSON.stringify({
        version: 1,
        claimChanges: [
          {
            priorClaimId: prior.claimId,
            disposition: 'replaced',
            replacementClaims: [
              { authoritySectionId: first.authoritySectionId, statement: first.statement },
              { authoritySectionId: second.authoritySectionId, statement: second.statement },
            ],
            rationale: 'split into two precise critical claims',
          },
        ],
      }),
      '```',
    ].join('\n');
    const planText = `${designMany([first, second])}\n${block}`;
    const result = runPlanPreflight({
      planText,
      currentClaims: [first, second],
      priorClaims: [prior],
      verificationCandidates: candidates,
    });
    expect(result).toEqual({ kind: 'ok' });
  });

  it('rejects a replaced declaration when the prior identity still exists', () => {
    const block = [
      '```flowguard-claim-changes',
      JSON.stringify({
        version: 1,
        claimChanges: [
          {
            priorClaimId: prior.claimId,
            disposition: 'replaced',
            replacementClaims: [
              { authoritySectionId: prior.authoritySectionId, statement: prior.statement },
            ],
            rationale: 'contradictory declaration',
          },
        ],
      }),
      '```',
    ].join('\n');
    const result = runPlanPreflight({
      planText: `${design(prior.statement)}\n${block}`,
      currentClaims: [prior],
      priorClaims: [prior],
      verificationCandidates: candidates,
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.code).toBe('PLAN_CLAIM_LINEAGE_INVALID');
  });

  it('accepts a withdrawn claim with rationale', () => {
    const block = [
      '```flowguard-claim-changes',
      JSON.stringify({
        version: 1,
        claimChanges: [
          { priorClaimId: prior.claimId, disposition: 'withdrawn', rationale: 'ticket withdrawn' },
        ],
      }),
      '```',
    ].join('\n');
    expect(
      runPlanPreflight({
        planText: `# Plan\n\n${block}`,
        currentClaims: [],
        priorClaims: [prior],
        verificationCandidates: candidates,
      }),
    ).toEqual({ kind: 'ok' });
  });
});

describe('plan preflight finding responses', () => {
  const prior = claim('Invalid state is rejected.');
  const findingId = '33333333-3333-4333-8333-333333333333';

  it('requires a response for every bound blocking finding', () => {
    const result = runPlanPreflight({
      planText: design(prior.statement),
      currentClaims: [prior],
      priorClaims: [prior],
      verificationCandidates: candidates,
      priorBlockingFindings: [finding(findingId)],
      reviewObligation: obligation,
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.code).toBe('PLAN_FINDING_RESOLUTION_REQUIRED');
  });

  it('accepts a reasoned clarification without requiring a text change', () => {
    const block = [
      '```flowguard-finding-resolutions',
      JSON.stringify({
        version: 1,
        reviewObligationId: obligation.obligationId,
        reviewIteration: obligation.iteration,
        planVersion: obligation.planVersion,
        resolutions: [
          {
            findingId,
            planSection: '## Verification',
            response: 'The existing section already names the exact assertion; no edit is needed.',
          },
        ],
      }),
      '```',
    ].join('\n');
    expect(
      runPlanPreflight({
        planText: `${design(prior.statement)}\n${block}`,
        currentClaims: [prior],
        priorClaims: [prior],
        verificationCandidates: candidates,
        priorBlockingFindings: [finding(findingId)],
        reviewObligation: obligation,
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('rejects a ledger bound to the new plan version instead of the review obligation', () => {
    const block = [
      '```flowguard-finding-resolutions',
      JSON.stringify({
        version: 1,
        reviewObligationId: obligation.obligationId,
        reviewIteration: obligation.iteration,
        planVersion: 2,
        resolutions: [{ findingId, planSection: '## Verification', response: 'addressed' }],
      }),
      '```',
    ].join('\n');
    const result = runPlanPreflight({
      planText: `${design(prior.statement)}\n${block}`,
      currentClaims: [prior],
      priorClaims: [prior],
      verificationCandidates: candidates,
      priorBlockingFindings: [finding(findingId)],
      reviewObligation: obligation,
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.code).toBe('PLAN_FINDING_RESOLUTION_INVALID');
  });
});
