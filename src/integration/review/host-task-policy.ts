/**
 * @module integration/review/host-task-policy
 * @description Host task policy evaluation and output mutation for review orchestration.
 *
 * Determines whether review should be delegated to a host-visible Task tool
 * subagent call instead of the SDK-driven path.
 */

import { createHash } from 'node:crypto';
import { parseToolResult, getToolOutput } from '../plugin-helpers.js';
import { extractContentMeta } from './enforcement/extraction.js';
import { REVIEWER_SUBAGENT_TYPE } from './enforcement/types.js';
import { renderReviewContext, renderReviewerTaskPrompt } from './prompt-builders.js';
import { rebuildBlockedPresentation } from '../tools/blocked-presentation.js';
import {
  renderArtifactAnchorContract,
  verifyFrozenMaterialForObligation,
  type FrozenReviewerContext,
} from './frozen-reviewer-context.js';
import { buildReviewerProofContext } from './proof-context.js';
import { REVIEW_COMPLETED_PREFIX, extractReviewContext } from './orchestrator.js';
import {
  REASON_HOST_SUBAGENT_TASK_REQUIRED,
  RECOVERY_HOST_SUBAGENT_TASK,
} from '../../shared/flowguard-identifiers.js';
import type { ReviewInvocationPolicy } from '../../config/policy-types.js';
import {
  findReviewObligationById,
  ensureReviewAssurance,
  findBindableAttempt,
} from './assurance.js';
import { updateObligation } from './obligation-state.js';
import type { SessionState } from '../../state/schema.js';
import {
  hasFrozenRepositoryAuthority,
  type RepositoryDiscoverySnapshot,
  type ReviewObligation,
} from '../../state/evidence.js';
import { indexMarkdownSections } from '../../shared/markdown-sections.js';
import type { OrchestratorDeps, ToolCallEvent } from './pipeline-types.js';

// ─── Host Task Policy ────────────────────────────────────────────────────────

/**
 * Attestation/cycle-binding context the host-task instruction must convey to the
 * agent so it can forward a correct, bindable prompt to the flowguard-reviewer
 * subagent. Sourced from the ReviewObligation (host-authoritative), NOT chosen by
 * the agent.
 */
interface HostTaskAttestationMeta {
  readonly toolObligationId: string;
  readonly iteration: number;
  readonly planVersion: number;
  readonly mandateDigest: string;
  readonly criteriaVersion: string;
}

/** Inputs required to render the host-task instruction for one invocation. */
interface HostTaskOutputInput {
  readonly originalOutput: string;
  readonly policy: Extract<ReviewInvocationPolicy, 'host_task_required' | 'host_task_preferred'>;
  readonly childSessionId: string | null;
  readonly attestationMeta: HostTaskAttestationMeta | null;
  /**
   * Attempt the reviewer Task will be bound to. Emitted as `reviewAttemptId` so
   * enforcement tracking can carry it into the pending review; without it the
   * host cannot correlate the child session and reviewer evidence is dropped.
   */
  readonly attemptId: string | null;
  readonly challengeContract: Parameters<typeof renderReviewerTaskPrompt>[0]['challengeContract'];
  readonly proofContext: readonly string[];
  /**
   * Artifact context (approved plan, changed files, executed verification
   * evidence, reviewed-revision provenance) for the reviewer under this
   * obligation. Empty when no obligation could be resolved.
   */
  readonly artifactContext: readonly string[];
  readonly frozenReviewerContext: FrozenReviewerContext | null;
  /**
   * Host-enforced artifact anchor contract for artifact-scoped obligations
   * (plan/ADR). Empty for standalone subjects.
   */
  readonly artifactAnchorContract: readonly string[];
  /**
   * Why no reviewer context could be handed out, when that is the case.
   *
   * `material_integrity` means the persisted bytes or a frozen digest binding
   * are genuinely invalid — the reviewer must NOT be re-run. `attempt_missing`
   * means the material verified fine but no attempt can currently accept a
   * binding; that is a recoverable retry state and must never be reported as an
   * integrity failure, because the recovery paths are opposites.
   */
  readonly reviewerContextFailure: ReviewerContextFailure | null;
  /**
   * Schema validation errors from a prior failed reviewer invocation for
   * the same obligation. When non-null and non-empty, the canonical retry
   * prompt includes these errors so the reviewer can fix specific issues
   * rather than guessing.
   */
  readonly retrySchemaErrors: readonly string[] | null;
  /**
   * Attempt-bound repository Discovery snapshot of the attempt the reviewer
   * will be bound to. For repository reviews this renders the canonical
   * Discovery envelope; null for not_applicable/content attempts.
   */
  readonly repositoryDiscoverySnapshot: RepositoryDiscoverySnapshot | null;
  /**
   * Opaque host-minted observation capability of the attempt the reviewer
   * Task will bind to. Null when no bindable attempt exists or the attempt
   * predates the frozen-repository-authority generation — repository evidence
   * is then unavailable.
   */
  readonly observationCapability: string | null;
  readonly repositoryReview: boolean;
}

