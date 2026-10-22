/**
 * Reviewer-facing ProofGraph context sections (#762).
 *
 * The host-task Task prompt is the prompt the reviewer actually receives under
 * `host_task_*` policy. These tests pin that it carries the same ProofGraph
 * context as the SDK path — the regression that made ProofGraph invisible to
 * every reviewer while the feature looked complete in the SDK builders.
 */

import { describe, expect, it } from 'vitest';
import {
  makePlanApprovalCertificate,
  makeState,
  PLAN_RECORD,
  ARCHITECTURE_DECISION,
} from '../../../fixtures.js';
import type { SessionState } from '../../../state/schema.js';
import type { ProofGraphProjection } from '../../../state/proofgraph.js';
import { evaluateProofGraphGate } from '../../../audit/proofgraph/gate.js';
import { renderPlanClaimDeclarations } from '../../../presentation/index.js';
import {
  buildReviewerProofContext as rawBuildReviewerProofContext,
  renderCoverageGaps,
  renderDeclarationPreview as rawRenderDeclarationPreview,
  renderImplementationRiskFocus,
  renderPersistedProofGraphContext,
} from './proof-context.js';
import { IMPL_EVIDENCE } from '../../../fixtures.js';

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
    expect(text).toContain('Positive evidence check: build');
  });

  it('omits the advisory preview when the frozen material carries the declarations', () => {
    // Plan/architecture artifact reviews embed the declarations section in
    // their frozen review material; the preview would be a verbatim duplicate.
    const withoutPreview = rawBuildReviewerProofContext(planState, authorities, {
      includeDeclarationPreview: false,
    }).join('\n');
    expect(withoutPreview).not.toContain('Plan claim declarations (1)');
    const withPreview = rawBuildReviewerProofContext(planState, authorities).join('\n');
    expect(withPreview).toContain('Plan claim declarations (1)');
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
        approvalCertificate: makePlanApprovalCertificate(planState, {
          claimDeclarationsDigest: 'declarations-digest',
        }),
      },
    };
    const text = renderDeclarationPreview(certified).join('\n');
    const certificateId = certified.plan?.approvalCertificate?.certificateId;
    expect(certificateId).toBeDefined();
    expect(text).toContain(certificateId!);
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
      'Counterexample (adversarial) check: security; assertion providerId: junit; localId: my-test',
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
      'Counterexample (adversarial) check: security; assertion providerId: junit; localId: com.example.Test#method',
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

describe('renderImplementationRiskFocus (#1081 risk-adaptive context)', () => {
  it('renders the digest-bound class, triggers, and surfaces as advisory focus', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      implementationRiskAssessment: {
        computedMinimumTaskClass: 'HIGH-RISK',
        effectiveTaskClass: 'HIGH-RISK',
        declaredTaskClass: 'STANDARD',
        declarationKind: 'declared',
        ticketDigest: 'ticket-digest',
        touchedSurfaces: ['State', 'Audit'],
        riskTriggers: ['state_integrity'],
        assessedFrom: 'implementation_changed_files',
        assessedFileCount: 2,
        implementationDigest: IMPL_EVIDENCE.digest,
      },
    });
    const text = renderImplementationRiskFocus(state).join('\n');
    expect(text).toContain('Implementation Risk Focus (persisted, advisory)');
    expect(text).toContain('Effective risk class: HIGH-RISK');
    expect(text).toContain('ticket-declared floor STANDARD');
    expect(text).toContain('Risk triggers: state_integrity');
    expect(text).toContain('Touched surfaces: State, Audit');
    expect(text).toContain('does not lower or raise any approval requirement');
  });

  it('marks a missing or stale assessment as NOT_VERIFIED instead of implying focus coverage', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      implementationRiskAssessment: {
        computedMinimumTaskClass: 'STANDARD',
        effectiveTaskClass: 'STANDARD',
        declaredTaskClass: null,
        declarationKind: 'absent',
        ticketDigest: null,
        touchedSurfaces: [],
        riskTriggers: [],
        assessedFrom: 'implementation_changed_files',
        assessedFileCount: 1,
        implementationDigest: 'older-digest',
      },
    });
    const text = renderImplementationRiskFocus(state).join('\n');
    expect(text).toContain('Status: NOT_VERIFIED');
  });

  it('renders nothing outside an implementation review', () => {
    expect(renderImplementationRiskFocus(makeState('READY'))).toEqual([]);
  });
});

describe('dossier proof context completeness', () => {
  it('removes the 20-entry truncation only for the unbounded dossier arm', () => {
    const claims = Array.from({ length: 25 }, (_, index) =>
      provenClaim({
        claimId: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
        statement: `claim ${index}`,
        verificationState: 'UNPROVEN',
      }),
    );
    const state = makeState('PLAN_REVIEW', { proofGraph: projection(claims) });
    const bounded = rawBuildReviewerProofContext(state, authorities).join('\n');
    const unbounded = rawBuildReviewerProofContext(state, authorities, {
      unbounded: true,
    }).join('\n');
    expect(bounded).toContain('omitted for prompt length');
    expect(unbounded).not.toContain('omitted for prompt length');
    expect(unbounded).toContain('claim 24');
    expect(unbounded).toContain('33333333-3333-4333-8333-000000000024');
  });
});
