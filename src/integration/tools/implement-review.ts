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
  formatEval,
  formatBlocked,
  formatAutoAdvanceOverflow,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers.js';

// State & Machine
import type { SessionState } from '../../state/schema.js';
import { evaluate, evaluateWithEvent } from '../../machine/evaluate.js';
import { implValidationPassed } from '../../machine/guards.js';
import { resolveNextAction } from '../../machine/next-action.js';

// Rail helpers
import { applyTransition, autoAdvance } from '../../rails/types.js';

// Adapters
import { readConfig } from '../../adapters/persistence-config.js';

// Presentation
import {
  buildEvidenceReviewCard,
  PHASE_LABELS,
  buildProductNextAction,
} from '../../presentation/index.js';
import type { EvidenceReviewCardInput } from '../../presentation/evidence-review-card.js';

// Evidence types
import type { LoopVerdict, ReviewFindings } from '../../state/evidence.js';

// Review findings validation (shared with plan.ts)
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import { requireReviewFindings, resolveHostTaskEffectiveFindings } from './review-validation.js';
import { collectPreviouslyUsedChallengeIds } from '../review/challenge-history.js';
import {
  consumeReviewObligation,
  ensureReviewAssurance,
  findAcceptedInvocationForFindings,
  findLatestObligation,
  reviewObligationResponseFields,
} from '../review/assurance.js';
import { buildLatestImplementationReviewSummary } from './review-summary.js';
import { resolveRuntimeReviewPlatform } from '../review/orchestration-mode.js';
import { buildHostTaskChallengeContract } from '../review/host-task-policy.js';
import type { ImplementRuntime } from './implement-shared.js';
import { nextImplementationReviewIteration } from './implement-shared.js';
import { projectImplementationProofStatus } from '../proofgraph/proof-summary-projectors.js';
import type { CompactProofPresentation } from '../../presentation/proof-model.js';
import {
  buildImplReviewBlockedMarkdown,
  buildImplReviewChangesRequestedMarkdown,
} from './implement-review-presentation.js';
export { buildImplReviewChangesRequestedMarkdown } from './implement-review-presentation.js';

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
  | {
      readonly kind: 'blocked';
      readonly response: string;
    }
  | {
      readonly kind: 'proceed';
      readonly proofSummary: CompactProofPresentation;
    };

/**
 * Branch logic for the proof context in a submitted implementation review.
 *
 * 1. If findings are blocked → blocked response with injected proof summary.
 * 2. If changes_requested → proceed with pre-transition (prospective) summary.
 * 3. If accept → proceed with post-review (current_gate) summary.
 *
 * Both the handler and tests call this function. Mutating the branch decisions
 * inside this function will break the corresponding tests.
 */
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

/**
 * Canonical lifecycle projection of implementation-challenge open-state (#747).
 *
 * The open-state of a challenge cannot be read from the last findings entry
 * alone: after a `still_failing`/`not_verified` re-review the reviewer emits
 * FRESH challenges and carries the prior challenge forward only as a
 * `challengeResolutionVerdicts` entry, so the original `implementation_challenge`
 * object is no longer present in the latest `challenges[]`. This projects the
 * whole append-only `implReviewFindings` history:
 *
 *  - origin: a challenge id first seen as an `implementation_challenge` whose
 *    outcome was `fail`/`not_verified`;
 *  - latestVerdict: the MOST RECENT independent `challengeResolutionVerdict` for
 *    that id, in `implReviewFindings` append order (later findings win).
 *
 * A challenge is OPEN iff it has a failing origin AND its latest independent
 * verdict is not `resolved` (no verdict yet ⇒ still open). Author resolutions are
 * advisory and never appear here — they never change open-state.
 *
 * Note (NOT_VERIFIED, by design): ordering uses `implReviewFindings` append
 * position; neither `ChallengeResolutionVerdict` nor `ChallengeResolution`
 * carries an explicit iteration/obligation/flow binding in the schema, so
 * cross-iteration binding is positional plus digest only. A schema-level binding
 * is intentionally out of scope here.
 */
function projectOpenChallengeIds(state: SessionState): ReadonlySet<string> {
  const failingOrigin = new Set<string>();
  const latestVerdict = new Map<string, string>();
  for (const findings of state.implReviewFindings ?? []) {
    projectFindingsChallengeLifecycle(findings, failingOrigin, latestVerdict);
  }
  const open = new Set<string>();
  for (const id of failingOrigin) {
    if (latestVerdict.get(id) !== 'resolved') open.add(id);
  }
  return open;
}

