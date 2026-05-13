/**
 * @module integration/plugin-orchestrator
 * @description Deterministic review subagent orchestration — extracted from plugin.ts.
 *
 * Invokes the flowguard-reviewer subagent via the OpenCode SDK client when a
 * FlowGuard tool response signals INDEPENDENT_REVIEW_REQUIRED. Handles:
 * - Review obligation creation + audit
 * - Prompt building (plan, architecture, or impl)
 * - Subagent invocation
 * - Structured findings validation (P35 strict / non-strict)
 * - Evidence recording with reuse detection
 * - Output mutation (strict blocked or success)
 *
 * @version v2
 */

import { readState } from '../adapters/persistence.js';
import { ReviewFindings as ReviewFindingsSchema } from '../state/evidence.js';
import type { ReviewObligationType } from '../state/evidence.js';
import type { CapturedFindings, SessionEnforcementState } from './review-enforcement-types.js';
import { recordPluginReview } from './review-enforcement.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  buildInvocationEvidence,
  ensureReviewAssurance,
  findReviewObligationById,
  hasEvidenceReuse,
  hashFindings,
  hashText,
  appendInvocationEvidence,
} from './review-assurance.js';
import {
  isReviewRequired,
  extractReviewContext,
  invokeReviewer,
  buildMutatedOutput,
  buildReviewContentMutatedOutput,
  REVIEW_COMPLETED_PREFIX,
  type OrchestratorClient,
  type ReviewerSuccessResult,
} from './review-orchestrator.js';
import {
  buildPlanReviewPrompt,
  buildImplReviewPrompt,
  buildArchitectureReviewPrompt,
  buildReviewContentPrompt,
  selectReviewerProfileRules,
} from './review-prompt-builders.js';
import {
  getToolOutput,
  getToolArgs,
  parseToolResult,
  strictBlockedOutput,
} from './plugin-helpers.js';
import { loadExternalContent } from '../rails/review.js';
import { TOOL_FLOWGUARD_REVIEW } from './tool-names.js';
import { updateObligation } from './plugin-review-state.js';
import { appendReviewAuditEvent } from './plugin-review-audit.js';
import {
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_ARCHITECTURE,
} from './tool-names.js';
import { obligationTypeForTool } from './review-obligation-tools.js';
import { REVIEWER_SUBAGENT_TYPE } from './review-enforcement-types.js';
import { extractContentMeta } from './review-enforcement-extraction.js';
import type { SessionState } from '../state/schema.js';
import type { ReviewSessionContext } from './plugin-workspace.js';
import type { ReviewInvocationPolicy, ReviewOutputPolicy } from '../config/policy-types.js';
import {
  REASON_HOST_SUBAGENT_TASK_REQUIRED,
  RECOVERY_HOST_SUBAGENT_TASK,
} from '../shared/flowguard-identifiers.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Invocation mode for SDK-driven session prompts (not host-visible). */
const INVOCATION_MODE_SDK_SESSION = 'sdk_session_prompt' as const;

/** Evidence source tag for host-orchestrated reviews. */
const EVIDENCE_SOURCE_HOST = 'host-orchestrated' as const;

// ─── Public interfaces ───────────────────────────────────────────────────────

/**
 * Dependency interface for closure-captured values in plugin.ts.
 */
export interface OrchestratorDeps {
  resolveFingerprint(): Promise<string | null>;
  getSessionDir(sessionId: string): string | null;
  updateReviewAssurance(
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
  ): Promise<void>;
  blockReviewOutcome(
    ctx: ReviewSessionContext,
    obligationId: string,
    code: string,
    detail: Record<string, string>,
    output: { output: string },
  ): Promise<void>;
  getEnforcementState(sessionId: string): SessionEnforcementState;
  log: {
    info(service: string, message: string, extra?: Record<string, unknown>): void;
    warn(service: string, message: string, extra?: Record<string, unknown>): void;
  };
  client: OrchestratorClient;
}

/**
 * Tool invocation captured by the plugin hook.
 *
 * Bundles the input and output from tool.execute.after
 * into a single object for cleaner function signatures.
 */
