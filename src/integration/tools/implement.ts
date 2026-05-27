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
 * Step 4: LLM calls flowguard_implement({ reviewVerdict: "approve", reviewFindings })
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

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_implement — Record Implementation OR Impl Review Verdict
// ═══════════════════════════════════════════════════════════════════════════════

function nextImplementationReviewIteration(state: SessionState): number {
  let latest = state.implReview?.iteration ?? 0;
  for (const findings of state.implReviewFindings ?? []) {
    latest = Math.max(latest, findings.iteration);
  }
  return latest + 1;
}

type ImplementArgs = {
  reviewVerdict?: 'approve' | 'changes_requested';
  reviewFindings?: ReviewFindings;
  reviewerUnavailable?: boolean;
};

type ImplementRuntime = {
  args: ImplementArgs;
  context: ToolContext;
  worktree: string;
  sessDir: string;
  state: SessionState;
  policy: FlowGuardPolicy;
  ctx: RailContext;
  maxImplReviewIterations: number;
  subagentEnabled: boolean;
  fallbackToSelf: boolean;
  strictEnforcement: boolean;
};

type ImplementationCeremony = ReturnType<typeof resolveCeremonyProfile>;

type ImplementFlags = {
  hasVerdict: boolean;
  hasFindings: boolean;
  isRecordImpl: boolean;
};

function classifyImplementArgs(args: ImplementArgs): ImplementFlags {
  const hasVerdict = typeof args.reviewVerdict === 'string' && args.reviewVerdict.length > 0;
  return {
    hasVerdict,
    hasFindings: args.reviewFindings != null && typeof args.reviewFindings === 'object',
    isRecordImpl: !hasVerdict,
  };
}

function buildImplementRuntime(input: {
  args: ImplementArgs;
  context: ToolContext;
  worktree: string;
  sessDir: string;
  state: SessionState;
  policy: FlowGuardPolicy;
  ctx: RailContext;
}): ImplementRuntime {
  return {
    ...input,
    maxImplReviewIterations: input.policy.maxImplReviewIterations,
    subagentEnabled: input.policy.selfReview?.subagentEnabled ?? false,
    fallbackToSelf: input.policy.selfReview?.fallbackToSelf ?? false,
    strictEnforcement: input.policy.selfReview?.strictEnforcement ?? false,
  };
}

function validateImplementSequence(
  args: ImplementArgs,
  state: SessionState,
  hasVerdict: boolean,
  hasFindings: boolean,
): string | null {
  if (hasFindings && !hasVerdict) return formatBlocked('INVALID_IMPLEMENT_TOOL_SEQUENCE');
  if (hasVerdict && !state.implementation) return formatBlocked('IMPLEMENTATION_EVIDENCE_REQUIRED');
  if (hasVerdict && state.phase !== 'IMPL_REVIEW') {
    return formatBlocked('IMPLEMENT_REVIEW_LOOP_REQUIRED', { phase: state.phase });
  }
  return null;
}

function validateInitialReviewFindings(input: ImplementRuntime): string | null {
  if (!input.args.reviewFindings) return null;
  return validateReviewFindings(input.args.reviewFindings, {
    subagentEnabled: input.subagentEnabled,
    fallbackToSelf: input.fallbackToSelf,
    expectedIteration: 0,
    expectedPlanVersion: (input.state.plan?.history.length ?? 0) + 1,
    strictEnforcement: false,
    reviewInvocationPolicy: input.policy.reviewInvocationPolicy,
    reviewParentSessionId: input.context.sessionID,
    reviewHostPlatform: resolveRuntimeReviewPlatform(),
  });
}

function blockedImplRecovery(state: SessionState): string | null {
  if (state.phase !== 'IMPL_REVIEW') {
    return formatBlocked('COMMAND_NOT_ALLOWED', { command: '/implement', phase: state.phase });
  }

  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const blockedImplObligations = assurance.obligations.filter(
    (o) => o.obligationType === 'implement' && o.status === 'blocked',
  );
  const lastImplObligation = [...assurance.obligations]
    .reverse()
    .find((o) => o.obligationType === 'implement');

  if (lastImplObligation?.status !== 'blocked') {
    return formatBlocked('COMMAND_NOT_ALLOWED', { command: '/implement', phase: state.phase });
  }
  if (blockedImplObligations.length >= 3) {
    return formatBlocked('ORCHESTRATION_PERMANENTLY_FAILED', {
      attempts: String(blockedImplObligations.length),
    });
  }
  return null;
}

function validateImplRecordPrerequisites(input: ImplementRuntime): string | null {
  if (!isCommandAllowed(input.state.phase, Command.IMPLEMENT)) {
    const blocked = blockedImplRecovery(input.state);
    if (blocked) return blocked;
  }
  if (!input.state.ticket) return formatBlocked('TICKET_REQUIRED', { action: 'implementation' });
  if (!input.state.plan) return formatBlocked('PLAN_REQUIRED', { action: 'implementation' });
  return null;
}

