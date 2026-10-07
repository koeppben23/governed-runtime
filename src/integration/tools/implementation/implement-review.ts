/**
 * @module integration/tools/implement
 * @description FlowGuard implement tool — record implementation or review verdict.
 *
 * Host-Observed Independent Review for /implement
 *
 * Architecture: FlowGuard does NOT call subagents. The OpenCode primary agent
 * orchestrates independent review by calling the flowguard-reviewer subagent
 * via the Task tool. The HOST captures the reviewer's structured findings into
 * the review assurance evidence; the agent never resubmits findings.
 *
 * Flow:
 * 1. Primary agent performs implementation work
 * 2. Primary agent calls flowguard_implement (Mode A, records evidence)
 * 3. FlowGuard returns next-action instructing subagent invocation
 * 4. Primary agent calls flowguard-reviewer subagent via Task tool
 * 5. Host captures the reviewer's structured findings into invocation evidence
 * 6. Primary agent submits the review verdict ONLY (Mode B)
 * 7. FlowGuard resolves the host-captured findings, validates, and persists them
 *
 * Tool responsibilities:
 * - Input validation: verdict vs host-captured evidence binding
 * - Persistence: impl history (author), implReviewFindings (host-captured)
 * - Response: summary of review findings
 * - Next-action: independent reviewer instructions
 *
 * Validation rules:
 * - reviewMode=self → BLOCKED
 * - reviewVerdict without bound structured evidence → SUBAGENT_EVIDENCE_MISSING
 * - captured findings iteration mismatch → BLOCKED
 *
 * Multi-call pattern driven by the LLM:
 *
 * Step 1: LLM makes code changes using OpenCode built-in tools (read, write, bash)
 * Step 2: LLM calls flowguard_implement({})
 *   -> Tool auto-detects changed files via git, records ImplEvidence
 *   -> Auto-advances to IMPL_REVIEW
 *   -> Returns "review needed" with policy-conditional next-action
 *
 * Step 3: LLM calls flowguard-reviewer subagent via Task tool
 * Step 4: LLM calls flowguard_review_implementation({ reviewVerdict: "accept" })
 *   -> Tool resolves the host-captured findings and records the review iteration
 *   -> On convergence: auto-advance to EVIDENCE_REVIEW
 *
 * OR Step 4: LLM calls flowguard_review_implementation({ reviewVerdict: "changes_requested" })
 *   -> LLM makes more code changes, then calls flowguard_implement({}) again
 *
 * @version v5
 */

import { formatBlocked } from '../../blocked-result.js';
import { getAdapterLogger } from '../../../logging/adapter-logger.js';
import {
  formatReviewValidationFailure,
  logStructuredResolutionDiagnostics,
  type ReviewValidationFailure,
} from '../../review/validation/review-validation-failure.js';
import { enrichWithWorkflowDirective, writeStateWithArtifacts } from '../helpers.js';
import { formatAutoAdvanceOverflow } from '../../../rails/auto-advance-overflow.js';
import { toPresentationFindingRelation } from '../helpers-rail-presentation.js';
import {
  addLatestImplementationReview,
  appendImplReviewState,
  findOpenImplObligation,
  requireImplementationDigest,
  resolveImplementationFindings,
  validateEffectiveFindings,
  type ResolvedStructuredFindings,
} from './implement-review-state.js';

// State & Machine
import type { SessionState } from '../../../state/schema.js';
import { evaluate, evaluateWithEvent } from '../../../machine/evaluate.js';
import { implValidationPassed } from '../../../machine/guards.js';
import { resolveWorkflowDirective } from '../../../machine/workflow-directive.js';

// Rail helpers
import { applyTransition, autoAdvance } from '../../../rails/types.js';

// Adapters
import { readConfig } from '../../../adapters/persistence-config.js';

// Presentation
import { buildEvidenceReviewCard, PHASE_LABELS } from '../../../presentation/index.js';
import type { EvidenceReviewCardInput } from '../../../presentation/evidence-review-card.js';

// Evidence types
import type { LoopVerdict, ReviewFindings } from '../../../state/evidence.js';