export interface ToolCallEvent {
  readonly toolName: string;
  readonly input: unknown;
  readonly output: { output: string };
  readonly sessionId: string;
  readonly now: string;
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface ValidatedSession {
  sessionState: SessionState;
  sessDir: string;
  reviewCtx: NonNullable<ReturnType<typeof extractReviewContext>>;
  parsedOutput: ReturnType<typeof parseToolResult> & Record<string, unknown>;
  strictEnforcement: boolean | null;
}

/** Shared context passed to pipeline functions after validation. */
interface PipelineContext {
  deps: OrchestratorDeps;
  sessionState: SessionState;
  sessDir: string;
  reviewCtx: NonNullable<ReturnType<typeof extractReviewContext>>;
  parsedOutput: ReturnType<typeof parseToolResult> & Record<string, unknown>;
  output: { output: string };
  sessionId: string;
  now: string;
  rawOutput: string;
  strictEnforcement: boolean;
}

/** Result of strict attestation validation. */
type AttestationResult =
  | { valid: true }
  | { valid: false; code: string; detail: Record<string, string> };

/** Result of evidence recording (reuse detection + fulfillment). */
type EvidenceRecordResult = 'fulfilled' | 'reused';

// ─── Host Task Policy ────────────────────────────────────────────────────────

function buildHostTaskPolicyOutput(
  originalOutput: string,
  policy: Extract<ReviewInvocationPolicy, 'host_task_required' | 'host_task_preferred'>,
  childSessionId: string | null,
): string | null {
  const result = parseToolResult(originalOutput);
  if (!result || Array.isArray(result)) return null;
  if (childSessionId) {
    result.next =
      `${REVIEW_COMPLETED_PREFIX}: Host evidence verified via Task tool subagent call ` +
      `(session ${childSessionId}). Submit the verdict with the exact ReviewFindings from ` +
      `the subagent response.`;
    result.reviewInvocation = {
      policy,
      status: 'host_task_evidence_verified',
      invocationMode: 'host_subagent_task',
      hostVisible: true,
      childSessionId,
    };
    return JSON.stringify(result);
  }

  return buildHostTaskBlockedOutput(result, policy);
}

function buildHostTaskBlockedOutput(
  result: Record<string, unknown>,
  policy: Extract<ReviewInvocationPolicy, 'host_task_required' | 'host_task_preferred'>,
): string {
  // BUG-16: Preserve iteration/planVersion from the original next field so
  // the agent can construct a correct subagent prompt that passes
  // promptContainsValue enforcement. BUG-18: Instruct the reviewer subagent
  // to NOT call FlowGuard tools in its own session.
  const originalMeta = typeof result.next === 'string' ? extractContentMeta(result.next) : null;
  const iterStr =
    originalMeta?.expectedIteration != null ? `iteration=${originalMeta.expectedIteration}` : '';
  const versionStr =
    originalMeta?.expectedPlanVersion != null
      ? `planVersion=${originalMeta.expectedPlanVersion}`
      : '';
  const contextSuffix = [iterStr, versionStr].filter(Boolean).join(', ');

  result.next =
    `INDEPENDENT_REVIEW_REQUIRED: ${policy === 'host_task_required' ? 'Policy requires' : 'Policy prefers'} ` +
    `a host-visible ${REVIEWER_SUBAGENT_TYPE} invocation via the OpenCode Task tool. ` +
    `Call the Task tool with subagent_type="${REVIEWER_SUBAGENT_TYPE}" and submit the exact ` +
    `ReviewFindings returned by that subagent.` +
    (contextSuffix ? ` Context: ${contextSuffix}.` : '') +
    ` The reviewer subagent must NOT call any FlowGuard tools (flowguard_plan, flowguard_implement, flowguard_architecture) in its own session.` +
    ` FALLBACK: If the Task tool cannot spawn the reviewer (error, unavailable agent, or missing infrastructure), ` +
    `submit your selfReviewVerdict directly with reviewerUnavailable: true. This proceeds with self-review assurance.`;
  result.reviewInvocation = {
    policy,
    status: policy === 'host_task_required' ? 'blocked_until_host_task' : 'host_task_requested',
    code: REASON_HOST_SUBAGENT_TASK_REQUIRED,
    reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
    invocationMode: 'host_subagent_task',
    hostVisible: true,
    recovery: [RECOVERY_HOST_SUBAGENT_TASK],
  };
  return JSON.stringify(result);
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
  isRetry: boolean,
  hostEvidence: unknown,
): 'mutate' | 'fall_through' {
  if (invocationPolicy !== 'host_task_required' && invocationPolicy !== 'host_task_preferred') {
    return 'fall_through';
  }
  if (hostEvidence) return 'mutate';
  if (invocationPolicy === 'host_task_required') return 'mutate';
  if (!isRetry) return 'mutate';
  return 'fall_through';
}

async function handleHostTaskPolicy(
  deps: OrchestratorDeps,
  sessionState: SessionState,
  sessDir: string,
  reviewCtx: NonNullable<ReturnType<typeof extractReviewContext>>,
  output: ToolCallEvent['output'],
): Promise<boolean> {
  const invocationPolicy = sessionState.policySnapshot?.reviewInvocationPolicy;

  const obligationId = reviewCtx.obligationId;
  const preUpdateObligation = findReviewObligationById(
    ensureReviewAssurance(sessionState.reviewAssurance),
    obligationId,
  );
  const isRetry = preUpdateObligation?.pluginHandshakeAt !== null;

  const invocations = sessionState.reviewAssurance?.invocations ?? [];
  const hostEvidence = invocations.find(
    (inv) =>
      inv.obligationId === obligationId &&
      inv.invocationMode === 'host_subagent_task' &&
      inv.hostVisible === true,
  );

  const action = resolveHostTaskAction(invocationPolicy, isRetry, hostEvidence);
  if (action === 'fall_through') return false;

  await deps.updateReviewAssurance(sessDir, (s, now2) =>
    updateObligation(s, obligationId, (item) => ({
      ...item,
      pluginHandshakeAt: now2,
    })),
  );

  const rawOutput = getToolOutput(output);
  const typedPolicy = invocationPolicy as Extract<
    ReviewInvocationPolicy,
    'host_task_required' | 'host_task_preferred'
  >;
  const childSessionId = hostEvidence
    ? (hostEvidence as { childSessionId: string }).childSessionId
    : null;
  const mutated = buildHostTaskPolicyOutput(rawOutput, typedPolicy, childSessionId);
  if (mutated) output.output = mutated;
  return true;
}

// ─── Session Validation ──────────────────────────────────────────────────────

async function validateSessionContext(
  deps: OrchestratorDeps,
  output: ToolCallEvent['output'],
  toolName: string,
  sessionId: string,
): Promise<ValidatedSession | null> {
  await deps.resolveFingerprint();
  const sessDir = deps.getSessionDir(sessionId);

  if (!sessDir) {
    output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason: 'session directory unavailable for strict review orchestration',
    });
    return null;
  }
  const sessionState = await readState(sessDir);
  if (!sessionState) {
    output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason: 'session state unavailable for strict review orchestration',
    });
    return null;
  }

  const rawOutput = getToolOutput(output);
  const parsedOutput = parseToolResult(rawOutput);
  if (!parsedOutput || Array.isArray(parsedOutput)) {
    output.output = strictBlockedOutput('STRICT_REVIEW_ORCHESTRATION_FAILED', {
      reason: 'review-required tool output could not be parsed for strict orchestration',
    });
    return null;
  }
  const reviewCtx = extractReviewContext(toolName, parsedOutput);
  let strictEnforcement: boolean | null = null;
  if (!reviewCtx) {
    strictEnforcement = sessionState?.policySnapshot?.selfReview?.strictEnforcement === true;
    if (strictEnforcement) {
      output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
        reason: 'review context missing for strict orchestration',
      });
    }
    return null;
  }

  return { sessionState, sessDir, reviewCtx, parsedOutput, strictEnforcement };
}

