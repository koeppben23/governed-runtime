/**
 * @module integration/tools/implement-record
 * @description FlowGuard implement tool — record implementation evidence bound to an
 *              immutable ImplementationCandidate.
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
 * @version v6
 */

import {
  formatBlocked,
  formatAutoAdvanceOverflow,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers.js';

// State & Machine
import { evaluate } from '../../machine/evaluate.js';
import { resolveNextAction } from '../../machine/next-action.js';
import { autoAdvance } from '../../rails/types.js';
import type { ReviewFindings, ImplEvidence, ReviewObligation } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import { isCommandAllowed, Command } from '../../machine/commands.js';

// Adapters
import { hashWorktreeFiles } from '../../adapters/git.js';
import type { FlowGuardPolicy } from '../../config/policy.js';
import { writeImplementationDiffArtifact } from './implement-diff-artifact.js';
import type { CapturedImplementationCandidate } from '../implementation-candidate.js';

// Review findings validation (shared with plan.ts)
import { validateReviewFindings } from './review-validation.js';
import { collectPreviouslyUsedChallengeIds } from '../review/challenge-history.js';
import { ensureReviewAssurance, reviewObligationResponseFields } from '../review/assurance.js';
import { buildLatestImplementationReviewSummary } from './review-summary.js';
import { resolveCeremonyProfile, isNonDomainConfigPath } from '../phase-tool-gate.js';
import {
  resolveRuntimeReviewPlatform,
  resolveReviewOrchestrationMode,
} from '../review/orchestration-mode.js';
import { buildPendingReviewInstruction } from '../review/pending-instruction.js';
import { buildReviewerProofContext } from '../review/proof-context.js';
import type { ImplementRuntime, ImplementationCeremony } from './implement-shared.js';
import { normalizeHostFindings } from './implement-shared.js';
import {
  activateImplementationReviewObligation,
  nextImplementationReviewIteration,
} from './implement-shared.js';
import { materializeApprovedPlanContractResult } from '../proofgraph/materialize-contract.js';

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
    previouslyUsedChallengeIds: collectPreviouslyUsedChallengeIds(input.state),
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
  nextObligation: ReviewObligation | null;
  transitions: ReadonlyArray<unknown>;
  reviewFindings: ReviewFindings[];
  ceremony: ImplementationCeremony;
  policy: FlowGuardPolicy;
  baselineScoping: 'applied' | 'unavailable';
}): Record<string, unknown> {
  const reduced = input.ceremony.profile === 'reduced';
  const platform = resolveRuntimeReviewPlatform();
  const mode = resolveReviewOrchestrationMode({
    platform,
    reviewInvocationPolicy: input.policy.reviewInvocationPolicy,
    nativeReviewerAvailable: platform === 'unknown' ? false : true,
    manualAttestedAllowed: input.policy.reviewInvocationPolicy !== 'host_task_required',
  });
  const instruction = input.nextObligation
    ? buildPendingReviewInstruction({
        mode,
        platform,
        reviewKind: 'implementation',
        obligation: input.nextObligation,
        iteration: input.reviewIteration,
        planVersion: input.planVersion,
        subjectLabel: 'implementation summary, changed files, approved plan text, and ticket text',
        proofContext: buildReviewerProofContext(input.finalState),
      })
    : null;
  const nextAction = resolveNextAction(input.finalState.phase, input.finalState);
  const response: Record<string, unknown> = {
    phase: input.finalState.phase,
    status: `Implementation recorded. ${input.files.length} files changed, ${input.domainFiles.length} domain files.`,
    changedFiles: input.files,
    domainFiles: input.domainFiles,
    baselineScoping: input.baselineScoping,
    reviewMode: reduced ? 'reduced_ceremony' : 'subagent',
    ceremonyProfile: input.ceremony.profile,
    ceremonyReason: input.ceremony.reason,
    computedMinimumTaskClass: input.ceremony.computedMinimumTaskClass,
    ...reviewObligationResponseFields(input.nextObligation),
    next: reduced
      ? 'REDUCED_CEREMONY_APPLIED: Runtime evidence classified the changed files as TRIVIAL after passed validation. Reduced-ceremony evidence was recorded; implementation review evidence was not synthesized.'
      : (instruction?.next ?? nextAction.text),
    ...(instruction ? { reviewInvocation: instruction.reviewInvocation } : {}),
    _audit: { transitions: input.transitions },
  };

  if (input.reviewFindings.length > 0) {
    response.latestImplementationReview = buildLatestImplementationReviewSummary(
      input.reviewFindings,
    );
  }
  return response;
}

/**
 * Apply pre-implementation baseline scoping (#baseline): subtract files that
 * were already dirty at session start AND are still unchanged (same content
 * hash), so pre-existing worktree changes are not attributed to this
 * implementation. When no baseline was captured, the full worktree is recorded
 * and scoping is marked unavailable.
 */