/**
 * Why the host could not hand a reviewer context to the agent.
 *
 * Kept as a discriminated union so the two states can never collapse into one
 * output: an integrity failure forbids re-running the reviewer, while a missing
 * attempt is resolved precisely BY re-running the review call.
 */
type ReviewerContextFailure =
  | { readonly kind: 'material_integrity'; readonly reason: string }
  | { readonly kind: 'attempt_missing'; readonly obligationId: string; readonly reason: string };

function applyReviewerContextFailure(
  result: Record<string, unknown>,
  failure: ReviewerContextFailure,
): string {
  if (failure.kind === 'material_integrity') {
    result.code = 'REVIEW_MATERIAL_INTEGRITY_FAILED';
    result.message = `Frozen review material integrity verification failed: ${failure.reason}`;
    result.recovery = [
      'Do not re-run the reviewer: the persisted material no longer matches its frozen digest binding',
      'Restore the persisted review obligation and material from a trusted source',
      'If this obligation predates frozen review material, start a new review cycle; do not reconstruct material from current state or the worktree',
    ];
    return JSON.stringify(refreshBlockedPresentation(result));
  }
  result.code = 'REVIEW_ATTEMPT_UNAVAILABLE';
  result.message =
    `No bindable review attempt exists for obligation ${failure.obligationId}: ${failure.reason}. ` +
    `The frozen review material itself was not invalidated.`;
  result.recovery = [
    'Re-run flowguard_review with the original content fields and reviewObligationId to reissue a bindable attempt',
    'Invoke a new reviewer Task with only subagent_type="flowguard-reviewer"; FlowGuard injects the newly issued canonical prompt',
    'Do NOT submit reviewVerdict or reviewFindings to recover this state',
  ];
  return JSON.stringify(result);
}

/**
 * Re-derive the blocked presentation from the FINAL canonical code after a
 * rewrite so a response never carries two different reason codes. The
 * presentation authority is the shared blocked-presentation builder; the
 * canonical `code`/`recovery` fields drive it.
 */
function refreshBlockedPresentation(result: Record<string, unknown>): Record<string, unknown> {
  const code = typeof result.code === 'string' ? result.code : 'HOST_SUBAGENT_TASK_REQUIRED';
  const rebuilt = rebuildBlockedPresentation(code, String(result.message ?? ''));
  const refreshed: Record<string, unknown> = { ...result };
  if (rebuilt.presentation) refreshed.presentation = rebuilt.presentation;
  else delete refreshed.presentation;
  if (rebuilt.diagnostics) refreshed.diagnostics = rebuilt.diagnostics;
  else delete refreshed.diagnostics;
  return refreshed;
}

function buildHostTaskPolicyOutput(input: HostTaskOutputInput): string | null {
  const { originalOutput, policy, childSessionId } = input;
  const result = parseToolResult(originalOutput);
  if (!result || Array.isArray(result)) return null;
  if (input.reviewerContextFailure) {
    return applyReviewerContextFailure(result, input.reviewerContextFailure);
  }
  if (childSessionId) {
    result.next =
      `${REVIEW_COMPLETED_PREFIX}: Host evidence verified via Task tool subagent call ` +
      `(session ${childSessionId}). Submit ONLY the verdict (reviewVerdict) matching the ` +
      `reviewer's overallVerdict — the captured reviewer evidence is resolved automatically. ` +
      `Do NOT submit, copy, or alter reviewFindings (session-mismatched or hand-edited findings ` +
      `are rejected). For 'changes_requested', also submit the revised artifact. The reviewer ` +
      `verdict is NOT user approval; it only advances to the human review gate.`;
    result.reviewInvocation = {
      policy,
      status: 'host_task_evidence_verified',
      invocationMode: 'host_subagent_task',
      hostVisible: true,
      childSessionId,
    };
    return JSON.stringify(result);
  }

  return buildHostTaskBlockedOutput(result, input);
}