function buildImplRecordedResponse(input: {
  finalState: SessionState;
  files: string[];
  domainFiles: string[];
  reviewIteration: number;
  planVersion: number;
  nextObligation: ReturnType<typeof createReviewObligation> | null;
  transitions: ReadonlyArray<unknown>;
  reviewFindings: ReviewFindings[];
  ceremony: ImplementationCeremony;
  policy: FlowGuardPolicy;
}): Record<string, unknown> {
  const reduced = input.ceremony.profile === 'reduced';
  const platform = resolveRuntimeReviewPlatform();
  const mode = resolveReviewOrchestrationMode({
    platform,
    reviewInvocationPolicy: input.policy.reviewInvocationPolicy,
    nativeReviewerAvailable: platform === 'unknown' ? false : true,
    manualAttestedAllowed: input.policy.reviewInvocationPolicy !== 'host_task_required',
  });
  const instruction = buildPendingReviewInstruction({
    mode,
    platform,
    reviewKind: 'implementation',
    obligation: input.nextObligation,
    iteration: input.reviewIteration,
    planVersion: input.planVersion,
    subjectLabel: 'implementation summary, changed files, approved plan text, and ticket text',
  });
  const response: Record<string, unknown> = {
    phase: input.finalState.phase,
    status: `Implementation recorded. ${input.files.length} files changed, ${input.domainFiles.length} domain files.`,
    changedFiles: input.files,
    domainFiles: input.domainFiles,
    reviewMode: reduced ? 'reduced_ceremony' : 'subagent',
    ceremonyProfile: input.ceremony.profile,
    ceremonyReason: input.ceremony.reason,
    computedMinimumTaskClass: input.ceremony.computedMinimumTaskClass,
    ...reviewObligationResponseFields(input.nextObligation),
    next: reduced
      ? 'REDUCED_CEREMONY_APPLIED: Runtime evidence classified the changed files as TRIVIAL after passed validation. Reduced-ceremony evidence was recorded; implementation review evidence was not synthesized.'
      : instruction.next,
    ...(reduced ? {} : { reviewInvocation: instruction.reviewInvocation }),
    _audit: { transitions: input.transitions },
  };

  if (input.reviewFindings.length > 0) {
    response.latestImplementationReview = buildLatestImplementationReviewSummary(
      input.reviewFindings,
    );
  }
  return response;
}

async function handleImplRecord(
  input: ImplementRuntime,
  changedFilesOverride?: string[],
): Promise<string> {
  const blocked = validateImplRecordPrerequisites(input);
  if (blocked) return blocked;

  const files = changedFilesOverride ?? (await changedFiles(input.worktree));
  if (files.length === 0) {
    return formatBlocked('IMPLEMENTATION_EVIDENCE_EMPTY', {
      reason: 'no changed files detected in worktree',
    });
  }

  const domainFiles = files.filter(
    (f) => !f.startsWith('.opencode/') && !f.includes('node_modules/'),
  );
  const implEvidence = {
    changedFiles: files,
    domainFiles,
    digest: input.ctx.digest(files.sort().join('\n')),
    executedAt: input.ctx.now(),
  };
  const existingFindings = input.state.implReviewFindings ?? [];
  const newReviewFindings = input.args.reviewFindings
    ? [...existingFindings, input.args.reviewFindings]
    : existingFindings;
  const reviewIteration = nextImplementationReviewIteration(input.state);
  const planVersion = (input.state.plan?.history.length ?? 0) + 1;
  const ceremony = resolveCeremonyProfile({ state: input.state, changedFiles: files });
  const reducedCeremony = ceremony.profile === 'reduced';
  const nextObligation =
    input.subagentEnabled && !reducedCeremony
      ? createReviewObligation({
          obligationType: 'implement',
          iteration: reviewIteration,
          planVersion,
          now: input.ctx.now(),
        })
      : null;
  const nextState: SessionState = {
    ...input.state,
    implementation: implEvidence,
    reducedCeremony: reducedCeremony
      ? {
          profile: 'reduced',
          reason: ceremony.reason,
          claimedTaskClass: ceremony.claimedTaskClass!,
          computedMinimumTaskClass: ceremony.computedMinimumTaskClass,
          touchedSurfaces: [...ceremony.touchedSurfaces],
          decidedAt: input.ctx.now(),
        }
      : null,
    implReview: null,
    implReviewFindings: newReviewFindings.length > 0 ? newReviewFindings : undefined,
    reviewAssurance: appendReviewObligation(input.state.reviewAssurance, nextObligation),
    error: null,
  };
  const { state: finalState, transitions } = autoAdvance(
    nextState,
    (s) => evaluate(s, input.policy),
    input.ctx,
  );
  await writeStateWithArtifacts(input.sessDir, finalState);

  return appendNextAction(
    JSON.stringify(
      buildImplRecordedResponse({
        finalState,
        files,
        domainFiles,
        reviewIteration,
        planVersion,
        nextObligation,
        transitions,
        reviewFindings: newReviewFindings,
        ceremony,
        policy: input.policy,
      }),
    ),
    finalState,
  );
}

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
    { ...input.reviewedState, implementation: null, implReview: null },
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
  const {
    state: finalState,
    evalResult: ev,
    transitions,
  } = autoAdvance(input.reviewedState, (s) => evaluate(s, input.runtime.policy), input.runtime.ctx);
  await writeStateWithArtifacts(input.runtime.sessDir, finalState);

  const response: Record<string, unknown> = {
    phase: finalState.phase,
    implReviewIteration: input.iteration,
    next: input.runtime.args.reviewVerdict === 'approve' ? formatEval(ev) : undefined,
    _audit: { transitions },
  };
  addLatestImplementationReview(response, input.reviewFindings);

  if (input.runtime.args.reviewVerdict === 'approve') {
    response.status = `Implementation review converged at iteration ${input.iteration}. Approved.`;
  } else {
    response.status = `Implementation review reached max iterations (${input.iteration}/${input.runtime.maxImplReviewIterations}). Force-converged.`;
  }
  return appendNextAction(JSON.stringify(response), finalState);
}

