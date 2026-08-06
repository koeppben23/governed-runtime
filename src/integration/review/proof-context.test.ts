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
import { renderReviewerTaskPrompt } from './prompt-builders.js';
import {
  buildReviewerProofContext,
  renderCoverageGaps,
  renderDeclarationPreview,
  renderPersistedProofGraphContext,
} from './proof-context.js';

const CLAIM_ID = '33333333-3333-4333-8333-333333333333';

function projection(claims: ProofGraphProjection['claims'] = []): ProofGraphProjection {
  return { version: 'proofgraph.v1', evaluatedAt: '2026-01-01T00:00:00.000Z', claims };
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
        claims: [
          {
            claimId: CLAIM_ID,
            statement: 'updateTask rejects unknown ids',
            critical: true,
            authoritySectionId: 'implementation-step-1',
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
    expect(text).toContain('expected check: build');
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
          reviewObligationId: null,
          reviewEvidenceDigest: null,
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

  it('renders counterexample requirement in check-mode without assertion suffix', () => {
    const state: SessionState = {
      ...planState,
      plan: {
        ...planState.plan!,
        claimDeclarations: {
          flow: 'plan',
          claims: [
            {
              claimId: CLAIM_ID,
              statement: 'check-mode claim',
              critical: true,
              authoritySectionId: 's1',
              expectedCheckId: 'build',
              counterexampleRequirement: { mode: 'check', checkId: 'security' },
            },
          ],
        },
      },
    };
    const text = renderDeclarationPreview(state).join('\n');
    expect(text).toContain('counterexample check: security');
    expect(text).not.toContain('(assertion:');
  });

  it('renders counterexample requirement in assertion-mode with assertionId', () => {
    const state: SessionState = {
      ...planState,
      plan: {
        ...planState.plan!,
        claimDeclarations: {
          flow: 'plan',
          claims: [
            {
              claimId: CLAIM_ID,
              statement: 'assertion-mode claim',
              critical: true,
              authoritySectionId: 's1',
              expectedCheckId: 'build',
              counterexampleRequirement: {
                mode: 'assertion',
                checkId: 'security',
                assertion: { providerId: 'junit', localId: 'com.example.Test#method' },
              },
            },
          ],
        },
      },
    };
    const text = renderDeclarationPreview(state).join('\n');
    expect(text).toContain('counterexample check: security (assertion: com.example.Test#method)');
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

describe('host-task reviewer prompt carries ProofGraph context', () => {
  const BASE = {
    iteration: 1,
    planVersion: 1,
    obligationId: '11111111-1111-4111-8111-111111111111',
    mandateDigest: 'mandate-digest',
    criteriaVersion: 'criteria-v1',
    subjectLabel: 'the artifact under review',
  };

  it('embeds the composed context so the reviewer sees claims', () => {
    const state = makeState('IMPL_REVIEW', {
      proofGraph: projection([provenClaim({ verificationState: 'UNPROVEN' })]),
      proofContractCoverage: [{ claimId: CLAIM_ID, cause: 'missing_expected_check' }],
    });
    const prompt = renderReviewerTaskPrompt({
      ...BASE,
      proofContext: buildReviewerProofContext(state),
    });
    expect(prompt).toContain('## ProofGraph Context (persisted, advisory)');
    expect(prompt).toContain(CLAIM_ID);
    expect(prompt).toContain('missing_expected_check');
  });

  it('keeps the enforcement-critical review context tokens intact', () => {
    const prompt = renderReviewerTaskPrompt({
      ...BASE,
      proofContext: buildReviewerProofContext(
        makeState('IMPL_REVIEW', { proofGraph: projection([provenClaim()]) }),
      ),
    });
    // promptContainsValue (enforcement/extraction.ts) matches these literals; the
    // injected section must never displace or reformat them.
    expect(prompt).toContain('iteration=1');
    expect(prompt).toContain('planVersion=1');
    // The appended-content marker must remain the final line so the agent still
    // knows where to paste the subject.
    expect(prompt.trimEnd().endsWith('content to review below this line:')).toBe(true);
  });

  it('omits the section entirely when no context is supplied', () => {
    const prompt = renderReviewerTaskPrompt(BASE);
    expect(prompt).not.toContain('## ProofGraph Context');
  });

  it('still reports NOT_DECLARED for a claimless session rather than staying silent', () => {
    const prompt = renderReviewerTaskPrompt({
      ...BASE,
      proofContext: buildReviewerProofContext(makeState('READY')),
    });
    expect(prompt).toContain('Coverage: NOT_DECLARED');
  });

  it('renders the persisted critical fact requirement for a specific trigger', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: {
        changedFiles: ['src/state/schema.ts'],
        domainFiles: ['src/state/schema.ts'],
        digest: 'implementation-digest',
        executedAt: '2026-01-01T00:00:00.000Z',
      },
      implementationRiskAssessment: {
        computedMinimumTaskClass: 'HIGH-RISK',
        touchedSurfaces: ['src/state/schema.ts'],
        riskTriggers: ['state_integrity'],
        assessedFrom: 'implementation_changed_files',
        assessedFileCount: 1,
        implementationDigest: 'implementation-digest',
      },
    });
    expect(buildReviewerProofContext(state).join('\n')).toContain(
      'Relevant triggers: state_integrity',
    );
  });
});