export async function scopeImplementationFiles(
  worktree: string,
  rawFiles: string[],
  baseline: SessionState['implementationBaseline'],
): Promise<{ files: string[]; baselineScoping: 'applied' | 'unavailable' } | { block: string }> {
  if (!baseline) {
    if (rawFiles.length === 0) {
      return {
        block: formatBlocked('IMPLEMENTATION_EVIDENCE_EMPTY', {
          reason: 'no changed files detected in worktree',
        }),
      };
    }
    return { files: rawFiles, baselineScoping: 'unavailable' };
  }

  const baselineByPath = new Map(baseline.dirtyFiles.map((d) => [d.path, d.hash]));
  const candidatesToRehash = rawFiles.filter((f) => baselineByPath.has(f));
  const currentHashes =
    candidatesToRehash.length > 0 ? await hashWorktreeFiles(worktree, candidatesToRehash) : {};
  const files = rawFiles.filter((f) => {
    if (!baselineByPath.has(f)) return true;
    const before = baselineByPath.get(f) ?? null;
    const now = currentHashes[f] ?? null;
    if (before === null || now === null) return true;
    return before !== now;
  });

  if (files.length === 0) {
    return {
      block: formatBlocked('IMPLEMENTATION_EVIDENCE_EMPTY', {
        reason:
          rawFiles.length > 0
            ? 'no changed files attributable to this implementation after baseline scoping (all changed files were already dirty and unchanged since session start)'
            : 'no changed files detected in worktree',
      }),
    };
  }
  return { files, baselineScoping: 'applied' };
}

export async function handleImplRecord(
  input: ImplementRuntime,
  capturedCandidate: CapturedImplementationCandidate,
  scoping: 'applied' | 'unavailable' = 'unavailable',
): Promise<string> {
  const blocked = validateImplRecordPrerequisites(input);
  if (blocked) return blocked;

  const files = [...capturedCandidate.identity.changedPaths] as string[];

  const domainFiles = files.filter(
    (f) => !f.startsWith('.opencode/') && !f.includes('node_modules/') && !isNonDomainConfigPath(f),
  );

  // Persist the exact diff bytes from the captured candidate. No second git diff.
  const diffDigest = capturedCandidate.identity.diffDigest;
  const diffText = capturedCandidate.candidateDiffBytes.toString('utf-8');
  if (diffText.trim().length > 0) {
    await writeImplementationDiffArtifact(input.sessDir, diffDigest, diffText);
  }

  const implEvidence: ImplEvidence = {
    candidate: capturedCandidate.identity,
    domainFiles,
    executedAt: input.ctx.now(),
  };

  const existingFindings = input.state.implReviewFindings ?? [];
  const newReviewFindings = input.args.reviewFindings
    ? [...existingFindings, normalizeHostFindings(input.args.reviewFindings)]
    : existingFindings;
  const reviewIteration = nextImplementationReviewIteration(input.state);
  const planVersion = (input.state.plan?.history.length ?? 0) + 1;
  const ceremony = resolveCeremonyProfile({ state: input.state, changedFiles: files });
  const reducedCeremony = ceremony.profile === 'reduced';
  const nextState: SessionState = {
    ...input.state,
    implementation: implEvidence,
    implementationRiskAssessment: {
      computedMinimumTaskClass: ceremony.computedMinimumTaskClass,
      touchedSurfaces: [...ceremony.touchedSurfaces],
      riskTriggers: [...ceremony.riskTriggers],
      assessedFrom: 'implementation_changed_files',
      assessedFileCount: files.length,
      implementationDigest: capturedCandidate.identity.candidateDigest,
    },
    implValidation: [],
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
    reviewAssurance: input.state.reviewAssurance,
    error: null,
  };
  return persistImplRecordAndRespond({
    input,
    nextState,
    files,
    domainFiles,
    reviewIteration,
    planVersion,
    reviewFindings: newReviewFindings,
    ceremony,
    baselineScoping: scoping,
  });
}

interface PersistImplRecordArgs {
  input: ImplementRuntime;
  nextState: SessionState;
  files: string[];
  domainFiles: string[];
  reviewIteration: number;
  planVersion: number;
  reviewFindings: ReviewFindings[];
  ceremony: ReturnType<typeof resolveCeremonyProfile>;
  baselineScoping: 'applied' | 'unavailable';
}

export async function persistImplRecordAndRespond(args: PersistImplRecordArgs): Promise<string> {
  const { input, nextState, files, domainFiles, reviewIteration, planVersion } = args;
  const advanced = autoAdvance(nextState, (s) => evaluate(s, input.policy), input.ctx);
  if (advanced.kind === 'overflow') {
    return formatAutoAdvanceOverflow(advanced);
  }
  const { state: finalState, transitions } = advanced;
  const materialized =
    finalState.phase === 'IMPL_REVIEW'
      ? await materializeApprovedPlanContractResult(finalState, input.worktree)
      : null;
  const stateWithMaterializedContract = materialized
    ? {
        ...finalState,
        proofContract: materialized.contract,
        proofContractCoverage: [...materialized.coverage],
      }
    : finalState;
  const activated = await activateImplementationReviewObligation(stateWithMaterializedContract, {
    subagentEnabled: input.subagentEnabled,
    iteration: reviewIteration,
    planVersion,
    now: input.ctx.now(),
    worktree: input.worktree,
  });
  const persisted = await writeStateWithArtifacts(input.sessDir, activated.state);

  return appendNextAction(
    JSON.stringify(
      buildImplRecordedResponse({
        finalState: persisted,
        files,
        domainFiles,
        reviewIteration,
        planVersion,
        nextObligation: activated.obligation,
        transitions,
        reviewFindings: args.reviewFindings,
        ceremony: args.ceremony,
        policy: input.policy,
        baselineScoping: args.baselineScoping,
      }),
    ),
    persisted,
  );
}