/**
 * Resolve the cycle-binding context (iteration/planVersion) for the host-task
 * instruction. Prefer values already present in the original tool `next` field
 * (plan/implement/architecture carry them there); fall back to the obligation's
 * own values when the originating tool output has no `next` (standalone
 * `/review` emits CONTENT_ANALYSIS_REQUIRED without a `next`).
 */
function resolveHostTaskContext(
  result: Record<string, unknown>,
  attestationMeta: HostTaskAttestationMeta | null,
): { iteration: number; planVersion: number | null } | null {
  const fromNext = typeof result.next === 'string' ? extractContentMeta(result.next) : null;
  if (fromNext) {
    return { iteration: fromNext.expectedIteration, planVersion: fromNext.expectedPlanVersion };
  }
  if (attestationMeta) {
    return { iteration: attestationMeta.iteration, planVersion: attestationMeta.planVersion };
  }
  return null;
}

/**
 * F10: build the canonical copy-ready reviewer prompt when both the
 * host-authoritative attestation and the resolved review context are available;
 * otherwise null. Extracted to keep buildHostTaskBlockedOutput within the
 * complexity budget.
 */
function buildReviewerTaskPromptOrNull(
  attestationMeta: HostTaskAttestationMeta | null,
  ctx: { iteration: number; planVersion: number | null } | null,
  opts: {
    readonly challengeContract: Parameters<typeof renderReviewerTaskPrompt>[0]['challengeContract'];
    readonly proofContext: readonly string[];
    readonly artifactContext: readonly string[];
    readonly frozenReviewerContext: FrozenReviewerContext | null;
    /**
     * Host-enforced artifact anchor contract for artifact-scoped obligations
     * (plan/ADR). Empty for standalone subjects.
     */
    readonly artifactAnchorContract: readonly string[];
    readonly retrySchemaErrors: readonly string[] | null;
    readonly repositoryDiscoverySnapshot: RepositoryDiscoverySnapshot | null;
    readonly observationCapability: string | null;
    readonly repositoryReview: boolean;
  },
): string | null {
  if (!attestationMeta || ctx?.iteration == null) return null;
  return renderReviewerTaskPrompt({
    iteration: ctx.iteration,
    planVersion: ctx.planVersion,
    obligationId: attestationMeta.toolObligationId,
    mandateDigest: attestationMeta.mandateDigest,
    criteriaVersion: attestationMeta.criteriaVersion,
    subjectLabel: 'the artifact under review',
    repositoryReview: opts.repositoryReview,
    challengeContract: opts.challengeContract,
    proofContext: opts.proofContext,
    artifactContext: opts.artifactContext,
    frozenReviewerContext: opts.frozenReviewerContext ?? undefined,
    artifactAnchorContract: opts.artifactAnchorContract,
    retrySchemaErrors: opts.retrySchemaErrors ?? undefined,
    repositoryDiscoverySnapshot: opts.repositoryDiscoverySnapshot,
    ...(opts.observationCapability ? { observationCapability: opts.observationCapability } : {}),
  });
}

