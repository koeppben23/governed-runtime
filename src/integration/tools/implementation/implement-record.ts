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
import { randomUUID } from 'node:crypto';
// State & Machine
import { evaluate } from '../../../machine/evaluate.js';
import { autoAdvance } from '../../../rails/types.js';
import type { ReviewFindings, ImplEvidence } from '../../../state/evidence.js';
import type { SessionState } from '../../../state/schema.js';
import { isCommandAllowed, Command } from '../../../machine/commands.js';

// Rail helpers

// Adapters
import { changedFiles, GitError, isGitRepoStrict, worktreeDiff } from '../../../adapters/git.js';
import { computeGitControlPlaneMarker } from '../../git-control-plane.js';
import type { FlowGuardPolicy } from '../../../config/policy.js';
import { writeImplementationDiffArtifact } from './implement-diff-artifact.js';
import {
  computeImplementationDigest,
  flowguardReportArtifacts,
  scopeImplementationFiles,
} from '../../../verification/implementation-subject.js';
import { ensureReviewAssurance } from '../../../state/review-dispatch.js';
import {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from '../../review/dispatch/dispatch-authority.js';
import type { ReviewDispatchAuthority } from '../../review/dispatch/dispatch-authority.js';
import { buildLatestImplementationReviewSummary } from './review-summary.js';
import { collectHistoricallyRejectedImplementationDigests } from '../../review/evidence/rejected-digests.js';
import {
  assessMinimumTaskClass,
  isNonDomainConfigPath,
  projectCeremonyEligibility,
  ticketDeclarationGate,
} from '../../phase-tool-gate.js';
import {
  resolveEffectiveTaskClass,
  ticketRiskDeclarationFloor,
} from '../../../state/risk-declaration.js';
import type { CeremonyEligibilityProjection } from '../../phase-tool-gate.js';
import type { ImplementRuntime } from './implement-shared.js';
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

/**
 * A blocked implementation-recovery state, or null when recovery is allowed.
 */
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
 * evidence. An unavailable baseline marker also blocks recording.
 */
export async function validateControlPlaneBinding(input: ImplementRuntime): Promise<string | null> {
  const baselineMarker = input.state.implementationBaseline.controlPlaneMarker;
  if (baselineMarker === null) return formatBlocked('MUTATION_EPISODE_CONTROL_PLANE_UNAVAILABLE');
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
  files: readonly string[];
  domainFiles: readonly string[];
  reviewIteration: number;
  planVersion: number;
  authority: ReviewDispatchAuthority | null;
  transitions: ReadonlyArray<unknown>;
  reviewFindings: ReviewFindings[];
  ceremony: CeremonyEligibilityProjection;
  policy: FlowGuardPolicy;
  baselineScoping: 'applied' | 'unavailable';
}): Record<string, unknown> {
  const instruction = input.authority
    ? buildImplementationReviewInstruction(input.authority)
    : null;
  const response: Record<string, unknown> = {
    phase: input.finalState.phase,
    status: `Implementation recorded. ${input.files.length} files changed, ${input.domainFiles.length} domain files.`,
    changedFiles: input.files,
    domainFiles: input.domainFiles,
    baselineScoping: input.baselineScoping,
    // The ceremony decision happens after post-implementation verification in
    // /check; /implement never projects a provisional reduction.
    reviewMode: 'subagent',
    ceremonyProfile: 'full',
    ceremonyEligibility: input.ceremony.status,
    ceremonyReason: input.ceremony.reason,
    computedMinimumTaskClass:
      input.finalState.implementationRiskAssessment?.computedMinimumTaskClass,
    ...(input.authority ? reviewObligationResponseFields(input.authority) : {}),
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

async function buildImplEvidence(
  input: ImplementRuntime,
  files: readonly string[],
  domainFiles: readonly string[],
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
    implementationId: randomUUID(),
    changedFiles: [...files],
    domainFiles: [...domainFiles],
    digest,
    ...(diffDigest ? { diffDigest } : {}),
    executedAt: input.ctx.now(),
  };
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

function ticketDeclarationBlocked(state: SessionState): string | null {
  const gate = ticketDeclarationGate(state);
  return gate.status === 'blocked' ? formatBlocked(gate.code, { reason: gate.reason }) : null;
}

function buildImplementationRiskAssessment(
  state: SessionState,
  assessment: ReturnType<typeof assessMinimumTaskClass>,
  implementationDigest: string,
  assessedFileCount: number,
): NonNullable<SessionState['implementationRiskAssessment']> {
  const declaration = state.ticket?.riskDeclaration ?? { kind: 'absent' as const };
  const escalatedTaskClass = state.claimedTaskClass;
  return {
    computedMinimumTaskClass: assessment.minimumTaskClass,
    effectiveTaskClass: resolveEffectiveTaskClass({
      computed: assessment.minimumTaskClass,
      declaration,
      escalated: escalatedTaskClass,
    }),
    declaredTaskClass: ticketRiskDeclarationFloor(declaration),
    declarationKind: declaration.kind,
    ticketDigest: state.ticket?.digest ?? null,
    ...(escalatedTaskClass !== undefined ? { escalatedTaskClass } : {}),
    touchedSurfaces: [...assessment.touchedSurfaces],
    riskTriggers: [...assessment.riskTriggers],
    assessedFrom: 'implementation_changed_files',
    assessedFileCount,
    implementationDigest,
  };
}

export async function handleImplRecord(
  input: ImplementRuntime,
  changedFilesOverride?: string[],
): Promise<string> {
  const blocked = validateImplRecordPrerequisites(input);
  if (blocked) return blocked;

  const gitBlocked = await validateRecordGitPrerequisites(input);
  if (gitBlocked) return gitBlocked;

  // FlowGuard's own per-attempt report files (e.g. baseline VALIDATION
  // run_specific reports written after hydrate) are tool evidence, never
  // governed implementation bytes: subtract the exact candidate-derived paths
  // BEFORE scoping, digest and risk assessment. Not a blanket exclusion —
  // arbitrary project files stay in the set and keep failing closed.
  const toolArtifacts = new Set(flowguardReportArtifacts(input.state));
  const rawFiles = (changedFilesOverride ?? (await changedFiles(input.worktree))).filter(
    (file) => !toolArtifacts.has(file),
  );
  const scoped = await scopeImplementationFiles(
    input.worktree,
    rawFiles,
    input.state.implementationBaseline,
  );
  if (scoped.kind === 'empty') {
    return formatBlocked('IMPLEMENTATION_EVIDENCE_EMPTY', {
      reason:
        scoped.rawFiles.length > 0
          ? 'no changed files attributable to this implementation after baseline scoping (all changed files were already dirty and unchanged since session start)'
          : 'no changed files detected in worktree',
    });
  }
  const { files, baselineScoping } = scoped.subject;

  const domainFiles = files.filter(
    (f) => !f.startsWith('.opencode/') && !f.includes('node_modules/') && !isNonDomainConfigPath(f),
  );
  const digest = await computeImplementationDigest({
    worktree: input.worktree,
    files,
    digest: input.ctx.digest,
  });
  const reworkBlocked = reworkBlock(input.state, digest);
  if (reworkBlocked) return reworkBlocked;
  const implEvidence = await buildImplEvidence(input, files, domainFiles, digest);
  // Host-captured findings are append-only and only ever written by
  // handleImplReview from the resolved structured evidence.
  const existingFindings = input.state.implReviewFindings ?? [];
  const reviewIteration = nextImplementationReviewIteration(input.state);
  const planVersion = (input.state.plan?.history.length ?? 0) + 1;
  const declarationBlocked = ticketDeclarationBlocked(input.state);
  if (declarationBlocked !== null) return declarationBlocked;
  const ceremony = projectCeremonyEligibility({ state: input.state, changedFiles: files });
  const assessment = assessMinimumTaskClass(files);
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
    implementationRiskAssessment: buildImplementationRiskAssessment(
      input.state,
      assessment,
      implEvidence.digest,
      files.length,
    ),
    // Fresh implementation invalidates any prior post-implementation checks; the
    // machine advances to IMPL_VALIDATION where the checks are re-run against the
    // new code (prevents a stale IMPL_VALIDATION failure from looping).
    implValidation: [],
    // #819: the ceremony decision is made only after post-implementation
    // verification, in /check, against the freshly merged check state. A new
    // implementation always invalidates any prior decision.
    reducedCeremony: null,
    implReview: null,
    implReviewFindings: existingFindings,
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
  files: readonly string[];
  domainFiles: readonly string[];
  reviewIteration: number;
  planVersion: number;
  reviewFindings: ReviewFindings[];
  ceremony: CeremonyEligibilityProjection;
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