// ─── Prompt Building ─────────────────────────────────────────────────────────

interface BuildToolPromptParams {
  toolName: string;
  texts: { planText: string; ticketText: string; adrText: string; adrTitle: string };
  reviewCtx: NonNullable<ReturnType<typeof extractReviewContext>>;
  parsedOutput: ReturnType<typeof parseToolResult> & Record<string, unknown>;
  sessionState: SessionState;
  rules: {
    planRules: ReturnType<typeof selectReviewerProfileRules>;
    implRules: ReturnType<typeof selectReviewerProfileRules>;
    archRules: ReturnType<typeof selectReviewerProfileRules>;
  };
  deps: OrchestratorDeps;
}

function buildToolPrompt(params: BuildToolPromptParams): string | null {
  const { toolName, texts, reviewCtx, parsedOutput, sessionState, rules, deps } = params;
  const { planText, ticketText, adrText, adrTitle } = texts;
  const { planRules, implRules, archRules } = rules;
  if (toolName === TOOL_FLOWGUARD_PLAN) {
    return buildPlanReviewPrompt({
      planText,
      ticketText,
      iteration: reviewCtx.iteration,
      planVersion: reviewCtx.planVersion,
      obligationId: reviewCtx.obligationId,
      criteriaVersion: reviewCtx.criteriaVersion,
      mandateDigest: reviewCtx.mandateDigest,
      ...planRules,
    });
  }
  if (toolName === TOOL_FLOWGUARD_IMPLEMENT) {
    return buildImplReviewPrompt({
      changedFiles: Array.isArray(parsedOutput.changedFiles)
        ? (parsedOutput.changedFiles as string[])
        : (sessionState.implementation?.changedFiles ?? []),
      planText,
      ticketText,
      iteration: reviewCtx.iteration,
      planVersion: reviewCtx.planVersion,
      obligationId: reviewCtx.obligationId,
      criteriaVersion: reviewCtx.criteriaVersion,
      mandateDigest: reviewCtx.mandateDigest,
      ...implRules,
    });
  }
  if (toolName === TOOL_FLOWGUARD_ARCHITECTURE) {
    return buildArchitectureReviewPrompt({
      adrText,
      adrTitle,
      ticketText,
      iteration: reviewCtx.iteration,
      planVersion: reviewCtx.planVersion,
      obligationId: reviewCtx.obligationId,
      criteriaVersion: reviewCtx.criteriaVersion,
      mandateDigest: reviewCtx.mandateDigest,
      ...archRules,
    });
  }
  deps.log.warn('orchestrator', 'unsupported reviewable tool — skipping', { tool: toolName });
  return null;
}

// ─── Shared Strict Enforcement Helpers ───────────────────────────────────────

const REASON_MANDATE_MISSING = 'SUBAGENT_MANDATE_MISSING';
const REASON_MANDATE_MISMATCH = 'SUBAGENT_MANDATE_MISMATCH';
const REASON_UNABLE_TO_REVIEW = 'SUBAGENT_UNABLE_TO_REVIEW';

/**
 * Validate strict attestation fields against expected review context values.
 *
 * Content pipeline uses values from reviewCtx; standard pipeline uses
 * module-level constants. Both paths share the same structural check.
 */
function validateStrictAttestation(
  findings: {
    reviewMode?: string;
    attestation?: Record<string, unknown> | null;
    overallVerdict?: string;
  },
  expected: {
    obligationId: string;
    criteriaVersion: string;
    mandateDigest: string;
    iteration: number;
    planVersion: number;
    checkReviewedBy: boolean;
    checkUnableToReview: boolean;
  },
): AttestationResult {
  const att = findings.attestation;
  if (!att) {
    return {
      valid: false,
      code: REASON_MANDATE_MISSING,
      detail: { obligationId: expected.obligationId },
    };
  }

  const fieldMismatch =
    findings.reviewMode !== 'subagent' ||
    att.toolObligationId !== expected.obligationId ||
    att.iteration !== expected.iteration ||
    att.planVersion !== expected.planVersion ||
    att.criteriaVersion !== expected.criteriaVersion ||
    att.mandateDigest !== expected.mandateDigest ||
    (expected.checkReviewedBy && att.reviewedBy !== REVIEWER_SUBAGENT_TYPE);

  if (fieldMismatch) {
    return {
      valid: false,
      code: REASON_MANDATE_MISMATCH,
      detail: { obligationId: expected.obligationId },
    };
  }

  if (expected.checkUnableToReview && findings.overallVerdict === 'unable_to_review') {
    return {
      valid: false,
      code: REASON_UNABLE_TO_REVIEW,
      detail: { obligationId: expected.obligationId },
    };
  }

  return { valid: true };
}

/**
 * Record invocation evidence or block if evidence was reused.
 *
 * Encapsulates the mutable side-channel pattern (`reusedEvidence` flag)
 * into a clean return value. Both pipelines use this to avoid the
 * fragile let-mutate-in-callback anti-pattern.
 */
