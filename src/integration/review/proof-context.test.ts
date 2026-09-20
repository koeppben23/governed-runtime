/**
 * Reviewer-facing ProofGraph context sections (#762).
 *
 * The host-task Task prompt is the prompt the reviewer actually receives under
 * `host_task_*` policy. These tests pin that it carries the same ProofGraph
 * context as the SDK path — the regression that made ProofGraph invisible to
 * every reviewer while the feature looked complete in the SDK builders.
 */

import { describe, expect, it } from 'vitest';
import { makeState, PLAN_RECORD, ARCHITECTURE_DECISION } from '../../fixtures.js';
import type { SessionState } from '../../state/schema.js';
import type { ProofGraphProjection } from '../../state/proofgraph.js';
import { evaluateProofGraphGate } from '../../audit/proofgraph/gate.js';
import { renderPlanClaimDeclarations } from '../../presentation/index.js';
import {
  buildReviewerProofContext as rawBuildReviewerProofContext,
  renderCoverageGaps,
  renderDeclarationPreview as rawRenderDeclarationPreview,
  renderPersistedProofGraphContext,
} from './proof-context.js';

const authorities = { evaluateProofGraphGate, renderPlanClaimDeclarations };

function renderDeclarationPreview(state: SessionState): string[] {
  return rawRenderDeclarationPreview(state, authorities);
}

function buildReviewerProofContext(state: SessionState): string[] {
  return rawBuildReviewerProofContext(state, authorities);
}

const CLAIM_ID = '33333333-3333-4333-8333-333333333333';

function projection(claims: ProofGraphProjection['claims'] = []): ProofGraphProjection {
  return { version: 'proofgraph.v2', evaluatedAt: '2026-01-01T00:00:00.000Z', claims };
}

function provenClaim(overrides: Partial<ProofGraphProjection['claims'][number]> = {}) {
  return {
    claimId: CLAIM_ID,
    statement: 'updateTask rejects unknown ids',
    signalClass: 'fact' as const,
    critical: true,
    verificationState: 'PROVEN' as const,
    provenance: null,
    evidenceRefs: [],
    counterexampleRefs: [],
    ...overrides,
  } as ProofGraphProjection['claims'][number];
}

describe('renderPersistedProofGraphContext', () => {
  it('reports NOT_DECLARED when no projection is persisted', () => {
    expect(renderPersistedProofGraphContext(undefined).join('\n')).toContain(
      'Coverage: NOT_DECLARED',
    );
  });

  it('lists critical unresolved claims with state and id', () => {
    const text = renderPersistedProofGraphContext(
      projection([provenClaim({ verificationState: 'UNPROVEN' })]),
    ).join('\n');
    expect(text).toContain('Critical unresolved claims:');
    expect(text).toContain(`[UNPROVEN] ${CLAIM_ID}`);
  });

  it('states explicitly that no critical claim is unresolved', () => {
    const text = renderPersistedProofGraphContext(projection([provenClaim()])).join('\n');
    expect(text).toContain('Critical unresolved claims: none recorded.');
  });
});

