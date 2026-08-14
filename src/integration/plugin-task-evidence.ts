/**
 * @module integration/plugin-task-evidence
 * @description Host-task evidence binding handler for reviewer subagent calls.
 *
 * Extracted from plugin.ts tool.execute.after hook to reduce complexity.
 * Called only when a flowguard-reviewer subagent task completes.
 *
 * @version v1
 */

import { readState } from '../adapters/persistence.js';
import { buildHostTaskChallengeContract } from './review/host-task-policy.js';
import { buildHostTaskEvidence } from './review/evidence-binding.js';
import {
  appendInvocationEvidence,
  ensureReviewAssurance,
  fulfillObligation,
  staleObligationAttempts,
  updateAttemptStatus,
} from './review/assurance.js';
import { appendReviewAuditEvent } from './review/audit-events.js';
import { strictBlockedOutput } from './plugin-helpers.js';
import { REVIEWER_SUBAGENT_TYPE } from './review/enforcement/types.js';
import { bindOutcomeToRejectionReason } from './review/enforcement/rejection-policy.js';
import {
  schemaErrorFingerprintOf,
  type SchemaIssueKey,
} from './review/schema-error-fingerprint.js';

import type { PluginWorkspace } from './plugin-workspace.js';
import type { SessionState } from '../state/schema.js';
import type { HostTaskBindResult } from './review/enforcement/types.js';
import type { ExecutedTaskPrompt } from './review/enforcement/types.js';

interface HostTaskEvidenceDeps {
  ws: PluginWorkspace;
  log: {
    info(service: string, message: string, extra?: Record<string, unknown>): void;
    warn(service: string, message: string, extra?: Record<string, unknown>): void;
  };
  logError(message: string, err: unknown): void;
}

/**
 * Bind host-task evidence for a completed flowguard-reviewer subagent call.
 * Mutates hookOutput.output on blocking failures.
 */
// eslint-disable-next-line max-params -- hook lifecycle values are intentionally explicit
export async function handleHostTaskEvidence(
  deps: HostTaskEvidenceDeps,
  sessionId: string,
  resolvedChildSessionId: string | null,
  now: string,
  hookOutput: { output?: string },
  execution?: ExecutedTaskPrompt,
): Promise<void> {
  deps.log.info('host-task', 'reviewer task completed', {
    sessionId,
    resolvedChildSessionId,
  });

  try {
    const bound = await bindReviewerEvidence(deps, sessionId, now, execution);
    if (!bound) return;
    await applyHostTaskBindResult({ ...bound, deps, sessionId, hookOutput, now });
  } catch (err) {
    deps.logError('host task evidence creation failed', err);
    hookOutput.output = strictBlockedOutput('HOST_SUBAGENT_TASK_REQUIRED', {
      reason: err instanceof Error ? err.message : String(err),
      policy: 'host_task_required',
      policyMode: 'host_task_required',
      reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
    });
  }
}

/**
 * Resolve the session and bind the captured reviewer evidence.
 *
 * Returns null when this session is not under a host-task policy, i.e. when
 * reviewer Task evidence is not the authoritative source for it.
 */
// eslint-disable-next-line complexity -- host-task evidence binding resolves multiple fail-closed states
async function bindReviewerEvidence(
  deps: HostTaskEvidenceDeps,
  sessionId: string,
  now: string,
  execution: ExecutedTaskPrompt | undefined,
): Promise<{
  sessDir: string;
  policy: 'host_task_required' | 'host_task_preferred';
  bindResult: ReturnType<typeof buildHostTaskEvidence>;
} | null> {
  const sessDir = deps.ws.getSessionDir(sessionId);
  if (!sessDir) return null;

  const state = await readState(sessDir);
  if (!state) return null;

  const policy = state.policySnapshot?.reviewInvocationPolicy;
  if (policy !== 'host_task_required' && policy !== 'host_task_preferred') return null;

  const obligations = state.reviewAssurance?.obligations ?? [];
  const invocations = state.reviewAssurance?.invocations ?? [];
  const attempts = state.reviewAssurance?.attempts ?? [];

  deps.log.info('host-task', 'bind attempt', {
    sessionId,
    policy,
    pendingObligationCount: obligations.filter((o) => o.status === 'pending').length,
    totalInvocations: invocations.length,
  });

  const eState = deps.ws.getEnforcementState(sessionId);
  const bindResult = buildHostTaskEvidence(eState, sessionId, now, {
    obligations,
    invocations,
    attempts,
    allowedEvidenceRefs: buildHostTaskChallengeContract(
      state,
      obligations.find((o) => o.status === 'pending') ?? null,
    )?.evidenceRefs,
    promptProvenance: execution
      ? {
          callId: execution.callId,
          canonicalPromptDigest: execution.canonicalPromptDigest,
          modelPromptDigest: execution.modelPromptDigest,
        }
      : undefined,
  });
  return { sessDir, policy, bindResult };
}