function buildHostTaskBlockedOutput(
  result: Record<string, unknown>,
  input: HostTaskOutputInput,
): string {
  const { policy, attestationMeta, challengeContract, proofContext } = input; // The original standalone response is CONTENT_ANALYSIS_REQUIRED and carries
  // manual-findings recovery. Host-task policy replaces that contract entirely:
  // only captured Task evidence plus a matching verdict can complete this path.
  result.code = REASON_HOST_SUBAGENT_TASK_REQUIRED;
  result.message = `Policy requires host-visible Task-tool evidence for ${REVIEWER_SUBAGENT_TYPE}; submit only the captured reviewer verdict after the Task completes.`;
  result.recovery = [RECOVERY_HOST_SUBAGENT_TASK];
  // BUG-16: Preserve iteration/planVersion so the agent can construct a correct
  // subagent prompt that passes promptContainsValue enforcement. Standalone
  // /review (CONTENT_ANALYSIS_REQUIRED) has no `next`, so the values are sourced
  // from the obligation instead (see resolveHostTaskContext). BUG-18: Instruct
  // the reviewer subagent to NOT call FlowGuard tools in its own session.
  const ctx = resolveHostTaskContext(result, attestationMeta);
  const contextSuffix =
    ctx?.iteration != null
      ? renderReviewContext({ iteration: ctx.iteration, planVersion: ctx.planVersion })
      : '';

  // F10: issue the host-injected canonical reviewer prompt so the agent does
  // not free-compose one and omit the iteration=/planVersion= tokens the
  // enforcement matcher requires (the first-attempt SUBAGENT_PROMPT_MISSING_CONTEXT
  // root cause). The prompt embeds the review context via the SAME serializer the
  // matcher validates against. Only emitted when both the attestation and the
  // review context are available.
  const reviewerTaskPrompt = buildReviewerTaskPromptOrNull(attestationMeta, ctx, {
    challengeContract,
    proofContext,
    artifactContext: input.artifactContext,
    frozenReviewerContext: input.frozenReviewerContext,
    artifactAnchorContract: input.artifactAnchorContract,
    retrySchemaErrors: input.retrySchemaErrors,
    repositoryDiscoverySnapshot: input.repositoryDiscoverySnapshot,
    observationCapability: input.observationCapability,
    repositoryReview: input.repositoryReview,
  });
  const copyPromptStr = reviewerTaskPrompt
    ? ` A canonical reviewer prompt is provided in the reviewerTaskPrompt field. Call Task only ` +
      `with subagent_type="${REVIEWER_SUBAGENT_TYPE}"; FlowGuard injects the canonical bytes ` +
      `at the host boundary, so the required review context is present on the first attempt.`
    : '';

  // requiredReviewAttestation is host/parent context. The canonical prompt is
  // the sole reviewer-output contract and contains only toolObligationId.
  const attestationStr = attestationMeta
    ? ` Host context identifies obligation ${attestationMeta.toolObligationId}; do not construct ` +
      `reviewer attestation fields outside reviewerTaskPrompt.`
    : '';

  const fallback =
    policy === 'host_task_required'
      ? 'FALLBACK: If the Task tool cannot spawn the reviewer (error, unavailable agent, or missing infrastructure), do NOT approve and do NOT invent findings — report the transport failure and stop; independent review is mandatory and cannot be self-substituted. Setting reviewerUnavailable: true fails closed (REVIEWER_UNAVAILABLE_STRICT) with recovery guidance; it never approves or enables self-review.'
      : 'FALLBACK: If the Task tool cannot spawn the reviewer during implementation review, do NOT approve and do NOT invent findings. Report the transport failure with flowguard_review_implementation({ reviewerUnavailable: true }) only — no verdict and no reviewFindings. FlowGuard may then use the configured SDK review transport. For other review types, report the transport failure and stop; do not submit copied or fabricated reviewFindings.';
  result.next =
    `INDEPENDENT_REVIEW_REQUIRED: ${policy === 'host_task_required' ? 'Policy requires' : 'Policy prefers'} ` +
    `a host-visible ${REVIEWER_SUBAGENT_TYPE} invocation via the OpenCode Task tool. ` +
    `Call the Task tool with subagent_type="${REVIEWER_SUBAGENT_TYPE}".` +
    (contextSuffix ? ` Context: ${contextSuffix}.` : '') +
    copyPromptStr +
    attestationStr +
    ` The reviewer subagent must NOT call any FlowGuard tools (flowguard_plan, flowguard_implement, flowguard_review_implementation, flowguard_architecture) in its own session.` +
    ` When it returns, submit ONLY the verdict (reviewVerdict) matching the reviewer's overallVerdict — ` +
    `the captured evidence is resolved automatically; do NOT submit, copy, or alter reviewFindings. ` +
    `reviewVerdict is the reviewer's result, NOT user approval, and only advances to the human review gate. ` +
    fallback;

  if (reviewerTaskPrompt) {
    result.reviewerTaskPrompt = reviewerTaskPrompt;
  }

  // Structured attestation so the agent can forward it machine-readably to the
  // reviewer (mirrors pending-instruction.ts requiredReviewAttestation).
  if (attestationMeta) {
    result.requiredReviewAttestation = {
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
      mandateDigest: attestationMeta.mandateDigest,
      criteriaVersion: attestationMeta.criteriaVersion,
      toolObligationId: attestationMeta.toolObligationId,
      iteration: attestationMeta.iteration,
      planVersion: attestationMeta.planVersion,
      ...(input.observationCapability
        ? { observationCapability: input.observationCapability }
        : {}),
    };
  }

  result.reviewInvocation = {
    policy,
    status: policy === 'host_task_required' ? 'blocked_until_host_task' : 'host_task_requested',
    code: REASON_HOST_SUBAGENT_TASK_REQUIRED,
    reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
    invocationMode: 'host_subagent_task',
    hostVisible: true,
    recovery: [RECOVERY_HOST_SUBAGENT_TASK],
  };
  applyBindableAttemptId(result, input.attemptId);
  return JSON.stringify(refreshBlockedPresentation(result));
}

