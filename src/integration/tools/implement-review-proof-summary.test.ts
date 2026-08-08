/**
 * @test-policy
 * RESOLVER: resolveSubmittedReviewProofResponse branch decisions are mutation-firm.
 *   - findingsBlocked + any verdict → kind: 'blocked', response contains proofSummary.
 *   - changes_requested (no block) → kind: 'proceed', proofSummary has prospective_approval.
 *   - accept (no block) → kind: 'proceed', proofSummary has current_gate.
 * COMPLETION: projectCompletionProofStatus yields 'completion' context.
 * CONTRACT: The resolver in implement-review.ts IS the branch decision. Mutating the
 *           branch logic inside the resolver WILL break these tests. The handler's call
 *           to the resolver is the production wiring and is verified by npm run check.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveSubmittedReviewProofResponse,
  buildImplReviewChangesRequestedMarkdown,
  type ResolvedSubmittedReviewProof,
} from './implement-review.js';
import { buildEvidenceReviewCard } from '../../presentation/index.js';
import type { EvidenceReviewCardInput } from '../../presentation/evidence-review-card.js';
import {
  projectCompletionProofStatus,
  projectImplementationProofStatus,
} from '../proofgraph/proof-summary-projectors.js';
import { formatBlocked } from './helpers.js';
import { makeState, IMPL_EVIDENCE } from '../../fixtures.js';

function proofGraphState() {
  return makeState('IMPL_REVIEW', {
    implementation: IMPL_EVIDENCE,
    proofGraph: {
      version: 'proofgraph.v1' as const,
      claims: [
        {
          claimId: '99999999-9999-9999-9999-999999999999',
          statement: 'Test claim',
          signalClass: 'fact' as const,
          critical: true,
          provenance: {
            kind: 'canonical_authority' as const,
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
          verificationState: 'PROVEN' as const,
        },
      ],
      evaluatedAt: '2025-01-01T00:00:00Z',
    },
  });
}

function negativeProofGraphState() {
  return makeState('IMPL_REVIEW', {
    implementation: IMPL_EVIDENCE,
    proofGraph: {
      version: 'proofgraph.v1' as const,
      claims: [
        {
          claimId: '99999999-9999-9999-9999-999999999999',
          statement: 'Falsified claim',
          signalClass: 'fact' as const,
          critical: true,
          provenance: {
            kind: 'canonical_authority' as const,
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
          verificationState: 'CONTRADICTED' as const,
        },
      ],
      evaluatedAt: '2025-01-01T00:00:00Z',
    },
  });
}

describe('resolveSubmittedReviewProofResponse — branch resolver', () => {
  const blockedJson = formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', {
    obligationId: 'obl-1',
  });

  it('blocked branch: returns kind=blocked with proofSummary injected', () => {
    const result = resolveSubmittedReviewProofResponse({
      findingsBlocked: blockedJson,
      preTransitionState: proofGraphState(),
      reviewedState: proofGraphState(),
      verdict: 'unable_to_review',
    });
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') throw new Error('Expected blocked');
    const parsed = JSON.parse(result.response);
    expect(parsed.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
    expect(parsed.proofSummary).toBeDefined();
    expect(parsed.proofSummary.kind).toBe('evaluation');
  });

  it('blocked branch: returns unmodified when findingsBlocked is null', () => {
    const result = resolveSubmittedReviewProofResponse({
      findingsBlocked: null,
      preTransitionState: proofGraphState(),
      reviewedState: proofGraphState(),
      verdict: 'accept',
    });
    expect(result.kind).toBe('proceed');
    if (result.kind === 'proceed') {
      expect(result.proofSummary).not.toBeNull();
    }
  });

  it('changes_requested branch: yields prospective_approval (pre-transition state)', () => {
    const result = resolveSubmittedReviewProofResponse({
      findingsBlocked: null,
      preTransitionState: proofGraphState(),
      reviewedState: proofGraphState(),
      verdict: 'changes_requested',
    });
    expect(result.kind).toBe('proceed');
    if (result.kind === 'proceed' && result.proofSummary?.kind === 'evaluation') {
      expect(result.proofSummary.decisionContext).toBe('prospective_approval');
    }
  });

  it('accept branch: yields current_gate (post-review state, verdict-aware)', () => {
    const result = resolveSubmittedReviewProofResponse({
      findingsBlocked: null,
      preTransitionState: proofGraphState(),
      reviewedState: proofGraphState(),
      verdict: 'accept',
    });
    expect(result.kind).toBe('proceed');
    if (result.kind === 'proceed' && result.proofSummary?.kind === 'evaluation') {
      expect(result.proofSummary.decisionContext).toBe('current_gate');
    }
  });
});

describe('completion path', () => {
  it('projectCompletionProofStatus → completion', () => {
    const summary = projectCompletionProofStatus(proofGraphState());
    expect(summary).not.toBeNull();
    if (summary?.kind === 'evaluation') {
      expect(summary.decisionContext).toBe('completion');
    }
  });
});

describe('presentation.markdown rendering contract', () => {
  it('changes_requested uses correct conclusion, not completion', () => {
    const summary = projectImplementationProofStatus(proofGraphState());
    const markdown = buildImplReviewChangesRequestedMarkdown(
      'Implementation review iteration 1/3. Changes requested.',
      summary!,
      { text: 'Re-record the revised implementation.', commands: ['/implement'] },
    );
    expect(markdown).toContain('## ProofGraph');
    expect(markdown).toContain('Re-record the revised implementation.');
    expect(markdown).not.toContain('→ Continue to completion');
  });

  it('changes_requested with negative state shows prospective approval language', () => {
    const summary = projectImplementationProofStatus(negativeProofGraphState());
    const markdown = buildImplReviewChangesRequestedMarkdown(
      'Implementation review iteration 1/3. Changes requested.',
      summary!,
      { text: 'Re-record the revised implementation.', commands: ['/implement'] },
    );
    expect(markdown).toContain('## ProofGraph');
    expect(markdown).toContain('If submitted for approval now:');
    expect(markdown).toContain('CONTRADICTED');
    expect(markdown).toContain('Re-record the revised implementation.');
  });

  it('accept card shows current_gate ProofGraph and decision gate', () => {
    const summary = projectImplementationProofStatus(proofGraphState(), {
      decisionContext: 'current_gate',
    });
    const cardInput: EvidenceReviewCardInput = {
      phaseLabel: 'Ready for final review',
      productNextAction: {
        text: 'Review the implementation evidence.',
        commands: ['/approve', '/request-changes', '/reject'],
      },
      proofSummary: summary!,
      statusLine: 'Implementation review converged at iteration 1. Reviewer accepted.',
    };
    const markdown = buildEvidenceReviewCard(cardInput);
    expect(markdown).toContain('## ProofGraph');
    expect(markdown).toContain('All critical claims PROVEN');
    expect(markdown).not.toContain('If submitted for approval now:');
    expect(markdown).toContain('## Decision required');
    expect(markdown).toContain('/approve');
  });

  it('unable_to_review blocked response contains presentation.markdown', () => {
    const blocked = formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', {
      obligationId: 'obl-1',
    });
    const state = proofGraphState();
    const summary = projectImplementationProofStatus(state);
    const result = resolveSubmittedReviewProofResponse({
      findingsBlocked: blocked,
      preTransitionState: state,
      reviewedState: state,
      verdict: 'unable_to_review',
    });
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') throw new Error('Expected blocked');
    const parsed = JSON.parse(result.response);
    expect(parsed.presentation).toBeDefined();
    expect(parsed.presentation.markdown).toContain('## Implementation review blocked');
    expect(parsed.presentation.markdown).toContain('## ProofGraph');
    expect(parsed.presentation.markdown).toContain(
      'Restore the reviewer capability and retry the implementation review.',
    );
  });
});