// Review findings validation (shared with plan.ts)
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import type { ImplementRuntime } from './implement-shared.js';
import {
  activateImplementationReviewObligation,
  buildImplementationReviewInstruction,
  nextImplementationReviewIteration,
} from '../implementation-review-activation.js';
import {
  reviewObligationResponseFields,
  type ReviewDispatchAuthority,
} from '../../review/dispatch/dispatch-authority.js';
import { attemptIncoherentCaptureRetry } from '../incoherent-capture-recovery.js';
import { unknownOutcomeRevalidationBlock } from './implement-shared.js';
import { handleTransportRecovery } from './implement-review-recovery.js';
import { handleUnableToReview } from './implement-unable-review.js';
import { evaluateImplValidationEvidence } from '../../../machine/impl-validation-evidence.js';
import type { CompactProofPresentation } from '../../../presentation/proof-model.js';
import { buildImplReviewChangesRequestedMarkdown } from './implement-review-presentation.js';
export { buildImplReviewChangesRequestedMarkdown } from './implement-review-presentation.js';
export {
  resolveSubmittedReviewProofResponse,
  type ResolvedSubmittedReviewProof,
} from './implement-review-proof.js';
import { resolveSubmittedReviewProofResponse } from './implement-review-proof.js';

async function handleChangesRequestedReview(input: {
  runtime: ImplementRuntime;
  reviewedState: SessionState;
  iteration: number;
  reviewFindings: ReviewFindings[];
  proofSummary: CompactProofPresentation;
}): Promise<string> {
  const maxIterations = input.runtime.maxImplementationReviewIterations;
  const exhausted = input.iteration >= maxIterations;
  // An exhausted loop no longer clears the implementation. It advances to the
  // final human gate, which becomes a governance override gate: the human may
  // still accept the unchanged reviewed revision explicitly, request changes,
  // or reject. Below the budget, changes_requested remains an internal repair
  // continuation back to IMPLEMENTATION.
  const event = exhausted ? 'REVIEW_EXHAUSTED' : 'CHANGES_REQUESTED';
  const target = evaluateWithEvent(input.runtime.state.phase, event);
  if (target === undefined) {
    return formatBlocked('INVALID_TRANSITION', {
      event,
      phase: input.runtime.state.phase,
    });
  }

  const at = input.runtime.ctx.now();
  const finalState = exhausted
    ? applyTransition(
        {
          ...input.reviewedState,
          implementationRework: {
            rejectedDigest: requireImplementationDigest(input.runtime.state),
            exhausted: true,
          },
        },
        input.runtime.state.phase,
        target,
        event,
        at,
      )
    : applyTransition(
        {
          ...input.reviewedState,
          implementation: null,
          implementationRework: {
            rejectedDigest: requireImplementationDigest(input.runtime.state),
            exhausted: false,
          },
          implValidation: [],
          implReview: null,
          reducedCeremony: null,
        },
        input.runtime.state.phase,
        target,
        event,
        at,
      );
  const transitions = [{ from: input.runtime.state.phase, to: finalState.phase, event, at }];
  await writeStateWithArtifacts(input.runtime.sessDir, finalState);

  const response: Record<string, unknown> = {
    phase: finalState.phase,
    implReviewIteration: input.iteration,
    status: exhausted
      ? `Implementation review iteration ${input.iteration}/${maxIterations} exhausted with Changes requested.`
      : `Implementation review iteration ${input.iteration}/${maxIterations}. Changes requested.`,
    ...(exhausted
      ? {}
      : {
          agentInstruction:
            'Make the requested code changes using read/write/bash tools, then call flowguard_implement (without reviewVerdict) to re-record the implementation. ' +
            `After re-recording, call the ${REVIEWER_SUBAGENT_TYPE} subagent again for independent review.`,
        }),
    _audit: { transitions },
  };
  addLatestImplementationReview(response, input.reviewFindings);
  response.proofSummary = input.proofSummary;
  // No intermediate cards in the active review loop: while the budget is not
  // exhausted, changes_requested is an INTERNAL continuation (repair ->
  // re-record -> validation -> challenge resolution -> fresh independent
  // review), so the response carries compact status/next guidance and NO
  // presentation card. Only when the budget is exhausted does the loop end in
  // a user decision at the governance override gate; that state renders the
  // full card with the /override-approve action.
  if (exhausted) {
    response.presentation = {
      markdown: buildImplReviewChangesRequestedMarkdown(
        `Implementation review iteration ${input.iteration}/${maxIterations} exhausted with Changes requested.`,
        input.proofSummary,
        resolveWorkflowDirective(finalState),
      ),
    };
  }
  return JSON.stringify(enrichWithWorkflowDirective(response, finalState));
}