async function handleImplReview(input: ImplementRuntime): Promise<string> {
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

async function executeImplement(args: ImplementArgs, context: ToolContext): Promise<string> {
  const flags = classifyImplementArgs(args);

  if (flags.isRecordImpl) {
    const probe = await withMutableSession(context);
    const probeRuntime = buildImplementRuntime({ args, context, ...probe });
    const sequenceBlocked = validateImplementSequence(
      args,
      probe.state,
      flags.hasVerdict,
      flags.hasFindings,
    );
    if (sequenceBlocked) return sequenceBlocked;
    const prereqBlocked = validateImplRecordPrerequisites(probeRuntime);
    if (prereqBlocked) return prereqBlocked;
    const findingsBlocked = validateInitialReviewFindings(probeRuntime);
    if (findingsBlocked) return findingsBlocked;

    // Git/worktree inspection can be slow and must not hold the session write lock.
    const files = await changedFiles(probe.worktree);
    return withMutableSessionTransaction(
      context,
      async ({ worktree, sessDir, state, policy, ctx }) => {
        const runtime = buildImplementRuntime({
          args,
          context,
          worktree,
          sessDir,
          state,
          policy,
          ctx,
        });
        const freshSequenceBlocked = validateImplementSequence(
          args,
          state,
          flags.hasVerdict,
          flags.hasFindings,
        );
        if (freshSequenceBlocked) return freshSequenceBlocked;
        const freshPrereqBlocked = validateImplRecordPrerequisites(runtime);
        if (freshPrereqBlocked) return freshPrereqBlocked;
        const freshFindingsBlocked = validateInitialReviewFindings(runtime);
        if (freshFindingsBlocked) return freshFindingsBlocked;
        return handleImplRecord(runtime, files);
      },
    );
  }

  return withMutableSessionTransaction(
    context,
    async ({ worktree, sessDir, state, policy, ctx }) => {
      const runtime = buildImplementRuntime({
        args,
        context,
        worktree,
        sessDir,
        state,
        policy,
        ctx,
      });
      const sequenceBlocked = validateImplementSequence(
        args,
        state,
        flags.hasVerdict,
        flags.hasFindings,
      );
      if (sequenceBlocked) return sequenceBlocked;

      return handleImplReview(runtime);
    },
  );
}

export const implement: ToolDefinition = {
  description:
    'Record implementation evidence OR submit implementation review verdict. Two modes:\n' +
    'Mode A (record impl): no reviewVerdict. Auto-detects changed files via git. ' +
    'Use AFTER making code changes with read/write/bash tools.\n' +
    "Mode B (review verdict): provide reviewVerdict ('approve' or 'changes_requested'). " +
    'Use at IMPL_REVIEW after reviewing the implementation.\n' +
    'Review loop runs up to maxIterations (from policy). ' +
    'On convergence, auto-advances to EVIDENCE_REVIEW.\n' +
    'Optionally accepts reviewFindings from an independent review agent.',
  args: {
    reviewVerdict: z
      .enum(['approve', 'changes_requested'])
      .optional()
      .describe(
        'Implementation review verdict. Omit to record implementation evidence. ' +
          "'approve' = implementation is correct. " +
          "'changes_requested' = implementation needs revision.",
      ),
    reviewFindings: ReviewFindingsSchema.optional().describe(
      'Structured review findings from independent review. ' +
        'Required when reviewVerdict is "approve" and subagentEnabled=true.',
    ),
    reviewerUnavailable: z
      .boolean()
      .optional()
      .describe(
        'Set to true when the reviewer subagent cannot be invoked (Task tool fails, ' +
          'agent unavailable). Allows self-review fallback in host_task_required mode.',
      ),
  },
  async execute(args, context) {
    try {
      return await executeImplement(args, context);
    } catch (err) {
      return formatError(err);
    }
  },
};