async function applyHostTaskBindResult(input: {
  deps: HostTaskEvidenceDeps;
  sessDir: string;
  sessionId: string;
  policy: string;
  bindResult: HostTaskBindResult;
  hookOutput: { output?: string };
  /** Injected host time; no audit outcome reads the clock itself. */
  now: string;
}): Promise<void> {
  const { deps, sessDir, sessionId, policy, bindResult, hookOutput, now } = input;
  if (bindResult.evidence) {
    await persistHostTaskEvidence(deps, sessDir, sessionId, bindResult, now);
    return;
  }
  // Persist the attempt status even when binding failed (rejected/stale).
  if (bindResult.attempt) {
    await persistAttemptStatus(deps, sessDir, bindResult, now);
  }
  if (policy === 'host_task_required') {
    blockRequiredHostTaskEvidence(deps, sessionId, policy, bindResult, hookOutput);
    return;
  }
  deps.log.warn('host-task', 'bind failed', {
    sessionId,
    bindOutcome: bindResult.bindOutcome,
    ...bindResult.diagnostic,
  });
}

async function persistHostTaskEvidence(
  deps: HostTaskEvidenceDeps,
  sessDir: string,
  sessionId: string,
  bindResult: HostTaskBindResult,
  now: string,
): Promise<void> {
  const evidence = bindResult.evidence;
  if (!evidence) return;
  if (evidence.childSessionId.startsWith('derived:call:')) {
    // The reviewer's real session id could not be resolved from host metadata or
    // reviewer output; evidence is bound on a synthetic per-call id. The host still
    // observed the flowguard-reviewer Task itself, so this is not fatal — but the
    // session identity is unverified and must be visible for audit/diagnostics.
    deps.log.warn(
      'host-task',
      'reviewer child session id is synthetic (no host session metadata); evidence bound on a derived id',
      {
        sessionId,
        obligationId: evidence.obligationId,
        childSessionId: evidence.childSessionId,
      },
    );
  }
  deps.log.info('host-task', 'evidence created', {
    sessionId,
    bindOutcome: bindResult.bindOutcome,
    invocationId: evidence.invocationId,
    obligationId: evidence.obligationId,
    childSessionId: evidence.childSessionId,
    findingsHash: evidence.findingsHash,
  });
  await deps.ws.updateReviewAssurance(sessDir, (s: SessionState) => {
    const assurance = ensureReviewAssurance(s.reviewAssurance);
    const at = evidence.fulfilledAt ?? evidence.invokedAt ?? now;

    const withInvocation = appendInvocationEvidence(assurance, evidence);
    const fulfilled = fulfillObligation(
      withInvocation,
      evidence.obligationId,
      evidence.invocationId,
      at,
    );

    if (!bindResult.attempt) {
      return { ...s, reviewAssurance: fulfilled };
    }

    // The evidence timestamps are the authoritative completion time; `now` is
    // the injected host clock, used only when the evidence carries neither.
    // Update the existing attempt record in-place — never append a duplicate.
    const marked = updateAttemptStatus(fulfilled, bindResult.attempt.attemptId, 'bound', at);
    // Stale any OTHER non-bound attempts for the same obligation.
    const deduped = staleObligationAttempts(
      marked,
      evidence.obligationId,
      bindResult.attempt.attemptId,
      at,
    );
    return { ...s, reviewAssurance: deduped };
  });
  const updated = await readState(sessDir);
  await appendReviewAuditEvent(
    sessDir,
    sessionId,
    updated?.phase ?? 'unknown',
    'review:invocation_captured',
    {
      obligationId: evidence.obligationId,
      invocationId: evidence.invocationId,
      childSessionId: evidence.childSessionId,
      findingsHash: evidence.findingsHash,
      hostTaskCallId: evidence.hostTaskCallId,
      canonicalPromptDigest: evidence.canonicalPromptDigest,
      modelPromptDigest: evidence.modelPromptDigest,
      capturedVerdict: evidence.capturedVerdict,
      bindOutcome: bindResult.bindOutcome,
      callId: evidence.hostTaskCallId,
    },
  );
}

