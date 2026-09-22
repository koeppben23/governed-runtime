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
 * 6. Primary agent submits the review verdict ONLY (flowguard_review_implementation)
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
 *   -> Tool resolves the host-captured findings, records the review iteration,
 *      and checks convergence
 *   -> On convergence: auto-advance to EVIDENCE_REVIEW
 *
 * OR Step 4: LLM calls flowguard_review_implementation({ reviewVerdict: "changes_requested" })
 *   -> LLM makes more code changes, then calls flowguard_implement({}) again
 *
 * @version v5
 */

import { formatBlocked } from '../../blocked-result.js';
import {
  formatAutoAdvanceOverflow,
  enrichWithWorkflowDirective,
  writeStateWithArtifacts,
} from '../helpers.js';
import { existsSync } from 'node:fs';

// State & Machine
import { evaluate } from '../../../machine/evaluate.js';
import { autoAdvance } from '../../../rails/types.js';
import type { ReviewFindings, ImplEvidence } from '../../../state/evidence.js';
import type { SessionState, TaskClass } from '../../../state/schema.js';
import { isCommandAllowed, Command } from '../../../machine/commands.js';

// Rail helpers

// Adapters
import {
  changedFiles,
  GitError,
  hashWorktreeFiles,
  isGitRepoStrict,
  worktreeDiff,
} from '../../../adapters/git.js';
import { computeGitControlPlaneMarker } from '../../git-control-plane.js';
import type { FlowGuardPolicy } from '../../../config/policy.js';
import { writeImplementationDiffArtifact } from './implement-diff-artifact.js';

// Evidence types

