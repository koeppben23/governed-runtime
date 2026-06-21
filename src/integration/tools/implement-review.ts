/**
 * @module integration/tools/implement
 * @description FlowGuard implement tool — record implementation or review verdict.
 *
 * Agent-Orchestrated Independent Review for /implement
 *
 * Architecture: FlowGuard does NOT call subagents. The OpenCode primary agent
 * orchestrates independent review by calling the flowguard-reviewer subagent
 * via the Task tool. FlowGuard accepts, validates, and persists the resulting
 * ReviewFindings.
 *
 * Flow (subagentEnabled=true):
 * 1. Primary agent performs implementation work
 * 2. Primary agent calls flowguard_implement (Mode A, records evidence)
 * 3. FlowGuard returns next-action instructing subagent invocation
 * 4. Primary agent calls flowguard-reviewer subagent via Task tool
 * 5. Subagent returns structured ReviewFindings
 * 6. Primary agent submits reviewVerdict + reviewFindings to FlowGuard (Mode B)
 * 7. FlowGuard validates and persists both (append-only, separate)
 *
 * Tool responsibilities:
 * - Input validation: reviewFindings vs policy, iteration binding
 * - Persistence: impl history (author), implReviewFindings (reviewer)
 * - Response: summary of review findings
 * - Next-action: independent reviewer instructions
 *
 * Policy config (selfReview):
 * - subagentEnabled: enforces subagent review mode
 * - fallbackToSelf: deprecated compatibility field; self-review fallback is prohibited
 *
 * Validation rules:
 * - reviewMode=self → BLOCKED
 * - reviewVerdict=approve + missing reviewFindings → BLOCKED
 * - reviewFindings.iteration mismatch → BLOCKED
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
 * Step 4: LLM calls flowguard_implement({ reviewVerdict: "accept", reviewFindings })
 *   -> Tool records review iteration, checks convergence
 *   -> On convergence: auto-advance to EVIDENCE_REVIEW
 *
 * OR Step 4: LLM calls flowguard_implement({ reviewVerdict: "changes_requested" })
 *   -> LLM makes more code changes, then calls flowguard_implement({}) again
 *
 * @version v5
 */

import { z } from 'zod';

