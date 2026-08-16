/**
 * Architecture ProofGraph materialization (#762).
 *
 * The decisive property under test is negative: an approved ADR claim must be
 * visible and certificate-bound, yet must NEVER be able to block a gate. An ADR
 * claim binds to named review evidence, which no provider can execute; had it
 * been classified as `fact`, an enabled policy would block every architecture
 * approval forever.
 */

import { describe, expect, it } from 'vitest';
import { ARCHITECTURE_DECISION, makeState } from '../../fixtures.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';
import type { SessionState } from '../../state/schema.js';
import { evaluateProofGraphGate } from '../../audit/proofgraph/gate.js';
import { summarizeProofGraph } from '../../audit/proofgraph/summary.js';
import { materializeApprovedArchitectureContractResult } from './materialize-architecture.js';

const CLAIM_ID = '55555555-5555-4555-8555-555555555555';
const CERTIFICATE_ID = '66666666-6666-4666-8666-666666666666';

const DECLARATIONS = {
  flow: 'architecture' as const,
  claims: [
    {
      claimId: CLAIM_ID,
      statement: 'Null-safety is enforced at the service method boundary.',
      critical: true,
      authoritySectionId: 'decision',
      requiredReviewEvidence: ['service-layer-review'],
    },
  ],
};

function approvedState(overrides: Partial<SessionState> = {}): SessionState {
  return makeState('ARCH_COMPLETE', {
    architecture: {
      ...ARCHITECTURE_DECISION,
      claimDeclarations: DECLARATIONS,
      approvalCertificate: {
        flow: 'architecture',
        authorityDigest: ARCHITECTURE_DECISION.digest,
        claimDeclarationsDigest: hashText(canonicalJsonStringify(DECLARATIONS)),
        decisionAttestationDigest: 'c'.repeat(64),
        approvedAt: '2026-01-01T00:00:00.000Z',
        approvedBy: 'approver',
        certificateId: CERTIFICATE_ID,
        reviewBinding: {
          kind: 'current_review',
          reviewObligationId: '77777777-7777-4777-8777-777777777777',
          reviewEvidenceDigest: 'e'.repeat(64),
          reviewedSubjectDigest: ARCHITECTURE_DECISION.digest,
        },
      },
    },
    ...overrides,
  });
}

describe('materializeApprovedArchitectureContractResult', () => {
  it('binds each claim to the approval certificate as provenance', () => {
    const { contract, coverage } = materializeApprovedArchitectureContractResult(approvedState());

    expect(coverage).toEqual([]);
    expect(contract.claims).toHaveLength(1);
    expect(contract.claims[0]?.provenance).toMatchObject({
      kind: 'canonical_authority',
      authorityId: 'architecture',
      digest: ARCHITECTURE_DECISION.digest,
      approval: { certificateId: CERTIFICATE_ID, declarationId: CLAIM_ID },
    });
  });

  it('classifies ADR claims as derived_signal, never as blocking facts', () => {
    const { contract } = materializeApprovedArchitectureContractResult(approvedState());
    expect(contract.claims[0]?.signalClass).toBe('derived_signal');
  });

  it('never presents named review evidence as executable evidence', () => {
    const { contract } = materializeApprovedArchitectureContractResult(approvedState());
    expect(contract.claims[0]?.evidenceRefs).toEqual([]);
    expect(contract.claims[0]?.counterexampleRefs).toEqual([]);
  });

  it('records missing declarations instead of implying coverage', () => {
    const state = makeState('ARCH_COMPLETE', { architecture: ARCHITECTURE_DECISION });
    const { contract, coverage } = materializeApprovedArchitectureContractResult(state);
    expect(contract.claims).toEqual([]);
    expect(coverage).toEqual([{ cause: 'missing_declarations' }]);
  });

  it('rejects a certificate bound to a superseded ADR digest', () => {
    const state = approvedState();
    const stale: SessionState = {
      ...state,
      architecture: {
        ...state.architecture!,
        approvalCertificate: {
          ...state.architecture!.approvalCertificate!,
          authorityDigest: 'superseded-digest',
        },
      },
    };
    expect(materializeApprovedArchitectureContractResult(stale).coverage).toEqual([
      { cause: 'invalid_certificate' },
    ]);
  });

  it('rejects a certificate whose declaration digest does not match', () => {
    const state = approvedState();
    const tampered: SessionState = {
      ...state,
      architecture: {
        ...state.architecture!,
        approvalCertificate: {
          ...state.architecture!.approvalCertificate!,
          claimDeclarationsDigest: 'd'.repeat(64),
        },
      },
    };
    expect(materializeApprovedArchitectureContractResult(tampered).coverage).toEqual([
      { cause: 'invalid_certificate' },
    ]);
  });

  it('records a missing certificate rather than materializing unapproved claims', () => {
    const state = approvedState();
    const unapproved: SessionState = {
      ...state,
      architecture: { ...state.architecture!, approvalCertificate: undefined },
    };
    const { contract, coverage } = materializeApprovedArchitectureContractResult(unapproved);
    expect(contract.claims).toEqual([]);
    expect(coverage).toEqual([{ cause: 'missing_certificate' }]);
  });
});

describe('architecture claims never gate an approval', () => {
  it('leaves the gate open even when a critical ADR claim is unproven', () => {
    const state = approvedState();
    const { contract } = materializeApprovedArchitectureContractResult(state);
    const summary = summarizeProofGraph(
      { ...state, proofContract: contract },
      '2026-01-01T00:00:00.000Z',
    );

    // The claim is critical and NOT proven — the exact shape that blocks a fact.
    expect(summary.projection.claims[0]?.critical).toBe(true);
    expect(summary.projection.claims[0]?.verificationState).not.toBe('PROVEN');

    const decision = evaluateProofGraphGate(summary);
    expect(decision.gated).toBe(false);
    expect(decision.blockingClaimIds).toEqual([]);
  });
});
