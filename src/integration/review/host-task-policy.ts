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
import {
  verifyFrozenReviewerContext,
  type FrozenReviewerContext,
} from './frozen-reviewer-context.js';
import { buildReviewerProofContext } from './proof-context.js';
import { buildReviewerArtifactContext } from './reviewer-context.js';
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
import type { ReviewObligation } from '../../state/evidence.js';
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
  readonly materialIntegrityFailure: string | null;
  /**
   * Schema validation errors from a prior failed reviewer invocation for
   * the same obligation. When non-null and non-empty, the canonical retry
   * prompt includes these errors so the reviewer can fix specific issues
   * rather than guessing.
   */
  readonly retrySchemaErrors: readonly string[] | null;
}

function buildHostTaskPolicyOutput(input: HostTaskOutputInput): string | null {
  const { originalOutput, policy, childSessionId } = input;
  const result = parseToolResult(originalOutput);
  if (!result || Array.isArray(result)) return null;
  if (input.materialIntegrityFailure) {
    result.code = 'REVIEW_MATERIAL_INTEGRITY_FAILED';
    result.message = `Frozen review material integrity verification failed: ${input.materialIntegrityFailure}`;
    result.recovery = [
      'Restore the persisted review obligation and material from a trusted source',
      'Create a new standalone review obligation for the intended content',
    ];
    return JSON.stringify(result);
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
    readonly retrySchemaErrors: readonly string[] | null;
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
    challengeContract: opts.challengeContract,
    proofContext: opts.proofContext,
    artifactContext: opts.artifactContext,
    frozenReviewerContext: opts.frozenReviewerContext ?? undefined,
    retrySchemaErrors: opts.retrySchemaErrors ?? undefined,
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

  // F10: hand the agent a canonical, verbatim copy-ready reviewer prompt so it
  // does not free-compose one and omit the iteration=/planVersion= tokens the
  // enforcement matcher requires (the first-attempt SUBAGENT_PROMPT_MISSING_CONTEXT
  // root cause). The prompt embeds the review context via the SAME serializer the
  // matcher validates against. Only emitted when both the attestation and the
  // review context are available.
  const reviewerTaskPrompt = buildReviewerTaskPromptOrNull(attestationMeta, ctx, {
    challengeContract,
    proofContext,
    artifactContext: input.artifactContext,
    frozenReviewerContext: input.frozenReviewerContext,
    retrySchemaErrors: input.retrySchemaErrors,
  });
  const copyPromptStr = reviewerTaskPrompt
    ? ` A ready-to-use reviewer prompt is provided in the reviewerTaskPrompt field — pass it ` +
      `VERBATIM as the Task tool "prompt" argument without appending content, ` +
      `so the required review context is present on the first attempt.`
    : '';

  // Forward the host-authoritative attestation so the agent passes a concrete
  // toolObligationId (UUID) to the reviewer subagent. Without this the
  // standalone /review instruction omitted the attestation, the reviewer
  // defaulted toolObligationId to "NOT_VERIFIED", and the verdict could not bind
  // host-task evidence (HOST_SUBAGENT_TASK_REQUIRED).
  const attestationStr = attestationMeta
    ? ` Required attestation (forward verbatim to the reviewer): ` +
      `toolObligationId=${attestationMeta.toolObligationId}, ` +
      `mandateDigest=${attestationMeta.mandateDigest}, ` +
      `criteriaVersion=${attestationMeta.criteriaVersion}.`
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
  return JSON.stringify(result);
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
    artifactContext: obligation ? buildReviewerArtifactContext(sessionState, obligation) : [],
    frozenReviewerContext,
    materialIntegrityFailure:
      obligation?.obligationType === 'review' && !frozenReviewerContext
        ? 'persisted material or its frozen digest binding is missing or invalid'
        : null,
    retrySchemaErrors,
  };
}

function resolveFrozenReviewerContext(
  obligation: ReviewObligation | null,
  attempt: ReturnType<typeof findBindableAttempt>,
): FrozenReviewerContext | null {
  const verified = verifyFrozenReviewerContext(obligation, attempt?.reviewMaterial);
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