async function recordEvidenceOrBlockReuse(
  deps: OrchestratorDeps,
  sessDir: string,
  params: {
    obligationId: string;
    obligationType: ReviewObligationType;
    sessionId: string;
    childSessionId: string;
    promptHash: string;
    findingsHash: string;
    reviewerResult: Pick<
      ReviewerSuccessResult,
      | 'sessionId'
      | 'reviewOutputMode'
      | 'structuredOutputUsed'
      | 'reviewAssuranceLevel'
      | 'extractionMethod'
      | 'modelCapabilityError'
      | 'findings'
    >;
    currentAssuranceInvocations: unknown[];
  },
): Promise<EvidenceRecordResult> {
  let reused = false;
  await deps.updateReviewAssurance(sessDir, (s, now2) => {
    const assurance = ensureReviewAssurance(s.reviewAssurance);
    if (hasEvidenceReuse(assurance.invocations, params.childSessionId, params.findingsHash)) {
      reused = true;
      return updateObligation(s, params.obligationId, (item) => ({
        ...item,
        status: 'blocked',
        blockedCode: 'SUBAGENT_EVIDENCE_REUSED',
      }));
    }

    const invocation = buildInvocationEvidence({
      obligationId: params.obligationId,
      obligationType: params.obligationType,
      parentSessionId: params.sessionId,
      childSessionId: params.childSessionId,
      invocationMode: INVOCATION_MODE_SDK_SESSION,
      hostVisible: false,
      promptHash: params.promptHash,
      findingsHash: params.findingsHash,
      invokedAt: now2,
      fulfilledAt: now2,
      source: EVIDENCE_SOURCE_HOST,
      reviewOutputMode: params.reviewerResult.reviewOutputMode,
      structuredOutputUsed: params.reviewerResult.structuredOutputUsed,
      reviewAssuranceLevel: params.reviewerResult.reviewAssuranceLevel,
      extractionMethod: params.reviewerResult.extractionMethod,
      modelCapabilityError: params.reviewerResult.modelCapabilityError,
      capturedVerdict:
        params.reviewerResult.findings &&
        typeof params.reviewerResult.findings.overallVerdict === 'string'
          ? params.reviewerResult.findings.overallVerdict
          : undefined,
    });
    const withInvocation = {
      ...s,
      reviewAssurance: appendInvocationEvidence(
        ensureReviewAssurance(s.reviewAssurance),
        invocation,
      ),
    };
    return updateObligation(withInvocation, params.obligationId, (item) => ({
      ...item,
      status: 'fulfilled',
      invocationId: invocation.invocationId,
      fulfilledAt: now2,
    }));
  });
  return reused ? 'reused' : 'fulfilled';
}

// ─── Reviewer Invocation Helper ──────────────────────────────────────────────

function buildAttemptFailedLogger(
  deps: OrchestratorDeps,
  toolName: string,
  sessionId: string,
): (info: {
  attempt: number;
  step: string;
  error?: unknown;
  details?: Record<string, unknown>;
}) => void {
  return (info) => {
    deps.log.warn('orchestrator', `reviewer attempt ${info.attempt} failed at ${info.step}`, {
      tool: toolName,
      sessionId,
      step: info.step,
      attempt: info.attempt,
      error: info.error instanceof Error ? info.error.message : String(info.error ?? ''),
      ...(info.details ?? {}),
    });
  };
}

// ─── Shared Pipeline Helpers ─────────────────────────────────────────────────

function isStrictEnforcementEnabled(sessionState: {
  policySnapshot?: { selfReview?: { strictEnforcement?: boolean } };
}): boolean {
  return sessionState?.policySnapshot?.selfReview?.strictEnforcement === true;
}

function getReviewerPolicies(sessionState: {
  policySnapshot: { reviewOutputPolicy?: string; reviewInvocationPolicy?: string };
}): { reviewOutputPolicy: ReviewOutputPolicy; reviewInvocationPolicy: ReviewInvocationPolicy } {
  const outputPolicy = sessionState.policySnapshot.reviewOutputPolicy;
  const invocationPolicy = sessionState.policySnapshot?.reviewInvocationPolicy;
  return {
    reviewOutputPolicy:
      outputPolicy === 'structured_required' || outputPolicy === 'text_compat_allowed'
        ? outputPolicy
        : 'structured_required',
    reviewInvocationPolicy:
      invocationPolicy === 'host_task_required' ||
      invocationPolicy === 'host_task_preferred' ||
      invocationPolicy === 'sdk_allowed'
        ? invocationPolicy
        : 'host_task_required',
  };
}

function isOutputAlreadyBlocked(output: { output: string }): boolean {
  const result = parseToolResult(output.output);
  return result?.error === true;
}

// ─── Review Content Pipeline ─────────────────────────────────────────────────

async function loadContentForReview(
  ctx: PipelineContext,
  input: unknown,
  strictEnforcement: boolean,
): Promise<string | null> {
  const { deps, reviewCtx } = ctx;
  const refInput = extractContentRefInput(input);
  const contentResult = await loadExternalContent(refInput);
  const hasContent = 'content' in contentResult && typeof contentResult.content === 'string';
  if (!hasContent) {
    if (strictEnforcement) {
      await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
        obligationId: reviewCtx.obligationId,
        reason: 'external review content could not be loaded',
      });
    }
    return null;
  }
  return contentResult.content;
}

async function validateContentFindings(
  ctx: PipelineContext,
  reviewerResult: ReviewerSuccessResult,
  prompt: string,
  strictEnforcement: boolean,
): Promise<boolean> {
  const { deps, reviewCtx, output, rawOutput } = ctx;

  if (!reviewerResult.findings) {
    if (strictEnforcement) {
      await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
        obligationId: reviewCtx.obligationId,
        reason: 'reviewer response was not parseable as ReviewFindings',
      });
    }
    return false;
  }

  const parsedFindings = ReviewFindingsSchema.safeParse(reviewerResult.findings);
  if (!parsedFindings.success) {
    if (strictEnforcement) {
      await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
        obligationId: reviewCtx.obligationId,
        reason: 'reviewer response did not match ReviewFindings schema',
      });
    }
    return false;
  }

  if (strictEnforcement) {
    const narrowed = reviewerResult as ReviewerSuccessResult & {
      findings: Record<string, unknown>;
    };
    const blocked = await enforceContentStrictGate(ctx, narrowed, parsedFindings.data, prompt);
    if (blocked) return false;
  }

  const mutated = buildReviewContentMutatedOutput(rawOutput, reviewerResult);
  if (mutated) output.output = mutated;
  return true;
}

