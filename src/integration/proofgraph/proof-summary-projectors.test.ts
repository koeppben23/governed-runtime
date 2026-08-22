/**
 * @test-policy
 * PROJECTORS: projectImplementationProofStatus reports NOT_DECLARED for an empty proofGraph,
 *             evaluation presentation for non-empty with correct tallies and headline.
 * CORNER: PROVEN all-facts -> headline is PROVEN.
 * CORNER: CONTRADICTED -> headline is CONTRADICTED, decisionContext at gate.
 * CORNER: STALE -> evidenceFreshness is STALE.
 * EDGE: No proofGraph claims -> null.
 */

import { describe, expect, it } from 'vitest';

import { makeState, PLAN_RECORD } from '../../fixtures.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';
import {
  projectImplementationProofStatus,
  projectCompletionProofStatus,
  projectProofStatusForState,
} from './proof-summary-projectors.js';
import type { ProofClaim } from '../../state/proofgraph.js';
import type { SessionState } from '../../state/schema.js';

function proofClaim(opts: {
  claimId: string;
  statement: string;
  critical: boolean;
  verificationState: ProofClaim['verificationState'];
  freshness?: ProofClaim['freshness'];
}): ProofClaim {
  return {
    claimId: opts.claimId,
    statement: opts.statement,
    signalClass: 'fact',
    critical: opts.critical,
    provenance: {
      kind: 'canonical_authority',
      authorityId: 'plan',
      digest: 'aaaa'.repeat(16),
      approval: {
        certificateId: '11111111-1111-1111-1111-111111111111',
        claimDeclarationsDigest: 'b'.repeat(64),
        decisionAttestationDigest: 'c'.repeat(64),
        declarationId: '22222222-2222-2222-2222-222222222222',
      },
    },
    evidenceRefs: [],
    counterexampleRefs: [],
    verificationState: opts.verificationState,
    freshness: opts.freshness,
  };
}

function makeEvalState(claims: ProofClaim[]): SessionState {
  const base = makeState('IMPLEMENTATION');
  const claimDeclarations = {
    flow: 'plan' as const,
    version: 'v2' as const,
    claims: claims.map((claim) => ({
      claimId: claim.claimId,
      statement: claim.statement,
      critical: claim.critical,
      claimScope: 'specific_behavior' as const,
      expectedCheckId: 'check-1',
      authoritySectionId: 'sec-1',
      counterexampleRequirement: {
        kind: 'assertion' as const,
        checkId: 'check-2',
        assertion: { providerId: 'junit' as const, localId: 'com.example.Test#counterexample' },
      },
    })),
  };
  return {
    ...base,
    proofGraph: { version: 'proofgraph.v1' as const, claims, evaluatedAt: '2025-01-01T00:00:00Z' },
    implementation: {
      digest: 'abc123',
      files: [{ path: 'src/foo.ts', status: 'modified' as const, contentHash: 'abc' }],
      history: [
        {
          kind: 'impl_record' as const,
          id: 'evt-1',
          ts: '2025-01-01T00:00:00Z',
          phase: 'IMPLEMENTATION',
          digest: 'abc123',
        },
      ],
    },
    plan: {
      ...PLAN_RECORD,
      claimDeclarations,
      approvalCertificate: {
        flow: 'plan' as const,
        authorityDigest: PLAN_RECORD.current.digest,
        claimDeclarationsDigest: hashText(canonicalJsonStringify(claimDeclarations)),
        decisionAttestationDigest: 'd'.repeat(64),
        approvedAt: '2025-01-01T00:00:00.000Z',
        approvedBy: 'test-approver',
        certificateId: '11111111-1111-4111-8111-111111111111',
        planVersion: PLAN_RECORD.current.planVersion,
        planRecordDigest: PLAN_RECORD.current.recordDigest,
        reviewBinding: {
          kind: 'current_review' as const,
          reviewObligationId: '11111111-1111-4111-8111-111111111112',
          reviewEvidenceDigest: 'e'.repeat(64),
          reviewedSubjectDigest: PLAN_RECORD.current.digest,
        },
        reviewObligationId: '11111111-1111-4111-8111-111111111112',
        reviewEvidenceDigest: 'e'.repeat(64),
      },
    },
    implementationRiskAssessment: undefined,
  } as unknown as SessionState;
}

describe('projectProofStatusForState', () => {
  it('uses declared plan claims at PLAN_REVIEW before ProofGraph materialization', () => {
    const state = {
      ...makeState('PLAN_REVIEW'),
      plan: {
        ...PLAN_RECORD,
        claimDeclarations: {
          flow: 'plan' as const,
          claims: [
            {
              claimId: '00000000-0000-0000-0000-000000000099',
              statement: 'Declared plan claim',
              critical: true,
              expectedCheckId: 'check-1',
              authoritySectionId: 'sec-1',
            },
          ],
        },
      },
      proofGraph: undefined,
    } as SessionState;

    expect(projectProofStatusForState(state)).toMatchObject({
      kind: 'declaration',
      overallStatus: 'AWAITING_EVIDENCE',
      claimCount: 1,
    });
  });
});

