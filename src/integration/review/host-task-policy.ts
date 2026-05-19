/**
 * @module integration/review/host-task-policy
 * @description Host task policy evaluation and output mutation for review orchestration.
 *
 * Determines whether review should be delegated to a host-visible Task tool
 * subagent call instead of the SDK-driven path.
 */

import { parseToolResult, getToolOutput } from '../plugin-helpers.js';
import { extractContentMeta } from './enforcement/extraction.js';
import { REVIEWER_SUBAGENT_TYPE } from './enforcement/types.js';
import { REVIEW_COMPLETED_PREFIX, extractReviewContext } from './orchestrator.js';
import {
  REASON_HOST_SUBAGENT_TASK_REQUIRED,
  RECOVERY_HOST_SUBAGENT_TASK,
} from '../../shared/flowguard-identifiers.js';
import type { ReviewInvocationPolicy } from '../../config/policy-types.js';
import { findReviewObligationById, ensureReviewAssurance } from './assurance.js';
import { updateObligation } from './obligation-state.js';
import type { SessionState } from '../../state/schema.js';
import type { OrchestratorDeps, ToolCallEvent } from './pipeline-types.js';

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
    `submit your reviewVerdict directly with reviewerUnavailable: true. This proceeds with self-review assurance.`;
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

export async function handleHostTaskPolicy(
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