function projectFindingsChallengeLifecycle(
  findings: NonNullable<SessionState['implReviewFindings']>[number],
  failingOrigin: Set<string>,
  latestVerdict: Map<string, string>,
): void {
  for (const challenge of findings.challenges ?? []) {
    if (
      challenge.kind === 'implementation_challenge' &&
      (challenge.outcome === 'fail' || challenge.outcome === 'not_verified')
    ) {
      failingOrigin.add(challenge.challengeId);
    }
  }
  for (const verdict of findings.challengeResolutionVerdicts ?? []) {
    if (findings.overallVerdict !== 'unable_to_review' || verdict.verdict !== 'resolved') {
      latestVerdict.set(verdict.challengeId, verdict.verdict);
    }
  }
}

/** Challenge ids the author has recorded a resolution for against the CURRENT digest. */
function resolvedForCurrentDigestIds(state: SessionState): ReadonlySet<string> {
  return new Set(
    state.challengeResolutions
      .filter((resolution) => resolution.implementationDigest === state.implementation?.digest)
      .map((resolution) => resolution.challengeId),
  );
}

/**
 * The challenges the NEXT independent reviewer MUST classify
 * (`resolved`/`still_failing`/`not_verified`): challenges that are OPEN across
 * the lifecycle AND for which the author HAS recorded a valid resolution against
 * the current implementation digest.
 *
 * #747: an author resolution binds the challenge to new evidence but does NOT
 * close it — closure authority belongs to the next reviewer. These ids are
 * therefore the ones that require an independent verdict, NOT ids to drop.
 */
export function computeTargetedResolutionChallengeIds(state: SessionState): readonly string[] {
  const open = projectOpenChallengeIds(state);
  const resolvedIds = resolvedForCurrentDigestIds(state);
  return [...open].filter((id) => resolvedIds.has(id));
}

/**
 * Open challenges with NO valid author resolution for the current digest. #747
 * forbids acceptance while any such challenge remains unaddressed: the author
 * must first record a resolution (bound to the current implementation digest and
 * a passing validation attempt) before an independent reviewer can close it. The
 * findings-consistency gate fails acceptance closed while this set is non-empty.
 */
export function computeUnaddressedPriorFailIds(state: SessionState): readonly string[] {
  const open = projectOpenChallengeIds(state);
  const resolvedIds = resolvedForCurrentDigestIds(state);
  return [...open].filter((id) => !resolvedIds.has(id));
}

/**
 * Whether `challengeId` is an OPEN implementation challenge across the lifecycle
 * (failing origin, latest independent verdict not `resolved`). Used by the
 * resolution-recording boundary so an author can re-resolve a challenge that a
 * later reviewer marked `still_failing`/`not_verified`, even though the original
 * `implementation_challenge` object is no longer in the latest `challenges[]`.
 */
export function isOpenImplementationChallenge(state: SessionState, challengeId: string): boolean {
  return projectOpenChallengeIds(state).has(challengeId);
}

function resolveImplementationFindings(
  input: ImplementRuntime,
  iteration: number,
  planVersion: number,
) {
  const pendingObligation = findPendingImplObligation(input.state);
  const challengeContract = buildHostTaskChallengeContract(input.state, pendingObligation);
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
      unresolvedImplementationChallengeIds: computeTargetedResolutionChallengeIds(input.state),
      unaddressedPriorFailIds: computeUnaddressedPriorFailIds(input.state),
      allowedChallengeEvidenceRefs: challengeContract?.evidenceRefs,
      previouslyUsedChallengeIds: collectPreviouslyUsedChallengeIds(input.state),
    },
  });
  return { pendingObligation, resolved };
}