describe('projectImplementationProofStatus', () => {
  it('returns null when proofGraph has no claims', () => {
    const state: SessionState = {
      ...makeState('IMPLEMENTATION'),
      proofGraph: undefined,
    };
    expect(projectImplementationProofStatus(state).overallStatus).toBe('NOT_DECLARED');
  });

  it('returns evaluation for PROVEN claims', () => {
    const claims = [
      proofClaim({
        claimId: '11111111-1111-1111-1111-111111111111',
        statement: 'Claim 1',
        critical: true,
        verificationState: 'PROVEN',
        freshness: { boundDigest: 'abc', evaluatedAt: '2025-01-01T00:00:00Z', stale: false },
      }),
    ];
    const result = projectImplementationProofStatus(makeEvalState(claims));
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('evaluation');
    expect((result as Record<string, unknown>).headlineStatus).toBe('PROVEN');
    expect((result as Record<string, unknown>).provenCount).toBe(1);
  });

  it('returns CONTRADICTED headline when a claim is contradicted', () => {
    const claims = [
      proofClaim({
        claimId: '22222222-2222-2222-2222-222222222222',
        statement: 'Falsified claim',
        critical: true,
        verificationState: 'CONTRADICTED',
      }),
    ];
    const result = projectImplementationProofStatus(makeEvalState(claims));
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).headlineStatus).toBe('CONTRADICTED');
  });

  it('surfaces highlighted claims with reason and recovery for CONTRADICTED', () => {
    const claims = [
      proofClaim({
        claimId: '33333333-3333-3333-3333-333333333333',
        statement: 'No privilege escalation.',
        critical: true,
        verificationState: 'CONTRADICTED',
      }),
    ];
    const result = projectImplementationProofStatus(makeEvalState(claims));
    expect(result).not.toBeNull();
    const evalResult = result as Record<string, unknown>;
    const highlighted = evalResult.unmetCriticalClaims as
      Array<Record<string, unknown>> | undefined;
    expect(highlighted).toBeDefined();
    const first = highlighted?.[0];
    expect(first).toBeDefined();
    expect(String(first!.reason)).toBe('Fresh adversarial evidence falsified this claim.');
    expect(first!.recovery).toBeDefined();
  });

  it('detects STALE evidence freshness', () => {
    const claims = [
      proofClaim({
        claimId: '44444444-4444-4444-4444-444444444444',
        statement: 'Stale claim',
        critical: true,
        verificationState: 'STALE',
        freshness: { boundDigest: 'old', evaluatedAt: '2025-01-01T00:00:00Z', stale: true },
      }),
    ];
    const result = projectImplementationProofStatus(makeEvalState(claims));
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).evidenceFreshness).toBe('STALE');
  });

  it('handles multiple claims with different states', () => {
    const claims = [
      proofClaim({
        claimId: '55555555-5555-5555-5555-555555555555',
        statement: 'Proven',
        critical: true,
        verificationState: 'PROVEN',
      }),
      proofClaim({
        claimId: '66666666-6666-6666-6666-666666666666',
        statement: 'Unproven',
        critical: true,
        verificationState: 'UNPROVEN',
      }),
    ];
    const result = projectImplementationProofStatus(makeEvalState(claims));
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).provenCount).toBe(1);
    expect((result as Record<string, unknown>).unprovenCount).toBe(1);
  });

  it('never includes PROVEN claims in highlightedClaims', () => {
    const claims = [
      proofClaim({
        claimId: 'aaaaaaaa-1111-1111-1111-111111111111',
        statement: 'CONTRADICTED claim',
        critical: true,
        verificationState: 'CONTRADICTED',
      }),
      proofClaim({
        claimId: 'bbbbbbbb-2222-2222-2222-222222222222',
        statement: 'PROVEN claim',
        critical: true,
        verificationState: 'PROVEN',
      }),
      proofClaim({
        claimId: 'cccccccc-3333-3333-3333-333333333333',
        statement: 'UNPROVEN claim',
        critical: true,
        verificationState: 'UNPROVEN',
      }),
      proofClaim({
        claimId: 'dddddddd-4444-4444-4444-444444444444',
        statement: 'PROVEN claim 2',
        critical: true,
        verificationState: 'PROVEN',
      }),
    ];
    const result = projectImplementationProofStatus(makeEvalState(claims));
    expect(result).not.toBeNull();
    const evalResult = result as Record<string, unknown>;
    const highlighted = evalResult.unmetCriticalClaims as
      Array<Record<string, unknown>> | undefined;
    expect(highlighted).toBeDefined();
    const first = highlighted?.[0];
    expect(first).toBeDefined();
    // Only non-PROVEN claims should appear
    const statuses = highlighted!.map((c) => c.status);
    expect(statuses).not.toContain('PROVEN');
    // CONTRADICTED has highest priority, should be first
    expect(String(first!.status)).toBe('CONTRADICTED');
  });

  it('returns null when proofGraph is undefined', () => {
    const state: SessionState = {
      ...makeState('IMPLEMENTATION'),
      proofGraph: undefined,
    };
    expect(projectImplementationProofStatus(state).overallStatus).toBe('NOT_DECLARED');
  });

  it('sets decisionContext to completion for projectCompletionProofStatus', () => {
    const claims = [
      proofClaim({
        claimId: '77777777-7777-7777-7777-777777777777',
        statement: 'Unproven claim',
        critical: true,
        verificationState: 'UNPROVEN',
      }),
    ];
    const result = projectCompletionProofStatus(makeEvalState(claims));
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).decisionContext).toBe('completion');
  });
});