/**
 * Emit the attempt the host binds the reviewer child session to.
 *
 * The record/content tools already carry their own host-authoritative
 * reviewAttemptId; that value is never overwritten here.
 */
function applyBindableAttemptId(result: Record<string, unknown>, attemptId: string | null): void {
  if (!attemptId) return;
  if (typeof result.reviewAttemptId === 'string') return;
  result.reviewAttemptId = attemptId;
}

/**
 * Determine whether the host-task policy should intercept this invocation.
 *
 * Returns `'mutate'` if the output should be rewritten with host-task
 * instructions, or `'fall_through'` if orchestration should continue
 * to the SDK-driven path.
 */
function resolveHostTaskAction(
  invocationPolicy: string | undefined,
  hasReportedTaskTransportFailure: boolean,
  hostEvidence: unknown,
): 'mutate' | 'fall_through' {
  if (invocationPolicy !== 'host_task_required' && invocationPolicy !== 'host_task_preferred') {
    return 'fall_through';
  }
  if (hostEvidence) return 'mutate';
  if (invocationPolicy === 'host_task_required') return 'mutate';
  return hasReportedTaskTransportFailure ? 'fall_through' : 'mutate';
}

function hasReportedTaskTransportFailure(output: ToolCallEvent['output']): boolean {
  const parsed = parseToolResult(getToolOutput(output));
  if (!parsed || Array.isArray(parsed)) return false;
  const failure = parsed.reviewTransportFailure;
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return false;
  const record = failure as Record<string, unknown>;
  return record.transport === 'host_task' && record.reported === true;
}

function serializeDesignEvidence(input: {
  artifactKind: 'plan' | 'adr';
  artifactDigest: string;
  markdown: string;
}): Record<string, unknown>[] {
  return indexMarkdownSections(input.markdown).map((section) => ({
    kind: 'plan_adr_section',
    artifactKind: input.artifactKind,
    artifactDigest: input.artifactDigest,
    sectionPath: section.sectionPath,
    excerptDigest: section.excerptDigest,
  }));
}

function planChallengeEvidence(state: SessionState): Record<string, unknown>[] | undefined {
  const plan = state.plan?.current;
  return plan
    ? serializeDesignEvidence({
        artifactKind: 'plan',
        artifactDigest: plan.digest,
        markdown: plan.body,
      })
    : undefined;
}

function architectureChallengeEvidence(state: SessionState): Record<string, unknown>[] | undefined {
  const adr = state.architecture;
  return adr
    ? serializeDesignEvidence({
        artifactKind: 'adr',
        artifactDigest: adr.digest,
        markdown: adr.adrText,
      })
    : undefined;
}

function implementationChallengeEvidence(
  state: SessionState,
): Record<string, unknown>[] | undefined {
  const implementationDigest = state.implementation?.digest;
  if (!implementationDigest) return undefined;
  const successfulAttempts = state.validationAttempts.filter(
    (attempt) =>
      attempt.scope === 'implementation' &&
      attempt.implementationDigest === implementationDigest &&
      attempt.result.passed,
  );
  if (successfulAttempts.length === 0) return undefined;
  return [
    { kind: 'implementation', implementationDigest },
    ...successfulAttempts.map((attempt) => ({
      kind: 'validation_attempt',
      attemptId: attempt.attemptId,
    })),
  ];
}

function contentChallengeEvidence(
  _state: SessionState,
  obligation: ReviewObligation,
): Record<string, unknown>[] | undefined {
  const digest =
    typeof obligation.metadata?.fingerprint === 'string'
      ? obligation.metadata.fingerprint
      : undefined;
  return digest ? [{ kind: 'content', digest }] : undefined;
}

