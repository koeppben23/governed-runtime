/**
 * @module integration/tools/implement-review-proof
 * @description Verdict-aware ProofGraph response decisions for implementation review.
 */

import type { SessionState } from '../../state/schema.js';
import type { LoopVerdict } from '../../state/evidence.js';
import { projectImplementationProofStatus } from '../proofgraph/proof-summary-projectors.js';
import type { CompactProofPresentation } from '../../presentation/proof-model.js';
import { buildImplReviewBlockedMarkdown } from './implement-review-presentation.js';

function attachProofSummaryToBlockedResponse(
  blockedResponse: string,
  proofSummary: CompactProofPresentation,
): string {
  const parsed = JSON.parse(blockedResponse) as Record<string, unknown>;
  parsed.proofSummary = proofSummary;
  parsed.presentation = {
    markdown: buildImplReviewBlockedMarkdown(
      String(parsed.message ?? 'The independent review could not be completed.'),
      proofSummary,
    ),
  };
  return JSON.stringify(parsed);
}

function proofDecisionContextForVerdict(
  verdict: LoopVerdict,
): 'current_gate' | 'prospective_approval' {
  return verdict === 'accept' ? 'current_gate' : 'prospective_approval';
}

function projectProofSummaryForVerdict(
  state: SessionState,
  verdict: LoopVerdict,
): CompactProofPresentation {
  return projectImplementationProofStatus(state, {
    decisionContext: proofDecisionContextForVerdict(verdict),
  });
}

export type ResolvedSubmittedReviewProof =
  | { readonly kind: 'blocked'; readonly response: string }
  | { readonly kind: 'proceed'; readonly proofSummary: CompactProofPresentation };

export function resolveSubmittedReviewProofResponse(input: {
  findingsBlocked: string | null;
  preTransitionState: SessionState;
  reviewedState: SessionState;
  verdict: LoopVerdict;
}): ResolvedSubmittedReviewProof {
  const preProof = projectImplementationProofStatus(input.preTransitionState);
  if (input.findingsBlocked) {
    return {
      kind: 'blocked',
      response: attachProofSummaryToBlockedResponse(input.findingsBlocked, preProof),
    };
  }
  if (input.verdict === 'changes_requested') {
    return { kind: 'proceed', proofSummary: preProof };
  }
  return {
    kind: 'proceed',
    proofSummary: projectProofSummaryForVerdict(input.reviewedState, input.verdict),
  };
}