async function runReviewContentPipeline(ctx: PipelineContext, input: unknown): Promise<void> {
  const { deps, sessionState, reviewCtx, output, sessionId } = ctx;
  const strictEnforcement = isStrictEnforcementEnabled(sessionState);

  const content = await loadContentForReview(ctx, input, strictEnforcement);
  if (!content) return;

  const { profileName, profileRules } = selectReviewerProfileRules(
    sessionState.activeProfile,
    'REVIEW',
  );
  const ticketText = sessionState.ticket?.text ?? '';
  const prompt = buildReviewContentPrompt({
    content,
    ticketText,
    obligationId: reviewCtx.obligationId,
    mandateDigest: reviewCtx.mandateDigest,
    criteriaVersion: reviewCtx.criteriaVersion,
    iteration: reviewCtx.iteration,
    planVersion: reviewCtx.planVersion,
    profileName,
    profileRules,
  });

  const policies = getReviewerPolicies(sessionState);
  const reviewerResult = await invokeReviewer(deps.client, prompt, sessionId, {
    ...policies,
    _onAttemptFailed: buildAttemptFailedLogger(deps, TOOL_FLOWGUARD_REVIEW, sessionId),
  });

  if (reviewerResult?.blocked) {
    const code = reviewerResult.code ?? REASON_HOST_SUBAGENT_TASK_REQUIRED;
    const reason = reviewerResult.reason ?? 'review invocation blocked by policy';
    output.output = strictBlockedOutput(code, {
      reason,
      reviewInvocation: JSON.stringify(reviewerResult.reviewInvocation),
    });
    return;
  }

  if (!reviewerResult || reviewerResult.blocked) {
    if (strictEnforcement) {
      await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
        obligationId: reviewCtx.obligationId,
        reason: 'reviewer response was not parseable as ReviewFindings',
      });
    }
    return;
  }

  await validateContentFindings(ctx, reviewerResult, prompt, strictEnforcement);
}

function extractContentRefInput(input: unknown): {
  text?: string;
  prNumber?: number;
  branch?: string;
  url?: string;
} {
  const wrappedArgs = (input as { args?: unknown })?.args;
  const rawInput =
    wrappedArgs && typeof wrappedArgs === 'object' && !Array.isArray(wrappedArgs)
      ? (wrappedArgs as Record<string, unknown>)
      : (input as Record<string, unknown>);
  return {
    text: typeof rawInput.text === 'string' ? rawInput.text : undefined,
    prNumber: typeof rawInput.prNumber === 'number' ? rawInput.prNumber : undefined,
    branch: typeof rawInput.branch === 'string' ? rawInput.branch : undefined,
    url: typeof rawInput.url === 'string' ? rawInput.url : undefined,
  };
}

async function enforceContentStrictGate(
  ctx: PipelineContext,
  reviewerResult: ReviewerSuccessResult & { findings: Record<string, unknown> },
  findings: {
    reviewMode?: string;
    attestation?: Record<string, unknown> | null;
    overallVerdict?: string;
  },
  prompt: string,
): Promise<boolean> {
  const { deps, sessDir, reviewCtx, sessionState, output, sessionId, now } = ctx;

  const attestation = validateStrictAttestation(findings, {
    obligationId: reviewCtx.obligationId,
    criteriaVersion: reviewCtx.criteriaVersion,
    mandateDigest: reviewCtx.mandateDigest,
    iteration: reviewCtx.iteration,
    planVersion: reviewCtx.planVersion,
    checkReviewedBy: true,
    checkUnableToReview: false,
  });

  if (!attestation.valid) {
    await blockReviewOutcomeHelper(deps, ctx, attestation.code, attestation.detail);
    return true;
  }

  const promptHash = hashText(prompt);
  const findingsHash = hashFindings(reviewerResult.findings);

  // Check reuse before creating evidence.
  const currentAssurance = ensureReviewAssurance(sessionState.reviewAssurance);
  if (hasEvidenceReuse(currentAssurance.invocations, reviewerResult.sessionId, findingsHash)) {
    await deps.updateReviewAssurance(sessDir, (s) =>
      updateObligation(s, reviewCtx.obligationId, (item) => ({
        ...item,
        status: 'blocked',
        blockedCode: 'SUBAGENT_EVIDENCE_REUSED',
      })),
    );
    output.output = strictBlockedOutput('SUBAGENT_EVIDENCE_REUSED', {
      obligationId: reviewCtx.obligationId,
      reason: 'subagent findings already used for a prior obligation',
    });
    return true;
  }

  // Atomically fulfill the obligation and append invocation evidence.
  const invocation = buildInvocationEvidence({
    obligationId: reviewCtx.obligationId,
    obligationType: 'review',
    parentSessionId: sessionId,
    childSessionId: reviewerResult.sessionId,
    invocationMode: INVOCATION_MODE_SDK_SESSION,
    hostVisible: false,
    promptHash,
    findingsHash,
    invokedAt: now,
    fulfilledAt: now,
    source: EVIDENCE_SOURCE_HOST,
    reviewOutputMode: reviewerResult.reviewOutputMode,
    structuredOutputUsed: reviewerResult.structuredOutputUsed,
    reviewAssuranceLevel: reviewerResult.reviewAssuranceLevel,
    extractionMethod: reviewerResult.extractionMethod,
    modelCapabilityError: reviewerResult.modelCapabilityError,
  });
  await deps.updateReviewAssurance(sessDir, (s) => {
    const updated = updateObligation(s, reviewCtx.obligationId, (item) => ({
      ...item,
      pluginHandshakeAt: now,
      status: 'fulfilled',
      invocationId: invocation.invocationId,
      fulfilledAt: now,
    }));
    return {
      ...updated,
      reviewAssurance: appendInvocationEvidence(
        ensureReviewAssurance(updated.reviewAssurance),
        invocation,
      ),
    };
  });

  return false;
}

