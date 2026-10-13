/**
 * @module implement-review-response
 * @description Approved-review response and phase-true blocked formatting.
 * Extracted from `implement-review.ts` along the response boundary so the
 * orchestration module stays within the file-size budget.
 *
 * @version v1
 */

import type { SessionState } from '../../../state/schema.js';
import type { ReviewFindings } from '../../../state/evidence.js';
import type { EvidenceReviewCardInput } from '../../../presentation/evidence-review-card.js';
import type { GlyphProfile } from '../../../presentation/glyph-profile.js';
import { PHASE_LABELS } from '../../../presentation/index.js';
import { buildEvidenceReviewCard } from '../../../presentation/evidence-review-card.js';
import type { CompactProofPresentation } from '../../../presentation/proof-model.js';
import { enrichWithWorkflowDirective } from '../helpers.js';
import { toPresentationFindingRelation } from '../helpers-rail-presentation.js';
import { resolveWorkflowDirective } from '../../../machine/workflow-directive.js';
import type { TransitionRecord } from '../../../rails/types.js';
import type { ImplementRuntime } from './implement-shared.js';
import { addLatestImplementationReview } from './implement-review-state.js';

/**
 * Rewrite a formatted blocked response so its `phase` matches the persisted
 * position. A denial must never claim a phase the session has not reached.
 */
function withPersistedPhase(message: string, phase: SessionState['phase']): string {
  const payload = JSON.parse(message) as Record<string, unknown>;
  return JSON.stringify({ ...payload, phase });
}

/**
 * Build the approved-review response for the final (possibly approved) state.
 * Extracted so the persistence/gate orchestration stays within the function
 * size budget.
 */
function formatApprovedReviewOutcome(
  input: {
    readonly runtime: ImplementRuntime;
    readonly iteration: number;
    readonly reviewFindings: ReviewFindings[];
    readonly proofSummary: CompactProofPresentation;
  },
  finalState: SessionState,
  transitions: readonly TransitionRecord[],
  glyphProfile: GlyphProfile | undefined,
): string {
  const response: Record<string, unknown> = {
    phase: finalState.phase,
    implReviewIteration: input.iteration,
    _audit: { transitions },
  };
  addLatestImplementationReview(response, input.reviewFindings);

  response.proofSummary = input.proofSummary;
  const statusLine =
    input.runtime.args.reviewVerdict === 'accept'
      ? `Implementation review converged at iteration ${input.iteration}. Reviewer accepted.`
      : `Implementation review reached max iterations (${input.iteration}/${input.runtime.maxImplementationReviewIterations}). Force-converged.`;
  const directive = resolveWorkflowDirective(finalState);
  const latestFindings = input.reviewFindings.at(-1);
  const cardInput: EvidenceReviewCardInput = {
    phaseLabel: PHASE_LABELS[finalState.phase],
    directive,
    proofSummary: input.proofSummary,
    statusLine,
    forcedConvergence: input.runtime.args.reviewVerdict !== 'accept',
    ...(latestFindings
      ? {
          blockingIssues: latestFindings.blockingIssues.map((finding) => ({
            severity: finding.severity,
            category: finding.category,
            message: finding.message,
            relation: toPresentationFindingRelation(finding.relation),
            ...(finding.findingId !== undefined ? { findingId: finding.findingId } : {}),
          })),
          majorRisks: latestFindings.majorRisks.map((finding) => ({
            severity: finding.severity,
            category: finding.category,
            message: finding.message,
            relation: toPresentationFindingRelation(finding.relation),
          })),
          missingVerification: [...latestFindings.missingVerification],
          scopeCreep: [...latestFindings.scopeCreep],
          unknowns: [...latestFindings.unknowns],
        }
      : {}),
  };
  response.presentation = {
    markdown: buildEvidenceReviewCard(
      cardInput,
      glyphProfile !== undefined ? { glyphProfile } : {},
    ),
  };

  if (input.runtime.args.reviewVerdict === 'accept') {
    response.status = `Implementation review converged at iteration ${input.iteration}. Reviewer accepted.`;
  } else {
    response.status = `Implementation review reached max iterations (${input.iteration}/${input.runtime.maxImplementationReviewIterations}). Force-converged.`;
  }
  return JSON.stringify(enrichWithWorkflowDirective(response, finalState));
}

export { withPersistedPhase, formatApprovedReviewOutcome };
