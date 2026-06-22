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
 * Step 4: LLM calls flowguard_review_implementation({ reviewVerdict: "accept", reviewFindings })
 *   -> Tool records review iteration, checks convergence
 *   -> On convergence: auto-advance to EVIDENCE_REVIEW
 *
 * OR Step 4: LLM calls flowguard_review_implementation({ reviewVerdict: "changes_requested" })
 *   -> LLM makes more code changes, then calls flowguard_implement({}) again
 *
 * @version v5
 */

import {
  formatBlocked,
  formatAutoAdvanceOverflow,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers.js';

// State & Machine
import { evaluate } from '../../machine/evaluate.js';
import { autoAdvance } from '../../rails/types.js';
import type { ReviewFindings } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import { isCommandAllowed, Command } from '../../machine/commands.js';

// Rail helpers

// Adapters
import { changedFiles } from '../../adapters/git.js';
import type { FlowGuardPolicy } from '../../config/policy.js';

// Evidence types

// Review findings validation (shared with plan.ts)
import { validateReviewFindings } from './review-validation.js';
import {
  appendReviewObligation,
  createReviewObligation,
  ensureReviewAssurance,
  reviewObligationResponseFields,
} from '../review/assurance.js';
import { buildLatestImplementationReviewSummary } from './review-summary.js';
import { resolveCeremonyProfile } from '../phase-tool-gate.js';
import {
  resolveRuntimeReviewPlatform,
  resolveReviewOrchestrationMode,
} from '../review/orchestration-mode.js';
import { buildPendingReviewInstruction } from '../review/pending-instruction.js';
import type { ImplementRuntime, ImplementationCeremony } from './implement-shared.js';
import { nextImplementationReviewIteration } from './implement-shared.js';
// Mode A
export function validateInitialReviewFindings(input: ImplementRuntime): string | null {
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

export function validateImplRecordPrerequisites(input: ImplementRuntime): string | null {
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

export async function handleImplRecord(
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
  return persistImplRecordAndRespond({
    input,
    nextState,
    files,
    domainFiles,
    reviewIteration,
    planVersion,
    nextObligation,
    reviewFindings: newReviewFindings,
    ceremony,
  });
}

interface PersistImplRecordArgs {
  input: ImplementRuntime;
  nextState: SessionState;
  files: string[];
  domainFiles: string[];
  reviewIteration: number;
  planVersion: number;
  nextObligation: ReturnType<typeof createReviewObligation> | null;
  reviewFindings: ReviewFindings[];
  ceremony: ReturnType<typeof resolveCeremonyProfile>;
}

export async function persistImplRecordAndRespond(args: PersistImplRecordArgs): Promise<string> {
  const { input, nextState, files, domainFiles, reviewIteration, planVersion } = args;
  const advanced = autoAdvance(nextState, (s) => evaluate(s, input.policy), input.ctx);
  // #428: fail closed on overflow BEFORE persisting — no partially-advanced write.
  if (advanced.kind === 'overflow') {
    return formatAutoAdvanceOverflow(advanced);
  }
  const { state: finalState, transitions } = advanced;
  await writeStateWithArtifacts(input.sessDir, finalState);

  return appendNextAction(
    JSON.stringify(
      buildImplRecordedResponse({
        finalState,
        files,
        domainFiles,
        reviewIteration,
        planVersion,
        nextObligation: args.nextObligation,
        transitions,
        reviewFindings: args.reviewFindings,
        ceremony: args.ceremony,
        policy: input.policy,
      }),
    ),
    finalState,
  );
}