// ─── Standard Review Pipeline ────────────────────────────────────────────────

async function emitObligationCreatedAudit(
  ctx: PipelineContext,
  obligationType: string,
): Promise<void> {
  const { sessDir, sessionId, parsedOutput, sessionState, reviewCtx } = ctx;
  const phase = String(parsedOutput.phase ?? sessionState.phase);
  await appendReviewAuditEvent(sessDir, sessionId, phase, 'review:obligation_created', {
    obligationId: reviewCtx.obligationId,
    obligationType,
    iteration: reviewCtx.iteration,
    planVersion: reviewCtx.planVersion,
    criteriaVersion: reviewCtx.criteriaVersion,
    mandateDigest: reviewCtx.mandateDigest,
  });
}

async function runStandardReviewPipeline(
  ctx: PipelineContext,
  toolName: string,
  input: unknown,
): Promise<void> {
  const { deps, sessionState, sessDir, reviewCtx, output, sessionId } = ctx;

  const obligationType = obligationTypeForTool(toolName);
  if (!obligationType) {
    output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason: `unsupported reviewable tool for review orchestration: ${toolName}`,
    });
    deps.log.warn('orchestrator', 'unsupported reviewable tool — blocked', { tool: toolName });
    return;
  }

  const strictEnforcement = isStrictEnforcementEnabled(sessionState);

  await deps.updateReviewAssurance(sessDir, (s, now2) =>
    updateObligation(s, reviewCtx.obligationId, (item) => ({
      ...item,
      pluginHandshakeAt: now2,
    })),
  );
  await emitObligationCreatedAudit(ctx, obligationType);

  const prompt = buildStandardPromptAndLog(ctx, toolName, input);
  if (!prompt) return;

  const policies = getReviewerPolicies(sessionState);
  const reviewerResult = await invokeReviewer(deps.client, prompt, sessionId, {
    ...policies,
    _onAttemptFailed: buildAttemptFailedLogger(deps, toolName, sessionId),
  });

  if (reviewerResult?.blocked) {
    const code = reviewerResult.code ?? REASON_HOST_SUBAGENT_TASK_REQUIRED;
    const reason = reviewerResult.reason ?? 'review invocation blocked by policy';
    output.output = strictBlockedOutput(code, {
      reason,
      reviewInvocation: JSON.stringify(reviewerResult.reviewInvocation),
    });
    return;
  }

  if (reviewerResult && !reviewerResult.blocked) {
    await handleReviewerSuccess(ctx, {
      toolName,
      reviewerResult,
      prompt,
      obligationType,
      strictEnforcement,
    });
  } else {
    await handleReviewerFailure(ctx, obligationType, strictEnforcement);
  }
}

function buildToolArgsDiagnostics(
  toolName: string,
  toolArgs: Record<string, unknown>,
  planText: string,
  adrText: string,
): Record<string, unknown> {
  if (toolName === TOOL_FLOWGUARD_PLAN && typeof toolArgs.planText === 'string') {
    return {
      toolArgsPlanTextLength: toolArgs.planText.length,
      planTextMismatch: toolArgs.planText !== planText,
    };
  }
  if (toolName === TOOL_FLOWGUARD_ARCHITECTURE && typeof toolArgs.adrText === 'string') {
    return {
      toolArgsAdrTextLength: toolArgs.adrText.length,
      adrTextMismatch: toolArgs.adrText !== adrText,
    };
  }
  return {};
}

function buildStandardPromptAndLog(
  ctx: PipelineContext,
  toolName: string,
  input: unknown,
): string | null {
  const { deps, sessionState, reviewCtx, parsedOutput, sessionId } = ctx;
  const ticketText = sessionState.ticket?.text ?? '';
  const planText = sessionState.plan?.current?.body ?? '';
  const adrText = sessionState.architecture?.adrText ?? '';
  const adrTitle = sessionState.architecture?.title ?? '';
  const toolArgs = getToolArgs(input);

  const planRules = selectReviewerProfileRules(sessionState.activeProfile, 'PLAN_REVIEW');
  const implRules = selectReviewerProfileRules(sessionState.activeProfile, 'IMPL_REVIEW');
  const archRules = selectReviewerProfileRules(sessionState.activeProfile, 'ARCH_REVIEW');

  const prompt = buildToolPrompt({
    toolName,
    texts: { planText, ticketText, adrText, adrTitle },
    reviewCtx,
    parsedOutput,
    sessionState,
    rules: { planRules, implRules, archRules },
    deps,
  });
  if (!prompt) return null;

  deps.log.info('orchestrator', 'invoking reviewer subagent', {
    tool: toolName,
    sessionId,
    iteration: reviewCtx.iteration,
    planVersion: reviewCtx.planVersion,
    planTextLength: planText.length,
    planTextSource: 'sessionState',
    ...buildToolArgsDiagnostics(toolName, toolArgs, planText, adrText),
  });

  return prompt;
}

// ─── Standard Pipeline: Success Handler ──────────────────────────────────────

interface ReviewSuccessOpts {
  toolName: string;
  reviewerResult: ReviewerSuccessResult;
  prompt: string;
  obligationType: ReviewObligationType;
  strictEnforcement: boolean;
}