const CHALLENGE_EVIDENCE_BUILDERS: Record<
  ReviewObligation['obligationType'],
  (state: SessionState, obligation: ReviewObligation) => Record<string, unknown>[] | undefined
> = {
  plan: (state) => planChallengeEvidence(state),
  architecture: (state) => architectureChallengeEvidence(state),
  implement: (state) => implementationChallengeEvidence(state),
  review: contentChallengeEvidence,
};

export function buildHostTaskChallengeContract(
  state: SessionState,
  obligation: ReviewObligation | null,
): Parameters<typeof renderReviewerTaskPrompt>[0]['challengeContract'] {
  if (!obligation || obligation.requiredChallengeCount === undefined) return undefined;
  const base = {
    requiredChallengeCount: obligation.requiredChallengeCount,
    requiredChallengeKind: obligation.requiredChallengeKind,
  };
  if (obligation.requiredChallengeCount === 0) return base;
  const evidenceRefs = CHALLENGE_EVIDENCE_BUILDERS[obligation.obligationType](state, obligation);
  return evidenceRefs ? { ...base, evidenceRefs } : base;
}

function resolveHostTaskInterception(
  sessionState: SessionState,
  obligationId: string,
  output: ToolCallEvent['output'],
): {
  policy: Extract<ReviewInvocationPolicy, 'host_task_required' | 'host_task_preferred'>;
  obligation: ReviewObligation | null;
  childSessionId: string | null;
} | null {
  const invocationPolicy = sessionState.policySnapshot?.reviewInvocationPolicy;
  const obligation = findReviewObligationById(
    ensureReviewAssurance(sessionState.reviewAssurance),
    obligationId,
  );
  const hostEvidence = sessionState.reviewAssurance?.invocations.find(
    (invocation) =>
      invocation.obligationId === obligationId &&
      invocation.invocationMode === 'host_subagent_task' &&
      invocation.hostVisible === true,
  );
  if (
    resolveHostTaskAction(
      invocationPolicy,
      hasReportedTaskTransportFailure(output),
      hostEvidence,
    ) === 'fall_through'
  ) {
    return null;
  }
  return {
    policy: invocationPolicy as Extract<
      ReviewInvocationPolicy,
      'host_task_required' | 'host_task_preferred'
    >,
    obligation,
    childSessionId: hostEvidence?.childSessionId ?? null,
  };
}

function buildHostTaskOutputInput(
  sessionState: SessionState,
  originalOutput: string,
  obligationId: string,
  interception: NonNullable<ReturnType<typeof resolveHostTaskInterception>>,
  retrySchemaErrors: readonly string[] | null,
): HostTaskOutputInput {
  const { obligation } = interception;
  const bindableAttempt = findBindableAttempt(sessionState.reviewAssurance, obligationId);
  const frozenReviewerContext = resolveFrozenReviewerContext(obligation, bindableAttempt);
  return {
    originalOutput,
    policy: interception.policy,
    childSessionId: interception.childSessionId,
    attestationMeta: buildHostTaskAttestationMeta(obligation),
    attemptId: bindableAttempt?.attemptId ?? null,
    challengeContract: buildHostTaskChallengeContract(sessionState, obligation),
    proofContext: buildReviewerProofContext(sessionState),
    artifactContext: [],
    frozenReviewerContext,
    artifactAnchorContract:
      obligation?.reviewSubjectScope?.kind === 'artifact'
        ? renderArtifactAnchorContract(obligation.reviewSubjectScope)
        : [],
    reviewerContextFailure: resolveReviewerContextFailure(
      sessionState,
      obligation,
      bindableAttempt,
      frozenReviewerContext,
    ),
    retrySchemaErrors,
    repositoryDiscoverySnapshot:
      bindableAttempt?.repositoryDiscovery.kind === 'repository'
        ? bindableAttempt.repositoryDiscovery.snapshot
        : null,
    observationCapability: bindableAttempt?.observationCapability ?? null,
    repositoryReview: obligation ? hasFrozenRepositoryAuthority(obligation) : false,
  };
}

/**
 * Classify why no reviewer context is available for a standalone content review.
 *
 * The persisted material is looked up per OBLIGATION, not per bindable attempt.
 * Attempt records carry the material forward, so a rejected or staled attempt
 * still holds intact bytes; deriving integrity purely from the bindable attempt
 * reported an integrity breach whenever the previous attempt had merely been
 * spent, and sent the agent down an unrecoverable restore path.
 */