async function handleApprovedReview(input: {
  runtime: ImplementRuntime;
  reviewedState: SessionState;
  iteration: number;
  reviewFindings: ReviewFindings[];
  proofSummary: CompactProofPresentation;
}): Promise<string> {
  // Resolve presentation dependencies before any state mutation.
  // If config I/O fails, no EVIDENCE_REVIEW state has been persisted.
  const glyphProfile = (await readConfig(input.runtime.worktree)).presentation.opencode
    .glyphProfile;

  const advanced = autoAdvance(
    input.reviewedState,
    (s) => evaluate(s, input.runtime.policy),
    input.runtime.ctx,
  );
  // #428: fail closed on overflow BEFORE persisting — no partially-advanced write.
  if (advanced.kind === 'overflow') {
    return formatAutoAdvanceOverflow(advanced);
  }
  const { state: finalState, transitions } = advanced;
  await writeStateWithArtifacts(input.runtime.sessDir, finalState);

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
    markdown: buildEvidenceReviewCard(cardInput, { glyphProfile }),
  };

  if (input.runtime.args.reviewVerdict === 'accept') {
    response.status = `Implementation review converged at iteration ${input.iteration}. Reviewer accepted.`;
  } else {
    response.status = `Implementation review reached max iterations (${input.iteration}/${input.runtime.maxImplementationReviewIterations}). Force-converged.`;
  }
  return JSON.stringify(enrichWithWorkflowDirective(response, finalState));
}

function handleTaskTransportFailureRetry(input: ImplementRuntime): string | null {
  if (input.args.reviewerUnavailable !== true) return null;
  if (input.args.reviewVerdict !== undefined) return null;
  return formatBlocked('REVIEWER_UNAVAILABLE_STRICT', {
    reason: 'reviewer unavailable; independent host-captured reviewer evidence remains required',
    recovery:
      'Invoke a supported structured reviewer transport; the host captures its findings. flowguard_decision does not replace review evidence.',
  });
}

async function handleUnableToReviewSubmission(input: {
  runtime: ImplementRuntime;
  iteration: number;
  planVersion: number;
  submittedVerdict: LoopVerdict;
  pendingObligation: ReturnType<typeof findOpenImplObligation>;
  resolved: ResolvedStructuredFindings;
}): Promise<string> {
  const { runtime, iteration, planVersion, submittedVerdict, pendingObligation, resolved } = input;
  if (submittedVerdict !== 'unable_to_review') {
    return formatBlocked('SUBAGENT_FINDINGS_VERDICT_MISMATCH', {
      reviewVerdict: submittedVerdict,
      overallVerdict: resolved.effectiveFindings.overallVerdict,
    });
  }
  if (!pendingObligation) {
    return formatBlocked('SUBAGENT_REVIEW_NOT_INVOKED', {
      reason: 'unable_to_review requires bound host-task reviewer evidence',
    });
  }
  // Prepare the successor before consuming evidence. A failed Discovery mint
  // must preserve the current bound verdict as the executable recovery path.
  const reissued = await activateImplementationReviewObligation(runtime.state, {
    iteration: iteration + 1,
    planVersion,
    now: runtime.ctx.now(),
    worktree: runtime.worktree,
  });
  if (reissued.blocked || !reissued.obligation || !reissued.attempt) {
    return JSON.stringify(
      enrichWithWorkflowDirective(
        JSON.parse(
          formatBlocked('REVIEWER_CONTEXT_UNAVAILABLE', {
            reason:
              reissued.blocked?.reason ?? 'a fresh reviewer obligation could not be activated',
          }),
        ),
        runtime.state,
      ),
    );
  }
  const retryAttempt = reissued.attempt;
  const { reviewedState } = appendImplReviewState({
    runtime,
    iteration,
    planVersion,
    effectiveFindings: resolved.effectiveFindings,
    evidenceInvocationId: resolved.evidenceInvocationId,
    obligationToConsume: pendingObligation,
  });
  return handleUnableToReview({
    runtime,
    reviewedState,
    obligationId: pendingObligation.obligationId,
    retryObligation: reissued.obligation,
    retryAttempt,
  });
}

