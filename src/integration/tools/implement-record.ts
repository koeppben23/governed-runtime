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
import { resolveNextAction } from '../../machine/next-action.js';
import { autoAdvance } from '../../rails/types.js';
import type { ReviewFindings, ImplEvidence, ReviewObligation } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import { isCommandAllowed, Command } from '../../machine/commands.js';

// Rail helpers

// Adapters
import { changedFiles, hashWorktreeFiles, isGitRepo, worktreeDiff } from '../../adapters/git.js';
import type { FlowGuardPolicy } from '../../config/policy.js';
import { writeImplementationDiffArtifact } from './implement-diff-artifact.js';

// Evidence types

// Review findings validation (shared with plan.ts)
import { validateReviewFindings } from './review-validation.js';
import { collectPreviouslyUsedChallengeIds } from '../review/challenge-history.js';
import { ensureReviewAssurance, reviewObligationResponseFields } from '../review/assurance.js';
import { buildLatestImplementationReviewSummary } from './review-summary.js';
import { collectHistoricallyRejectedImplementationDigests } from '../review/rejected-digests.js';
import { resolveCeremonyProfile, isNonDomainConfigPath } from '../phase-tool-gate.js';
import {
  resolveRuntimeReviewPlatform,
  resolveReviewOrchestrationMode,
} from '../review/orchestration-mode.js';
import { buildPendingReviewInstruction } from '../review/pending-instruction.js';
import { resolveAttemptObservationCapability } from '../review/assurance.js';
import { buildReviewerProofContext } from '../review/proof-context.js';
import type { ImplementRuntime, ImplementationCeremony } from './implement-shared.js';
import {
  hasUnresolvedMutationEpisodes,
  reconcileMutationEpisodes,
} from '../../state/evidence-mutation-episode.js';
import { normalizeHostFindings } from './implement-shared.js';
import {
  activateReviewObligationAndPersist,
  materializeImplReviewContract,
  nextImplementationReviewIteration,
} from './implement-shared.js';
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
  const unresolvedEpisodes = input.state.mutationEpisodes.filter(
    (episode) => episode.status === 'dispatch_authorized',
  );
  if (
    hasUnresolvedMutationEpisodes(
      input.state.mutationEpisodes,
      input.state.mutationEpisodeResolutions,
    )
  ) {
    return formatBlocked('MUTATION_EPISODE_UNRESOLVED', {
      count: String(unresolvedEpisodes.length),
    });
  }
  return null;
}

/**
 * Git prerequisite for recording implementation evidence (#575): recording is
 * git-derived (changed-file detection, content hashes, and the diff artifact
 * all read the worktree via git). Fail closed here with a clear `NOT_GIT_REPO`
 * block BEFORE any git command runs, so a non-Git development worktree surfaces
 * an actionable reason instead of a raw `GIT_COMMAND_FAILED` dead-end after the
 * agent has already made code changes.
 */
export async function validateGitPrerequisite(worktree: string): Promise<string | null> {
  if (await isGitRepo(worktree)) return null;
  return formatBlocked('NOT_GIT_REPO', { path: worktree });
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
        observationCapability: input.nextObligation
          ? (resolveAttemptObservationCapability(
              input.finalState.reviewAssurance,
              input.nextObligation.obligationId,
            ) ?? undefined)
          : undefined,
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
 * hash), so pre-existing worktree changes (e.g. a stale opencode.json) are not
 * attributed to this implementation — while a pre-dirty file the task actually
 * modified (hash changed) is KEPT, never hidden. When no baseline was captured
 * (legacy session / git unreadable at hydrate), do NOT subtract: record the
 * full worktree exactly as before and mark scoping unavailable.
 *
 * Returns the scoped file list plus the scoping status, or an
 * IMPLEMENTATION_EVIDENCE_EMPTY block when nothing remains.
 */