async function handleReviewerSuccess(ctx: PipelineContext, opts: ReviewSuccessOpts): Promise<void> {
  const { toolName, reviewerResult, prompt, obligationType, strictEnforcement } = opts;
  const { deps, output, sessionId, rawOutput } = ctx;

  if (!reviewerResult.findings) {
    deps.log.warn(
      'orchestrator',
      'reviewer returned unparseable response — fallback to LLM-driven path',
      {
        tool: toolName,
        sessionId,
        childSessionId: reviewerResult.sessionId,
        rawResponseLength: reviewerResult.rawResponse.length,
      },
    );
    if (strictEnforcement) {
      await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
        reason: 'reviewer response was not parseable as ReviewFindings',
      });
    }
    return;
  }

  const parsedFindings = ReviewFindingsSchema.safeParse(reviewerResult.findings);
  if (!parsedFindings.success && strictEnforcement) {
    await blockReviewOutcomeHelper(deps, ctx, 'STRICT_REVIEW_ORCHESTRATION_FAILED', {
      reason: 'reviewer response did not match ReviewFindings schema',
    });
  }

  if (strictEnforcement && parsedFindings.success) {
    // parsedFindings.success guarantees reviewerResult.findings is non-null
    const narrowed = reviewerResult as ReviewerSuccessResult & {
      findings: Record<string, unknown>;
    };
    const gateBlocked = await enforceStandardStrictGate(
      ctx,
      narrowed,
      parsedFindings.data,
      prompt,
      obligationType,
    );
    if (gateBlocked) return;
  }

  if (strictEnforcement && isOutputAlreadyBlocked(output)) return;

  const mutated = buildMutatedOutput(rawOutput, reviewerResult);
  if (mutated) {
    // buildMutatedOutput returns non-null only when findings is non-null
    const narrowed = reviewerResult as ReviewerSuccessResult & {
      findings: Record<string, unknown>;
    };
    await finalizeReviewOutput(ctx, {
      toolName,
      reviewerResult: narrowed,
      mutated,
      strictEnforcement,
    });
  } else {
    deps.log.warn('orchestrator', 'output mutation failed (fallback to LLM-driven)', {
      tool: toolName,
      sessionId,
    });
    if (strictEnforcement) {
      output.output = strictBlockedOutput('STRICT_REVIEW_ORCHESTRATION_FAILED', {
        reason: 'output mutation failed',
      });
    }
  }
}

async function enforceStandardStrictGate(
  ctx: PipelineContext,
  reviewerResult: ReviewerSuccessResult & { findings: Record<string, unknown> },
  findings: {
    reviewMode?: string;
    attestation?: Record<string, unknown> | null;
    overallVerdict?: string;
  },
  prompt: string,
  obligationType: ReviewObligationType,
): Promise<boolean> {
  const { deps, sessDir, reviewCtx, sessionState, output, sessionId } = ctx;

  const attestation = validateStrictAttestation(findings, {
    obligationId: reviewCtx.obligationId,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    mandateDigest: REVIEW_MANDATE_DIGEST,
    iteration: reviewCtx.iteration,
    planVersion: reviewCtx.planVersion,
    checkReviewedBy: false,
    checkUnableToReview: true,
  });

  if (!attestation.valid) {
    await blockReviewOutcomeHelper(deps, ctx, attestation.code, attestation.detail);
    return false; // gate blocked output but don't short-circuit — let strictGateResult check handle it
  }

  const promptHash = hashText(prompt);
  const findingsHash = hashFindings(reviewerResult.findings);

  const result = await recordEvidenceOrBlockReuse(deps, sessDir, {
    obligationId: reviewCtx.obligationId,
    obligationType,
    sessionId,
    childSessionId: reviewerResult.sessionId,
    promptHash,
    findingsHash,
    reviewerResult,
    currentAssuranceInvocations: sessionState.reviewAssurance?.invocations ?? [],
  });

  await emitStandardEvidenceAudit(ctx, {
    result,
    obligationType,
    promptHash,
    findingsHash,
    reviewerResult,
  });

  if (result === 'reused') {
    output.output = strictBlockedOutput('SUBAGENT_EVIDENCE_REUSED', {
      obligationId: reviewCtx.obligationId,
    });
    return true;
  }

  return false;
}

interface EvidenceAuditOpts {
  result: EvidenceRecordResult;
  obligationType: string;
  promptHash: string;
  findingsHash: string;
  reviewerResult: Pick<
    ReviewerSuccessResult,
    | 'sessionId'
    | 'reviewOutputMode'
    | 'structuredOutputUsed'
    | 'reviewAssuranceLevel'
    | 'extractionMethod'
    | 'modelCapabilityError'
  >;
}

async function emitStandardEvidenceAudit(
  ctx: PipelineContext,
  opts: EvidenceAuditOpts,
): Promise<void> {
  const { result, obligationType, promptHash, findingsHash, reviewerResult } = opts;
  const { sessDir, sessionId, parsedOutput, sessionState, reviewCtx } = ctx;
  const phase = String(parsedOutput.phase ?? sessionState.phase);

  await appendReviewAuditEvent(
    sessDir,
    sessionId,
    phase,
    result === 'reused' ? 'review:obligation_blocked' : 'review:subagent_invoked',
    result === 'reused'
      ? {
          obligationId: reviewCtx.obligationId,
          code: 'SUBAGENT_EVIDENCE_REUSED',
        }
      : {
          obligationId: reviewCtx.obligationId,
          obligationType,
          parentSessionId: sessionId,
          childSessionId: reviewerResult.sessionId,
          agentType: REVIEWER_SUBAGENT_TYPE,
          promptHash,
          mandateDigest: REVIEW_MANDATE_DIGEST,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          findingsHash,
          reviewOutputMode: reviewerResult.reviewOutputMode,
          structuredOutputUsed: reviewerResult.structuredOutputUsed,
          reviewAssuranceLevel: reviewerResult.reviewAssuranceLevel,
          ...(reviewerResult.extractionMethod
            ? { extractionMethod: reviewerResult.extractionMethod }
            : {}),
          ...(reviewerResult.modelCapabilityError
            ? { modelCapabilityError: reviewerResult.modelCapabilityError }
            : {}),
        },
  );

  if (result === 'fulfilled') {
    await appendReviewAuditEvent(sessDir, sessionId, phase, 'review:obligation_fulfilled', {
      obligationId: reviewCtx.obligationId,
      childSessionId: reviewerResult.sessionId,
    });
  }
}