describe('renderDeclarationPreview', () => {
  const planState: SessionState = makeState('PLAN_REVIEW', {
    plan: {
      ...PLAN_RECORD,
      claimDeclarations: {
        flow: 'plan',
        version: 'v2',
        claims: [
          {
            claimId: CLAIM_ID,
            statement: 'updateTask rejects unknown ids',
            critical: true,
            authoritySectionId: 'implementation-step-1',
            claimScope: 'specific_behavior',
            expectedCheckId: 'build',
          },
        ],
      },
    },
  });

  it('renders plan declarations as intent, never as evidence', () => {
    const text = renderDeclarationPreview(planState).join('\n');
    expect(text).toContain('These are stated intent, NOT evidence.');
    expect(text).toContain('Plan claim declarations (1)');
    expect(text).toContain('Expected check: build');
  });

  it('marks declarations as not certificate-bound before approval', () => {
    expect(renderDeclarationPreview(planState).join('\n')).toContain(
      'Plan approval certificate: none recorded',
    );
  });

  it('surfaces the certificate binding once approval exists', () => {
    const certified: SessionState = {
      ...planState,
      plan: {
        ...planState.plan!,
        approvalCertificate: {
          flow: 'plan',
          authorityDigest: 'authority-digest',
          claimDeclarationsDigest: 'declarations-digest',
          decisionAttestationDigest: 'decision-digest',
          approvedAt: '2026-01-01T00:00:00.000Z',
          approvedBy: 'approver',
          certificateId: '44444444-4444-4444-8444-444444444444',
          planVersion: 1,
          planRecordDigest: 'record-digest',
          reviewBinding: {
            kind: 'current_review',
            reviewObligationId: '55555555-5555-4555-8555-555555555555',
            reviewEvidenceDigest: 'review-evidence-digest',
            reviewedSubjectDigest: 'authority-digest',
          },
        },
      },
    };
    const text = renderDeclarationPreview(certified).join('\n');
    expect(text).toContain('44444444-4444-4444-8444-444444444444');
    expect(text).toContain('claimDeclarationsDigest declarations-digest');
  });

  it('renders architecture declarations with their review evidence', () => {
    const archState = makeState('ARCH_REVIEW', {
      architecture: {
        ...ARCHITECTURE_DECISION,
        claimDeclarations: {
          flow: 'architecture',
          claims: [
            {
              claimId: CLAIM_ID,
              statement: 'null-checks live in the service layer',
              critical: true,
              authoritySectionId: 'decision',
              requiredReviewEvidence: ['service-layer-review'],
            },
          ],
        },
      },
    });
    const text = renderDeclarationPreview(archState).join('\n');
    expect(text).toContain('Architecture claim declarations (1)');
    expect(text).toContain('required review evidence: service-layer-review');
  });

  it('renders counterexample requirement with assertion suffix', () => {
    const state: SessionState = {
      ...planState,
      plan: {
        ...planState.plan!,
        claimDeclarations: {
          flow: 'plan',
          version: 'v2',
          claims: [
            {
              claimId: CLAIM_ID,
              statement: 'counterexample claim',
              critical: true,
              authoritySectionId: 's1',
              claimScope: 'specific_behavior',
              expectedCheckId: 'build',
              counterexampleRequirement: {
                kind: 'assertion',
                checkId: 'security',
                assertion: { providerId: 'junit', localId: 'my-test' },
              },
            },
          ],
        },
      },
    };
    const text = renderDeclarationPreview(state).join('\n');
    expect(text).toContain(
      'Counterexample requirement: security; assertion providerId: junit; localId: my-test',
    );
  });

  it('renders counterexample requirement with explicit assertionId', () => {
    const state: SessionState = {
      ...planState,
      plan: {
        ...planState.plan!,
        claimDeclarations: {
          flow: 'plan',
          version: 'v2',
          claims: [
            {
              claimId: CLAIM_ID,
              statement: 'counterexample claim with explicit assertion',
              critical: true,
              authoritySectionId: 's1',
              claimScope: 'specific_behavior',
              expectedCheckId: 'build',
              counterexampleRequirement: {
                kind: 'assertion',
                checkId: 'security',
                assertion: { providerId: 'junit', localId: 'com.example.Test#method' },
              },
            },
          ],
        },
      },
    };
    const text = renderDeclarationPreview(state).join('\n');
    expect(text).toContain(
      'Counterexample requirement: security; assertion providerId: junit; localId: com.example.Test#method',
    );
  });

  it('renders nothing when no declarations exist', () => {
    expect(renderDeclarationPreview(makeState('READY'))).toEqual([]);
  });
});

describe('renderCoverageGaps', () => {
  it('surfaces recorded gaps with their cause and claim', () => {
    const state = makeState('IMPL_REVIEW', {
      proofContractCoverage: [{ claimId: CLAIM_ID, cause: 'missing_expected_check' }],
    });
    const text = renderCoverageGaps(state).join('\n');
    expect(text).toContain('missing_expected_check');
    expect(text).toContain(CLAIM_ID);
  });

  it('renders nothing when no gaps were recorded', () => {
    expect(renderCoverageGaps(makeState('READY'))).toEqual([]);
  });
});