async function scopeImplementationFiles(
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

  // Re-hash the still-present baseline paths; a path is scoped out only if it
  // was pre-dirty and its content hash is unchanged since session start.
  const baselineByPath = new Map(baseline.dirtyFiles.map((d) => [d.path, d.hash]));
  const candidatesToRehash = rawFiles.filter((f) => baselineByPath.has(f));
  const currentHashes =
    candidatesToRehash.length > 0 ? await hashWorktreeFiles(worktree, candidatesToRehash) : {};
  const files = rawFiles.filter((f) => {
    if (!baselineByPath.has(f)) return true; // not pre-dirty → task change
    const before = baselineByPath.get(f) ?? null;
    const now = currentHashes[f] ?? null;
    // Scope out ONLY when both hashes are present and equal (provably unchanged
    // since session start). If either hash is missing, we cannot prove the file
    // is untouched, so we conservatively KEEP it — never hide a change.
    if (before === null || now === null) return true;
    return before !== now; // changed since baseline → keep; unchanged → drop
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

/**
 * Build ImplEvidence with a CONTENT-bound digest and capture the change as a diff
 * artifact.
 *
 * The digest hashes each changed file's CURRENT content (path + git blob hash) so
 * distinct edits to the same file set yield distinct digests — closing the prior
 * gap where the digest was computed over file NAMES only. The unified diff is written
 * to `<sessDir>/implementation-diff.<diffDigest>.patch` (content-addressed, so
 * identical content is idempotent) and covered by the archive manifest checksums;
 * its digest is bound into the evidence. Diff capture is best-effort: an empty
 * diff or a write failure omits `diffDigest` and never blocks recording; the digest
 * is only set when the artifact was successfully written to disk.
 */
async function buildImplEvidence(
  input: ImplementRuntime,
  files: string[],
  domainFiles: string[],
  digest: string,
): Promise<ImplEvidence> {
  let diffDigest: string | undefined;
  const sortedFiles = [...files].sort();
  const diffText = await worktreeDiff(input.worktree, sortedFiles);
  if (diffText.trim().length > 0) {
    const candidateDigest = input.ctx.digest(diffText);
    const written = await writeImplementationDiffArtifact(input.sessDir, candidateDigest, diffText);
    if (written) {
      diffDigest = candidateDigest;
    }
  }

  return {
    changedFiles: files,
    domainFiles,
    digest,
    ...(diffDigest ? { diffDigest } : {}),
    executedAt: input.ctx.now(),
  };
}

async function buildImplementationDigest(
  input: ImplementRuntime,
  files: string[],
): Promise<string> {
  const sortedFiles = [...files].sort();
  const contentHashes = await hashWorktreeFiles(input.worktree, sortedFiles);
  return input.ctx.digest(
    sortedFiles.map((f) => `${f}:${contentHashes[f] ?? 'deleted'}`).join('\n'),
  );
}

function reworkBlock(state: SessionState, digest: string): string | null {
  if (state.implementationRework?.exhausted === true) {
    return formatBlocked('IMPLEMENTATION_REVIEW_EXTENSION_REQUIRED');
  }
  // The single-slot marker covers the immediate round, but the historical
  // projection is the load-bearing check: any digest an independent reviewer
  // EVER rejected (changes_requested, derived from the append-only obligations
  // + bound findings) stays blocked even after a later round closed the marker.
  if (
    collectHistoricallyRejectedImplementationDigests(state).has(digest) ||
    (state.implementationRework?.rejectedDigest ?? null) === digest
  ) {
    return formatBlocked('IMPLEMENTATION_REWORK_REQUIRED');
  }
  return null;
}

export async function handleImplRecord(
  input: ImplementRuntime,
  changedFilesOverride?: string[],
): Promise<string> {
  const blocked = validateImplRecordPrerequisites(input);
  if (blocked) return blocked;

  const gitBlocked = await validateGitPrerequisite(input.worktree);
  if (gitBlocked) return gitBlocked;

  const rawFiles = changedFilesOverride ?? (await changedFiles(input.worktree));
  const scoped = await scopeImplementationFiles(
    input.worktree,
    rawFiles,
    input.state.implementationBaseline,
  );
  if ('block' in scoped) return scoped.block;
  const { files, baselineScoping } = scoped;

  const domainFiles = files.filter(
    (f) => !f.startsWith('.opencode/') && !f.includes('node_modules/') && !isNonDomainConfigPath(f),
  );
  const digest = await buildImplementationDigest(input, files);
  const reworkBlocked = reworkBlock(input.state, digest);
  if (reworkBlocked) return reworkBlocked;
  const implEvidence = await buildImplEvidence(input, files, domainFiles, digest);
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
    mutationEpisodes: reconcileMutationEpisodes(
      input.state.mutationEpisodes,
      input.state.mutationEpisodeResolutions,
      implEvidence.digest,
    ),
    implementation: implEvidence,
    // The rework marker is deliberately NOT cleared here: it carries the digest
    // of the revision the independent reviewer already rejected, and it must
    // survive the re-record (and a subsequent failing fresh revalidation) so
    // that restoring that earlier revision is still blocked. It is closed only
    // when the fresh validation of this record FULLY passes and the machine
    // advances to IMPL_REVIEW (applyTransition closes it on that exact edge).
    implementationRework: input.state.implementationRework,
    // #762: bind the risk classification to the exact revision it describes, so a
    // gate rail can consult it without re-deriving it from a later file set.
    implementationRiskAssessment: {
      computedMinimumTaskClass: ceremony.computedMinimumTaskClass,
      touchedSurfaces: [...ceremony.touchedSurfaces],
      riskTriggers: [...ceremony.riskTriggers],
      assessedFrom: 'implementation_changed_files',
      assessedFileCount: files.length,
      implementationDigest: implEvidence.digest,
    },
    // Fresh implementation invalidates any prior post-implementation checks; the
    // machine advances to IMPL_VALIDATION where the checks are re-run against the
    // new code (prevents a stale IMPL_VALIDATION failure from looping).
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
    baselineScoping,
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
  // #428: fail closed on overflow BEFORE persisting — no partially-advanced write.
  if (advanced.kind === 'overflow') {
    return formatAutoAdvanceOverflow(advanced);
  }
  const { state: finalState, transitions } = advanced;
  const stateWithMaterializedContract = await materializeImplReviewContract(
    finalState,
    input.worktree,
  );
  const activation = await activateReviewObligationAndPersist({
    state: stateWithMaterializedContract,
    preAdvanceState: nextState,
    subagentEnabled: input.subagentEnabled,
    iteration: reviewIteration,
    planVersion,
    now: input.ctx.now(),
    worktree: input.worktree,
    sessDir: input.sessDir,
    locked: false,
    // Mint-gate block: keep the recorded implementation evidence on the
    // first-record path (persisting the IMPLEMENTATION-phase state performs
    // the implementation-entry freeze); persist nothing on the re-record
    // path — an IMPL_REVIEW state without a review obligation is illegal.
    persistPreAdvance: input.state.phase === 'IMPLEMENTATION',
  });
  if ('response' in activation) return activation.response;
  const { activated } = activation;
  // The persisted state carries the REFRESHED ProofGraph derived from the freshly
  // materialized contract; rendering `activated.state` would emit the pre-write
  // projection and understate claim coverage in the reviewer prompt (#762).
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