function validateEffectiveFindings(
  findings: ReviewFindings | undefined,
  submittedVerdict: LoopVerdict,
  obligationId: string,
): string | null {
  if (!findings) {
    // changes_requested closes the review loop by returning to IMPLEMENTATION,
    // where fresh evidence replaces the stale evidence on the next /implement.
    // It therefore does NOT require bindable reviewer findings to proceed: a
    // reviewer asking for changes must not be able to wedge the session into an
    // unrecoverable IMPL_REVIEW dead-state (no command can leave IMPL_REVIEW once
    // this guard blocks). Only `accept` — which advances to the evidence-review
    // user gate and renders the review card — still requires findings.
    if (submittedVerdict === 'changes_requested') return null;
    return requireReviewFindings(false);
  }
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
      attempts: consumedAssurance.attempts,
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
  proofSummary: CompactProofPresentation;
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
    {
      ...input.reviewedState,
      implementation: null,
      implValidation: [],
      implReview: null,
      reducedCeremony: null,
    },
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
  response.proofSummary = input.proofSummary;
  response.presentation = {
    markdown: buildImplReviewChangesRequestedMarkdown(
      `Implementation review iteration ${input.iteration}/${input.runtime.maxImplReviewIterations}. Changes requested.`,
      input.proofSummary,
      buildProductNextAction(resolveNextAction(finalState.phase, finalState), finalState.phase),
    ),
  };
  return appendNextAction(JSON.stringify(response), finalState);
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
  const { state: finalState, evalResult: ev, transitions } = advanced;
  await writeStateWithArtifacts(input.runtime.sessDir, finalState);

  const response: Record<string, unknown> = {
    phase: finalState.phase,
    implReviewIteration: input.iteration,
    next: input.runtime.args.reviewVerdict === 'accept' ? formatEval(ev) : undefined,
    _audit: { transitions },
  };
  addLatestImplementationReview(response, input.reviewFindings);

  response.proofSummary = input.proofSummary;
  const statusLine =
    input.runtime.args.reviewVerdict === 'accept'
      ? `Implementation review converged at iteration ${input.iteration}. Reviewer accepted.`
      : `Implementation review reached max iterations (${input.iteration}/${input.runtime.maxImplReviewIterations}). Force-converged.`;
  const nextAction = resolveNextAction(finalState.phase, finalState);
  const productNext = buildProductNextAction(nextAction, finalState.phase);
  const latestFindings = input.reviewFindings.at(-1);
  const cardInput: EvidenceReviewCardInput = {
    phaseLabel: PHASE_LABELS[finalState.phase],
    productNextAction: productNext,
    proofSummary: input.proofSummary,
    statusLine,
    forcedConvergence: input.runtime.args.reviewVerdict !== 'accept',
    majorRisks: latestFindings?.majorRisks,
    missingVerification: latestFindings?.missingVerification,
    unknowns: latestFindings?.unknowns,
  };
  response.presentation = {
    markdown: buildEvidenceReviewCard(cardInput, { glyphProfile }),
  };

  if (input.runtime.args.reviewVerdict === 'accept') {
    response.status = `Implementation review converged at iteration ${input.iteration}. Reviewer accepted.`;
  } else {
    response.status = `Implementation review reached max iterations (${input.iteration}/${input.runtime.maxImplReviewIterations}). Force-converged.`;
  }
  return appendNextAction(JSON.stringify(response), finalState);
}

function handlePreferredTaskTransportFailure(
  input: ImplementRuntime,
  pendingObligation: ReturnType<typeof findPendingImplObligation>,
): string {
  if (!pendingObligation)
    return formatBlocked('REVIEW_FINDINGS_REQUIRED', { action: 'implementation review' });
  return appendNextAction(
    JSON.stringify({
      phase: input.state.phase,
      status:
        'OpenCode Task reviewer transport failure reported. Attempting the configured SDK review transport.',
      next: 'INDEPENDENT_REVIEW_REQUIRED: Host Task transport failure was reported for the pending implementation review.',
      ...reviewObligationResponseFields(pendingObligation),
      reviewTransportFailure: { transport: 'host_task', reported: true },
    }),
    input.state,
  );
}

function handleTaskTransportFailureRetry(input: ImplementRuntime): string | null {
  if (input.args.reviewerUnavailable !== true) return null;
  if (input.args.reviewVerdict !== undefined || input.args.reviewFindings !== undefined)
    return null;
  if (input.policy.reviewInvocationPolicy !== 'host_task_preferred') {
    return formatBlocked('REVIEWER_UNAVAILABLE_STRICT', {
      reason: 'reviewer unavailable; independent ReviewFindings remain required',
      recovery:
        'Invoke a supported reviewer transport or provide policy-gated manual_attested ReviewFindings bound to the active obligation. flowguard_decision does not replace review evidence.',
    });
  }
  return handlePreferredTaskTransportFailure(input, findPendingImplObligation(input.state));
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
  if (resolved.blocked) return resolved.blocked;

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

  const iteration = nextImplementationReviewIteration(input.state);
  const planVersion = (input.state.plan?.history.length ?? 0) + 1;
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
  // Active checks present: require a PASSING validation attempt bound to the
  // current implementation digest for EVERY active check. A missing current
  // implementation digest cannot satisfy any check.
  const currentDigest = state.implementation?.digest;
  const passedForCurrentDigest = new Set<string>();
  if (currentDigest) {
    for (const attempt of state.validationAttempts) {
      if (
        attempt.scope === 'implementation' &&
        attempt.implementationDigest === currentDigest &&
        attempt.result.passed
      ) {
        passedForCurrentDigest.add(attempt.result.checkId);
      }
    }
  }
  const missing = state.activeChecks.filter((checkId) => !passedForCurrentDigest.has(checkId));
  return missing.length === 0 ? null : blockValidationEvidence(missing, state);
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