import type { ToolDefinition, ToolContext } from './helpers.js';
import {
  withMutableSession,
  withMutableSessionTransaction,
  formatEval,
  formatBlocked,
  formatError,
  formatAutoAdvanceOverflow,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers.js';

// State & Machine
import type { SessionState } from '../../state/schema.js';
import { evaluate, evaluateWithEvent } from '../../machine/evaluate.js';
import { isCommandAllowed, Command } from '../../machine/commands.js';

// Rail helpers
import type { RailContext } from '../../rails/types.js';
import { applyTransition, autoAdvance } from '../../rails/types.js';

// Adapters
import { changedFiles } from '../../adapters/git.js';
import type { FlowGuardPolicy } from '../../config/policy.js';

// Evidence types
import type { LoopVerdict, ReviewFindings } from '../../state/evidence.js';
import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';

// Review findings validation (shared with plan.ts)
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import {
  validateReviewFindings,
  requireReviewFindings,
  resolveHostTaskEffectiveFindings,
} from './review-validation.js';
import {
  appendReviewObligation,
  consumeReviewObligation,
  createReviewObligation,
  ensureReviewAssurance,
  findAcceptedInvocationForFindings,
  findLatestObligation,
  reviewObligationResponseFields,
} from '../review/assurance.js';
import { buildLatestImplementationReviewSummary } from './review-summary.js';
import { resolveCeremonyProfile } from '../phase-tool-gate.js';
import {
  resolveRuntimeReviewPlatform,
  resolveReviewOrchestrationMode,
} from '../review/orchestration-mode.js';
import { buildPendingReviewInstruction } from '../review/pending-instruction.js';
import {
  type ImplementArgs,
  type ImplementRuntime,
  classifyImplementArgs,
  buildImplementRuntime,
  validateImplementSequence,
  nextImplementationReviewIteration,
} from './implement-shared.js';
function findPendingImplObligation(state: SessionState) {
  const assuranceBase = ensureReviewAssurance(state.reviewAssurance);
  return (
    [...assuranceBase.obligations]
      .reverse()
      .find(
        (item) =>
          item.obligationType === 'implement' &&
          item.status !== 'consumed' &&
          item.consumedAt == null,
      ) ?? null
  );
}

function resolveImplementationFindings(
  input: ImplementRuntime,
  iteration: number,
  planVersion: number,
) {
  const pendingObligation = findPendingImplObligation(input.state);
  const resolved = resolveHostTaskEffectiveFindings({
    pendingObligation,
    expected: { obligationType: 'implement', iteration, planVersion },
    policy: {
      reviewInvocationPolicy: input.policy.reviewInvocationPolicy,
      strictEnforcement: input.strictEnforcement,
      subagentEnabled: input.subagentEnabled,
      fallbackToSelf: input.fallbackToSelf,
    },
    input: {
      reviewFindings: input.args.reviewFindings,
      reviewerUnavailable: input.args.reviewerUnavailable,
      verdict: input.args.reviewVerdict,
    },
    state: {
      assurance: input.state.reviewAssurance,
      sessionId: input.context.sessionID,
      reviewHostPlatform: resolveRuntimeReviewPlatform(),
    },
  });
  return { pendingObligation, resolved };
}

function validateEffectiveFindings(
  findings: ReviewFindings | undefined,
  submittedVerdict: LoopVerdict,
  obligationId: string,
): string | null {
  if (!findings) return requireReviewFindings(false);
  if (findings.overallVerdict === 'unable_to_review') {
    return formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', { obligationId });
  }
  if (findings.overallVerdict !== submittedVerdict) {
    return formatBlocked('SUBAGENT_FINDINGS_VERDICT_MISMATCH', {
      reviewVerdict: submittedVerdict,
      overallVerdict: findings.overallVerdict,
    });
  }
  return null;
}

function appendImplReviewState(input: {
  runtime: ImplementRuntime;
  iteration: number;
  planVersion: number;
  effectiveFindings?: ReviewFindings;
  evidenceInvocationId?: string;
}) {
  const { runtime, iteration, planVersion, effectiveFindings, evidenceInvocationId } = input;
  const implementation = runtime.state.implementation!;
  const assuranceBase = ensureReviewAssurance(runtime.state.reviewAssurance);
  const strictObligation = runtime.strictEnforcement
    ? findLatestObligation(assuranceBase.obligations, 'implement', iteration, planVersion)
    : null;
  const consumedAssurance = consumeReviewObligation(
    assuranceBase,
    strictObligation,
    runtime.ctx.now(),
    evidenceInvocationId ??
      findAcceptedInvocationForFindings(
        assuranceBase,
        strictObligation,
        runtime.args.reviewFindings,
      )?.invocationId,
  );
  const existingFindings = runtime.state.implReviewFindings ?? [];
  const newReviewFindings = effectiveFindings
    ? [...existingFindings, effectiveFindings]
    : existingFindings;
  const reviewedState: SessionState = {
    ...runtime.state,
    implReview: {
      iteration,
      maxIterations: runtime.maxImplReviewIterations,
      prevDigest: implementation.digest,
      currDigest: implementation.digest,
      revisionDelta: 'none',
      verdict: runtime.args.reviewVerdict as LoopVerdict,
      executedAt: runtime.ctx.now(),
    },
    implReviewFindings: newReviewFindings.length > 0 ? newReviewFindings : undefined,
    reviewAssurance: {
      obligations: consumedAssurance.obligations,
      invocations: consumedAssurance.invocations,
    },
    error: null,
  };
  return { reviewedState, newReviewFindings };
}

function addLatestImplementationReview(
  response: Record<string, unknown>,
  reviewFindings: ReviewFindings[],
): void {
  if (reviewFindings.length > 0) {
    response.latestImplementationReview = buildLatestImplementationReviewSummary(reviewFindings);
  }
}

async function handleChangesRequestedReview(input: {
  runtime: ImplementRuntime;
  reviewedState: SessionState;
  iteration: number;
  reviewFindings: ReviewFindings[];
}): Promise<string> {
  const target = evaluateWithEvent(input.runtime.state.phase, 'CHANGES_REQUESTED');
  if (target === undefined) {
    return formatBlocked('INVALID_TRANSITION', {
      event: 'CHANGES_REQUESTED',
      phase: input.runtime.state.phase,
    });
  }

  const at = input.runtime.ctx.now();
  const finalState = applyTransition(
    { ...input.reviewedState, implementation: null, implReview: null, reducedCeremony: null },
    input.runtime.state.phase,
    target,
    'CHANGES_REQUESTED',
    at,
  );
  const transitions = [
    { from: input.runtime.state.phase, to: finalState.phase, event: 'CHANGES_REQUESTED', at },
  ];
  await writeStateWithArtifacts(input.runtime.sessDir, finalState);

  const response: Record<string, unknown> = {
    phase: finalState.phase,
    implReviewIteration: input.iteration,
    status: `Implementation review iteration ${input.iteration}/${input.runtime.maxImplReviewIterations}. Changes requested.`,
    next:
      'Make the requested code changes using read/write/bash tools, ' +
      'then call flowguard_implement (without reviewVerdict) to re-record the implementation. ' +
      `After re-recording, call the ${REVIEWER_SUBAGENT_TYPE} subagent again for independent review.`,
    _audit: { transitions },
  };
  addLatestImplementationReview(response, input.reviewFindings);
  return appendNextAction(JSON.stringify(response), finalState);
}

async function handleApprovedReview(input: {
  runtime: ImplementRuntime;
  reviewedState: SessionState;
  iteration: number;
  reviewFindings: ReviewFindings[];
}): Promise<string> {
  const advanced = autoAdvance(
    input.reviewedState,
    (s) => evaluate(s, input.runtime.policy),
    input.runtime.ctx,
  );
  // #428: fail closed on overflow BEFORE persisting — no partially-advanced write.
  if (advanced.kind === 'overflow') {
    return formatAutoAdvanceOverflow(advanced);
  }
  const { state: finalState, evalResult: ev, transitions } = advanced;
  await writeStateWithArtifacts(input.runtime.sessDir, finalState);

  const response: Record<string, unknown> = {
    phase: finalState.phase,
    implReviewIteration: input.iteration,
    next: input.runtime.args.reviewVerdict === 'accept' ? formatEval(ev) : undefined,
    _audit: { transitions },
  };
  addLatestImplementationReview(response, input.reviewFindings);

  if (input.runtime.args.reviewVerdict === 'accept') {
    response.status = `Implementation review converged at iteration ${input.iteration}. Reviewer accepted.`;
  } else {
    response.status = `Implementation review reached max iterations (${input.iteration}/${input.runtime.maxImplReviewIterations}). Force-converged.`;
  }
  return appendNextAction(JSON.stringify(response), finalState);
}

export async function handleImplReview(input: ImplementRuntime): Promise<string> {
  const implementation = input.state.implementation;
  if (!implementation) return formatBlocked('IMPLEMENTATION_EVIDENCE_REQUIRED');

  const iteration = nextImplementationReviewIteration(input.state);
  const planVersion = (input.state.plan?.history.length ?? 0) + 1;
  const submittedVerdict = input.args.reviewVerdict;
  if (!submittedVerdict)
    return formatBlocked('IMPLEMENT_REVIEW_LOOP_REQUIRED', { phase: input.state.phase });

  const { pendingObligation, resolved } = resolveImplementationFindings(
    input,
    iteration,
    planVersion,
  );
  if (resolved.blocked) return resolved.blocked;

  const findingsBlocked = validateEffectiveFindings(
    resolved.effectiveFindings,
    submittedVerdict,
    pendingObligation?.obligationId ?? 'unknown',
  );
  if (findingsBlocked) return findingsBlocked;

  const { reviewedState, newReviewFindings } = appendImplReviewState({
    runtime: input,
    iteration,
    planVersion,
    effectiveFindings: resolved.effectiveFindings,
    evidenceInvocationId: resolved.evidenceInvocationId,
  });

  if (input.args.reviewVerdict === 'changes_requested') {
    return handleChangesRequestedReview({
      runtime: input,
      reviewedState,
      iteration,
      reviewFindings: newReviewFindings,
    });
  }
  return handleApprovedReview({
    runtime: input,
    reviewedState,
    iteration,
    reviewFindings: newReviewFindings,
  });
}