interface FinalizeOutputOpts {
  toolName: string;
  reviewerResult: ReviewerSuccessResult & { findings: Record<string, unknown> };
  mutated: string;
  strictEnforcement: boolean;
}

async function finalizeReviewOutput(ctx: PipelineContext, opts: FinalizeOutputOpts): Promise<void> {
  const { toolName, reviewerResult, mutated, strictEnforcement } = opts;
  const { deps, output, sessionId, now } = ctx;

  if (strictEnforcement) {
    // Evidence already recorded in enforceStandardStrictGate
  }

  const eState = deps.getEnforcementState(sessionId);
  const captured: CapturedFindings = {
    overallVerdict:
      typeof reviewerResult.findings.overallVerdict === 'string'
        ? reviewerResult.findings.overallVerdict
        : 'unknown',
    blockingIssuesCount: Array.isArray(reviewerResult.findings.blockingIssues)
      ? reviewerResult.findings.blockingIssues.length
      : 0,
    sessionId: reviewerResult.sessionId,
    rawFindings: reviewerResult.findings,
  };

  recordPluginReview(eState, toolName, reviewerResult.sessionId, captured, now);
  output.output = mutated;

  deps.log.info('orchestrator', 'reviewer invocation succeeded', {
    tool: toolName,
    sessionId,
    childSessionId: reviewerResult.sessionId,
    verdict: reviewerResult.findings.overallVerdict,
  });
}

// ─── Standard Pipeline: Failure Handler ──────────────────────────────────────

async function handleReviewerFailure(
  ctx: PipelineContext,
  obligationType: string,
  strictEnforcement: boolean,
): Promise<void> {
  const { deps, sessDir, sessionId, reviewCtx, parsedOutput, sessionState, output } = ctx;
  const phase = String(parsedOutput.phase ?? sessionState.phase);
  const toolName = ctx.deps === deps ? 'unknown' : 'unknown'; // just for log below
  void toolName;

  deps.log.warn('orchestrator', 'reviewer invocation failed (fallback to LLM-driven)', {
    tool: obligationType,
    sessionId,
  });

  if (strictEnforcement) {
    await deps.blockReviewOutcome(
      { sessDir, sessionId, phase },
      reviewCtx.obligationId,
      'STRICT_REVIEW_ORCHESTRATION_FAILED',
      { reason: 'reviewer invocation failed' },
      output,
    );
  } else {
    // Non-strict: block the obligation to prevent infinite re-invocation.
    await deps.updateReviewAssurance(sessDir, (s) =>
      updateObligation(s, reviewCtx.obligationId, (item) => ({
        ...item,
        status: 'blocked' as const,
        blockedCode: 'REVIEWER_INVOCATION_EXHAUSTED',
      })),
    );
    await appendReviewAuditEvent(sessDir, sessionId, phase, 'review:obligation_blocked', {
      obligationId: reviewCtx.obligationId,
      code: 'REVIEWER_INVOCATION_EXHAUSTED',
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildSessionContext(ctx: PipelineContext): ReviewSessionContext {
  return {
    sessDir: ctx.sessDir,
    sessionId: ctx.sessionId,
    phase: String(ctx.parsedOutput.phase ?? ctx.sessionState.phase),
  };
}

async function blockReviewOutcomeHelper(
  deps: OrchestratorDeps,
  ctx: PipelineContext,
  code: string,
  detail: Record<string, string>,
): Promise<void> {
  await deps.blockReviewOutcome(
    buildSessionContext(ctx),
    ctx.reviewCtx.obligationId,
    code,
    detail,
    ctx.output,
  );
}

function handleOrchestrationError(
  deps: OrchestratorDeps,
  inReviewPath: boolean,
  strictEnforcement: boolean | null,
  output: { output: string },
  err: unknown,
): void {
  if (inReviewPath && strictEnforcement !== false) {
    output.output = strictBlockedOutput('STRICT_REVIEW_ORCHESTRATION_FAILED', {
      reason: 'reviewer orchestration threw an exception',
    });
    deps.log.warn('audit', 'review orchestration failed (strict mode blocked)', {
      error: err instanceof Error ? err.message : String(err),
    });
  } else {
    deps.log.warn('audit', 'review orchestration failed (fallback to LLM-driven)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

/**
 * Run the review orchestrator for a single tool invocation.
 *
 * Thin dispatcher that validates the session, checks host-task policy,
 * and delegates to the appropriate pipeline (content or standard).
 */
export async function runReviewOrchestration(
  deps: OrchestratorDeps,
  event: ToolCallEvent,
): Promise<void> {
  const { toolName, input, output, sessionId, now } = event;

  let strictEnforcement: boolean | null = null;
  const inReviewPath = isReviewRequired(getToolOutput(output), toolName);
  if (!inReviewPath) return;

  try {
    const v = await validateSessionContext(deps, output, toolName, sessionId);
    if (!v) return;
    strictEnforcement = v.strictEnforcement;
    const { sessionState, sessDir, reviewCtx, parsedOutput } = v;
    const rawOutput = getToolOutput(output);

    if (await handleHostTaskPolicy(deps, sessionState, sessDir, reviewCtx, output)) {
      return;
    }

    const ctx: PipelineContext = {
      deps,
      sessionState,
      sessDir,
      reviewCtx,
      parsedOutput,
      output,
      sessionId,
      now,
      rawOutput,
      strictEnforcement: sessionState?.policySnapshot?.selfReview?.strictEnforcement === true,
    };

    if (toolName === TOOL_FLOWGUARD_REVIEW) {
      await runReviewContentPipeline(ctx, input);
    } else {
      await runStandardReviewPipeline(ctx, toolName, input);
    }
  } catch (err) {
    handleOrchestrationError(deps, inReviewPath, strictEnforcement, output, err);
  }
}