/** Canonical review-required response for a freshly re-armed implementation attempt. */
function buildRearmedImplementationReviewResponse(
  state: SessionState,
  authority: ReviewDispatchAuthority,
): string {
  const instruction = buildImplementationReviewInstruction(authority);
  return JSON.stringify(
    enrichWithWorkflowDirective(
      {
        phase: state.phase,
        status:
          'Incoherent reviewer capture detected; a fresh review attempt was re-armed on the same frozen implementation subject.',
        reviewMode: 'subagent',
        ...reviewObligationResponseFields(authority),
        reviewDispatch: instruction.reviewDispatch,
        reviewInvocation: instruction,
        _audit: { transitions: [] },
      },
      state,
    ),
  );
}

/**
 * F12 interception: re-arm and persist one fresh attempt inside the caller's
 * transaction, or return null so the caller keeps its canonical fail-closed
 * response.
 */
async function handleIncoherentCaptureRetry(input: {
  runtime: ImplementRuntime;
  failure: ReviewValidationFailure;
  pendingObligation: ReturnType<typeof findOpenImplObligation>;
}): Promise<string | null> {
  const retry = await attemptIncoherentCaptureRetry({
    failure: input.failure,
    state: input.runtime.state,
    sessDir: input.runtime.sessDir,
    obligationId: input.pendingObligation?.obligationId,
    now: input.runtime.ctx.now(),
    buildResponse: buildRearmedImplementationReviewResponse,
  });
  return retry.kind === 'not_applicable' ? null : retry.response;
}

async function handleSubmittedImplementationReview(input: {
  runtime: ImplementRuntime;
  iteration: number;
  planVersion: number;
  submittedVerdict: LoopVerdict;
}): Promise<string> {
  const { runtime, iteration, planVersion, submittedVerdict } = input;
  const { pendingObligation, resolved } = resolveImplementationFindings(
    runtime,
    iteration,
    planVersion,
  );
  if (resolved.kind === 'blocked') {
    const retryResponse = await handleIncoherentCaptureRetry({
      runtime,
      failure: resolved.failure,
      pendingObligation,
    });
    if (retryResponse !== null) return retryResponse;
    return formatReviewValidationFailure(getAdapterLogger(), resolved.failure);
  }
  logStructuredResolutionDiagnostics(getAdapterLogger(), resolved.diagnostics);

  if (resolved.effectiveFindings.overallVerdict === 'unable_to_review') {
    return handleUnableToReviewSubmission({
      runtime,
      iteration,
      planVersion,
      submittedVerdict,
      pendingObligation,
      resolved,
    });
  }

  const findingsBlocked = validateEffectiveFindings(
    resolved.effectiveFindings,
    submittedVerdict,
    pendingObligation?.obligationId ?? 'unknown',
  );

  const { reviewedState, newReviewFindings } = appendImplReviewState({
    runtime,
    iteration,
    planVersion,
    effectiveFindings: resolved.effectiveFindings,
    evidenceInvocationId: resolved.evidenceInvocationId,
    obligationToConsume: pendingObligation,
  });

  const proofDecision = resolveSubmittedReviewProofResponse({
    findingsBlocked,
    preTransitionState: runtime.state,
    reviewedState,
    verdict: submittedVerdict,
  });
  if (proofDecision.kind === 'blocked') return proofDecision.response;

  const proofSummary = proofDecision.proofSummary;

  if (submittedVerdict === 'changes_requested') {
    return handleChangesRequestedReview({
      runtime,
      reviewedState,
      iteration,
      reviewFindings: newReviewFindings,
      proofSummary,
    });
  }
  const validationGate = implValidationEvidenceGate(runtime.state);
  if (validationGate) return validationGate;
  return handleApprovedReview({
    runtime,
    reviewedState,
    iteration,
    reviewFindings: newReviewFindings,
    proofSummary,
  });
}