function resolveReviewerContextFailure(
  sessionState: SessionState,
  obligation: ReviewObligation | null,
  bindableAttempt: ReturnType<typeof findBindableAttempt>,
  frozenReviewerContext: FrozenReviewerContext | null,
): ReviewerContextFailure | null {
  if (!obligation) return null;
  // Single frozen-material authority (prompt emission side): artifact-scoped
  // obligations bind their material generation to the exact artifact subject
  // digest — the same check the output-repair authority enforces.
  const materialCheck = verifyFrozenMaterialForObligation(obligation, obligation.reviewMaterial);
  if (materialCheck.kind === 'blocked') {
    return { kind: 'material_integrity', reason: materialCheck.reason };
  }
  // Artifact-scoped obligations (plan/ADR) carry their reviewer context via
  // the frozen material and the artifact anchor contract — there is no
  // standalone frozen envelope, so a null envelope is not a failure.
  if (obligation.reviewSubjectScope?.kind === 'artifact') return null;
  if (frozenReviewerContext) return null;
  return {
    kind: 'attempt_missing',
    obligationId: obligation.obligationId,
    reason: bindableAttempt
      ? 'the bindable attempt carries no persisted review material'
      : 'every attempt for this obligation is already bound, rejected, staled, or expired',
  };
}

function resolveFrozenReviewerContext(
  obligation: ReviewObligation | null,
  attempt: ReturnType<typeof findBindableAttempt>,
): FrozenReviewerContext | null {
  if (!attempt) return null;
  const verified = verifyFrozenMaterialForObligation(obligation, obligation?.reviewMaterial);
  return verified.kind === 'ok' ? verified.context : null;
}

function buildHostTaskAttestationMeta(
  obligation: ReviewObligation | null,
): HostTaskAttestationMeta | null {
  if (!obligation) return null;
  return {
    toolObligationId: obligation.obligationId,
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
    mandateDigest: obligation.mandateDigest,
    criteriaVersion: obligation.criteriaVersion,
  };
}

// eslint-disable-next-line max-params, complexity
export async function handleHostTaskPolicy(
  deps: OrchestratorDeps,
  sessionState: SessionState,
  sessDir: string,
  reviewCtx: NonNullable<ReturnType<typeof extractReviewContext>>,
  output: ToolCallEvent['output'],
  sessionId: string,
): Promise<boolean> {
  const obligationId = reviewCtx.obligationId;
  const interception = resolveHostTaskInterception(sessionState, obligationId, output);
  if (!interception) return false;

  await deps.updateReviewAssurance(sessDir, (s, now2) =>
    updateObligation(s, obligationId, (item) => ({
      ...item,
      pluginHandshakeAt: now2,
    })),
  );

  // Look up retry schema errors from enforcement state for this obligation
  const enforcement = deps.getEnforcementState(sessionId);
  const pendingReview = [...enforcement.pendingReviews.values()].find(
    (p) => p.obligationId === obligationId,
  );
  const retrySchemaErrors = pendingReview?.lastSchemaErrors ?? null;

  // Store the repair prompt digest so enforceBeforeSubagentCall can
  // verify the prompt was issued by FlowGuard, not fabricated.
  if (pendingReview && retrySchemaErrors && retrySchemaErrors.length > 0) {
    pendingReview.expectedRepairPromptDigest = null; // clear stale
  }

  const rawOutput = getToolOutput(output);
  const mutated = buildHostTaskPolicyOutput(
    buildHostTaskOutputInput(
      sessionState,
      rawOutput,
      obligationId,
      interception,
      retrySchemaErrors,
    ),
  );
  if (mutated) {
    output.output = mutated;
    // Set the repair prompt digest so enforceBeforeSubagentCall can
    // verify the prompt was host-issued, not parent-fabricated.
    if (pendingReview && retrySchemaErrors && retrySchemaErrors.length > 0) {
      const result = parseToolResult(mutated);
      const rtp =
        result && !Array.isArray(result) && typeof result === 'object'
          ? result.reviewerTaskPrompt
          : undefined;
      if (typeof rtp === 'string') {
        pendingReview.expectedRepairPromptDigest = createHash('sha256')
          .update(rtp, 'utf8')
          .digest('hex');
      }
    }
  }
  return true;
}