import { ensureReviewAssurance } from '../../review/obligations/assurance.js';
import {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from '../../review/dispatch/dispatch-authority.js';
import type { ReviewDispatchAuthority } from '../../review/dispatch/dispatch-authority.js';
import { buildLatestImplementationReviewSummary } from './review-summary.js';
import { collectHistoricallyRejectedImplementationDigests } from '../../review/evidence/rejected-digests.js';
import { resolveCeremonyProfile, isNonDomainConfigPath } from '../../phase-tool-gate.js';
import type { CeremonyProfileDecision } from '../../phase-tool-gate.js';
import type { ImplementRuntime, ImplementationCeremony } from './implement-shared.js';
import {
  hasUnresolvedMutationEpisodes,
  reconcileMutationEpisodes,
} from '../../../state/evidence-mutation-episode.js';
import {
  activateReviewObligationAndPersist,
  buildImplementationReviewInstruction,
  materializeImplReviewContract,
  nextImplementationReviewIteration,
} from '../implementation-review-activation.js';
import { IntegrationInvariantError } from '../../errors.js';

/**
 * The claimed task class a ceremony decision was derived from, fail-closed when
 * a reduced ceremony carries no claim (the profile is unreachable without one).
 */
function requireCeremonyClaimedTaskClass(ceremony: CeremonyProfileDecision): TaskClass | undefined {
  if (ceremony.profile === 'reduced' && ceremony.claimedTaskClass === undefined) {
    throw new IntegrationInvariantError(
      'REDUCED_CEREMONY_TASK_CLASS_MISSING',
      'a reduced ceremony profile requires the claimed task class it was derived from',
    );
  }
  return ceremony.claimedTaskClass;
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
  const resolvedCallIds = new Set(
    input.state.mutationEpisodeResolutions.map((resolution) => resolution.hostCallId),
  );
  const unresolvedEpisodes = input.state.mutationEpisodes.filter(
    (episode) =>
      episode.status === 'dispatch_authorized' && !resolvedCallIds.has(episode.hostCallId),
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
 * all read the worktree via git). Fail closed here BEFORE any git command runs,
 * so a non-Git development worktree surfaces an actionable reason instead of a
 * raw `GIT_COMMAND_FAILED` dead-end after the agent has already made code
 * changes.
 *
 * Error typing (#852): the probe preserves the git diagnosis — a genuine
 * non-repo worktree is blocked with `NOT_GIT_REPO`, while infrastructure
 * failures (missing git executable, git timeout) surface their own reason
 * codes instead of being mislabeled as a repository problem.
 */
export async function validateGitPrerequisite(worktree: string): Promise<string | null> {
  try {
    if (await isGitRepoStrict(worktree)) return null;
  } catch (err) {
    if (err instanceof GitError) {
      // execFile reports a missing cwd as ENOENT, which gitRaw mislabels as
      // GIT_NOT_FOUND. A missing worktree path is definitively not a git
      // repository; every other typed diagnosis is preserved.
      const code =
        err.code === 'GIT_NOT_FOUND' && !existsSync(worktree) ? 'NOT_GIT_REPO' : err.code;
      return formatBlocked(code, { path: worktree, message: err.message, reason: err.message });
    }
    throw err;
  }
  return formatBlocked('NOT_GIT_REPO', { path: worktree });
}

/**
 * Git control-plane binding (#852): the implementation review subject covers
 * worktree content, but `.git` control-plane state (config/hooks/HEAD) is
 * invisible to `git status`. If the live control plane diverges from the
 * baseline frozen at hydrate, the repository effect of some authorized host
 * mutation cannot be part of the implementation subject — recording fails
 * closed instead of certifying uncovered control-plane mutations as bound
 * evidence. Legacy baselines without a marker skip the check.
 */
export async function validateControlPlaneBinding(input: ImplementRuntime): Promise<string | null> {
  const baselineMarker = input.state.implementationBaseline?.controlPlaneMarker;
  if (!baselineMarker) return null;
  let currentMarker: string;
  try {
    currentMarker = await computeGitControlPlaneMarker(input.worktree);
  } catch {
    return formatBlocked('MUTATION_EPISODE_CONTROL_PLANE_UNAVAILABLE');
  }
  if (currentMarker === baselineMarker) return null;
  return formatBlocked('MUTATION_EPISODE_CONTROL_PLANE_MUTATED', {
    marker: currentMarker,
    baselineMarker,
  });
}

function buildImplRecordedResponse(input: {
  finalState: SessionState;
  files: string[];
  domainFiles: string[];
  reviewIteration: number;
  planVersion: number;
  authority: ReviewDispatchAuthority | null;
  transitions: ReadonlyArray<unknown>;
  reviewFindings: ReviewFindings[];
  ceremony: ImplementationCeremony;
  policy: FlowGuardPolicy;
  baselineScoping: 'applied' | 'unavailable';
}): Record<string, unknown> {
  const reduced = input.ceremony.profile === 'reduced';
  const instruction = input.authority
    ? buildImplementationReviewInstruction(input.authority)
    : null;
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
    ...(input.authority ? reviewObligationResponseFields(input.authority) : {}),
    ...(reduced
      ? {
          agentInstruction:
            'REDUCED_CEREMONY_APPLIED: Runtime evidence classified the changed files as TRIVIAL after passed validation. Reduced-ceremony evidence was recorded; implementation review evidence was not synthesized.',
        }
      : {}),
    ...(instruction ? { reviewDispatch: instruction.reviewDispatch } : {}),
    ...(instruction ? { reviewInvocation: instruction } : {}),
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

/**
 * Combined record-path git prerequisites: a non-Git worktree (or a control
 * plane that diverged from the hydrate baseline) blocks BEFORE any git
 * inspection, so no evidence is ever recorded over a mutation the
 * implementation subject cannot cover.
 */
export async function validateRecordGitPrerequisites(
  input: ImplementRuntime,
): Promise<string | null> {
  const gitBlocked = await validateGitPrerequisite(input.worktree);
  if (gitBlocked) return gitBlocked;
  return validateControlPlaneBinding(input);
}

export async function handleImplRecord(
  input: ImplementRuntime,
  changedFilesOverride?: string[],
): Promise<string> {
  const blocked = validateImplRecordPrerequisites(input);
  if (blocked) return blocked;

  const gitBlocked = await validateRecordGitPrerequisites(input);
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
  // Host-captured findings are append-only and only ever written by
  // handleImplReview from the resolved structured evidence.
  const existingFindings = input.state.implReviewFindings ?? [];
  const reviewIteration = nextImplementationReviewIteration(input.state);
  const planVersion = (input.state.plan?.history.length ?? 0) + 1;
  const ceremony = resolveCeremonyProfile({ state: input.state, changedFiles: files });
  const ceremonyClaimedTaskClass = requireCeremonyClaimedTaskClass(ceremony);
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
    reducedCeremony:
      ceremony.profile === 'reduced' && ceremonyClaimedTaskClass !== undefined
        ? {
            profile: 'reduced',
            reason: ceremony.reason,
            claimedTaskClass: ceremonyClaimedTaskClass,
            computedMinimumTaskClass: ceremony.computedMinimumTaskClass,
            touchedSurfaces: [...ceremony.touchedSurfaces],
            decidedAt: input.ctx.now(),
          }
        : null,
    implReview: null,
    implReviewFindings: existingFindings.length > 0 ? existingFindings : undefined,
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
    reviewFindings: existingFindings,
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
  const authority = activated.obligation
    ? resolveReviewDispatchAuthority(persisted.reviewAssurance, activated.obligation.obligationId)
    : null;
  if (authority?.kind === 'blocked') {
    return formatBlocked(authority.code, { reason: authority.reason });
  }
  if (activated.obligation && authority?.kind !== 'ok') {
    return formatBlocked('REVIEW_ATTEMPT_UNAVAILABLE', {
      reason: 'the recorded implementation review obligation has no bindable attempt authority',
    });
  }

  return JSON.stringify(
    enrichWithWorkflowDirective(
      buildImplRecordedResponse({
        finalState: persisted,
        files,
        domainFiles,
        reviewIteration,
        planVersion,
        authority: authority?.authority ?? null,
        transitions,
        reviewFindings: args.reviewFindings,
        ceremony: args.ceremony,
        policy: input.policy,
        baselineScoping: args.baselineScoping,
      }),
      persisted,
    ),
  );
}