export async function handleImplReview(input: ImplementRuntime): Promise<string> {
  const implementation = input.state.implementation;
  if (!implementation) {
    const receivedVerdict = input.args.reviewVerdict;
    return formatBlocked(
      'IMPLEMENTATION_EVIDENCE_REQUIRED',
      receivedVerdict ? { receivedVerdict } : undefined,
    );
  }

  // An unknown-outcome resolution declares all pre-resolution evidence
  // unreliable. The review verdict must be bound to a fresh worktree
  // recapture: implementation evidence recorded before the latest resolution
  // can never satisfy the review loop.
  const staleEvidenceBlock = unknownOutcomeRevalidationBlock(
    input.state,
    implementation.executedAt,
  );
  if (staleEvidenceBlock) return staleEvidenceBlock;

  const iteration = nextImplementationReviewIteration(input.state);
  const planVersion = (input.state.plan?.history.length ?? 0) + 1;
  if (input.args.reviewRecovery === 'retry_transport') {
    return handleTransportRecovery(input);
  }
  const transportFailureRetry = handleTaskTransportFailureRetry(input);
  if (transportFailureRetry) return transportFailureRetry;
  const submittedVerdict = input.args.reviewVerdict;
  if (!submittedVerdict)
    return formatBlocked('IMPLEMENT_REVIEW_LOOP_REQUIRED', { phase: input.state.phase });
  return handleSubmittedImplementationReview({
    runtime: input,
    iteration,
    planVersion,
    submittedVerdict,
  });
}

/**
 * Defense-in-depth gate: reviewer acceptance must not advance to EVIDENCE_REVIEW
 * unless the active verification checks actually have passing execution evidence
 * bound to the CURRENT implementation digest.
 *
 * Today `IMPL_REVIEW` is only reachable via the `IMPL_VALIDATION`
 * `implValidationPassed` gate, so on the normal path this is redundant. But
 * acceptance must not rely solely on topology: any future inbound path to
 * `IMPL_REVIEW`, or a topology regression, must still not accept unvalidated code.
 *
 * Unlike the machine guard `implValidationPassed` — which reads the digest-less
 * `implValidation` slot and is kept sound only by the invariant that a fresh
 * implementation clears that slot — this gate binds evidence to the current
 * `implementation.digest` via `state.validationAttempts` (same authority as
 * `stateVerificationEvidence`). That closes the latent fail-open where a future
 * path could set `implementation` without clearing `implValidation`: stale-digest
 * evidence can never satisfy this gate.
 *
 * Returns a BLOCKED payload, or `null` when the active checks are satisfied. The
 * zero-`activeChecks` case defers to `implValidationPassed` so the deliberate
 * policy-gated behavior for repos without discoverable verification commands is
 * preserved unchanged.
 */
export function implValidationEvidenceGate(state: SessionState): string | null {
  // No active checks: preserve the existing policy-gated (possibly vacuous) rule.
  if (state.activeChecks.length === 0) {
    return implValidationPassed(state) ? null : blockValidationEvidence(state.activeChecks, state);
  }
  // Active checks present: the shared pure authority selects the latest
  // decisive result per check plus its bound implementation-scoped attempt.
  const decision = evaluateImplValidationEvidence(state);
  return decision.satisfied ? null : blockValidationEvidence(decision.missing, state);
}

function blockValidationEvidence(missing: readonly string[], state: SessionState): string {
  return formatBlocked('IMPL_VALIDATION_EVIDENCE_REQUIRED', {
    message:
      missing.length > 0
        ? `missing passing checks for current implementation: ${missing.join(', ')}`
        : state.implementation
          ? 'validation evidence not satisfied'
          : 'no implementation evidence to validate',
  });
}