async function persistAttemptStatus(
  deps: HostTaskEvidenceDeps,
  sessDir: string,
  bindResult: HostTaskBindResult,
  now: string,
): Promise<void> {
  const attempt = bindResult.attempt;
  if (!attempt) return;
  const status =
    bindResult.bindOutcome === 'stale_attempt' ? ('stale' as const) : ('rejected' as const);
  // Persist the structured rejection reason at the rejection point, mapped
  // from the canonical bind outcome. Outcomes without a mapping (lifecycle,
  // environment, duplicate) persist no reason — the reissue gate fails
  // closed on a rejected attempt without an explicit reason.
  const rejectionReason =
    status === 'rejected' ? bindOutcomeToRejectionReason(bindResult.bindOutcome) : undefined;
  // Canonical schema-error-set fingerprint for the output-repair stall gate.
  // Diagnostics only: absent for non-schema rejections and for paths without
  // machine-readable issue keys.
  const schemaFingerprint =
    rejectionReason === 'schema_invalid'
      ? schemaErrorFingerprintOf(
          bindResult.diagnostic?.schemaIssueKeys as readonly SchemaIssueKey[] | undefined,
        )
      : null;
  await deps.ws.updateReviewAssurance(sessDir, (s: SessionState) => ({
    ...s,
    reviewAssurance: updateAttemptStatus(
      ensureReviewAssurance(s.reviewAssurance),
      attempt.attemptId,
      status,
      now,
      rejectionReason
        ? {
            rejectionReason,
            ...(schemaFingerprint ? { schemaErrorFingerprint: schemaFingerprint } : {}),
          }
        : undefined,
    ),
  }));
}

/** Upper bound for the diagnostic detail surfaced to the calling agent. */
const MAX_BIND_DETAIL_LENGTH = 300;

/**
 * The host-authored explanation for a failed bind, bounded for output safety.
 *
 * Without it the agent only learns THAT no evidence bound, not why, and retries
 * blindly against the same failure. Only the host-built `message` is forwarded —
 * never raw reviewer payload or schema dumps.
 */
function bindDetail(bindResult: HostTaskBindResult): string | undefined {
  const message = bindResult.diagnostic?.message;
  if (typeof message !== 'string' || message.length === 0) return undefined;
  return message.length > MAX_BIND_DETAIL_LENGTH
    ? `${message.slice(0, MAX_BIND_DETAIL_LENGTH)}…`
    : message;
}

function blockRequiredHostTaskEvidence(
  deps: HostTaskEvidenceDeps,
  sessionId: string,
  policy: string,
  bindResult: HostTaskBindResult,
  hookOutput: { output?: string },
): void {
  deps.log.warn('host-task', 'output blocked — no bindable evidence', {
    sessionId,
    policy,
    bindOutcome: bindResult.bindOutcome,
    ...bindResult.diagnostic,
  });
  const detail = bindDetail(bindResult);
  hookOutput.output = strictBlockedOutput('HOST_SUBAGENT_TASK_REQUIRED', {
    reason: `${REVIEWER_SUBAGENT_TYPE} Task call did not produce bindable host-task evidence`,
    policy,
    policyMode: policy,
    bindOutcome: bindResult.bindOutcome,
    ...(detail ? { detail } : {}),
    reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
    // Include schema errors so the agent can fix specific issues via
    // the canonical repair prompt (obtained by calling flowguard_review).
    ...(bindResult.bindOutcome === 'schema_invalid' && bindResult.diagnostic?.schemaErrors
      ? { schemaErrors: (bindResult.diagnostic.schemaErrors as string[]).join('; ') }
      : {}),
  });
}
