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
import { buildHostTaskEvidence } from './review/evidence-binding.js';
import {
  appendInvocationEvidence,
  ensureReviewAssurance,
  appendReviewAttempt,
  staleObligationAttempts,
} from './review/assurance.js';
import { appendReviewAuditEvent } from './review/audit-events.js';
import { strictBlockedOutput } from './plugin-helpers.js';
import { REVIEWER_SUBAGENT_TYPE } from './review/enforcement/types.js';

import type { PluginWorkspace } from './plugin-workspace.js';
import type { SessionState } from '../state/schema.js';
import type { HostTaskBindResult } from './review/enforcement/types.js';

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
export async function handleHostTaskEvidence(
  deps: HostTaskEvidenceDeps,
  sessionId: string,
  resolvedChildSessionId: string | null,
  now: string,
  hookOutput: { output?: string },
): Promise<void> {
  deps.log.info('host-task', 'reviewer task completed', {
    sessionId,
    resolvedChildSessionId,
  });

  try {
    const sessDir = deps.ws.getSessionDir(sessionId);
    if (!sessDir) return;

    const state = await readState(sessDir);
    if (!state) return;

    const policy = state.policySnapshot?.reviewInvocationPolicy;
    if (policy !== 'host_task_required' && policy !== 'host_task_preferred') return;

    const obligations = state.reviewAssurance?.obligations ?? [];
    const invocations = state.reviewAssurance?.invocations ?? [];

    deps.log.info('host-task', 'bind attempt', {
      sessionId,
      policy,
      pendingObligationCount: obligations.filter((o) => o.status === 'pending').length,
      totalInvocations: invocations.length,
    });

    const eState = deps.ws.getEnforcementState(sessionId);
    const expectedSubject = state.plan?.current.digest ?? null;
    const attempts = state.reviewAssurance?.attempts;
    const bindResult = buildHostTaskEvidence(
      eState,
      sessionId,
      obligations,
      invocations,
      now,
      expectedSubject,
      attempts,
    );
    await applyHostTaskBindResult({ deps, sessDir, sessionId, policy, bindResult, hookOutput });
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

async function applyHostTaskBindResult(input: {
  deps: HostTaskEvidenceDeps;
  sessDir: string;
  sessionId: string;
  policy: string;
  bindResult: HostTaskBindResult;
  hookOutput: { output?: string };
}): Promise<void> {
  const { deps, sessDir, sessionId, policy, bindResult, hookOutput } = input;
  if (bindResult.evidence) {
    await persistHostTaskEvidence(deps, sessDir, sessionId, bindResult);
    return;
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
  const divergence = bindResult.diagnostic?.hostConstantDivergence;
  if (Array.isArray(divergence) && divergence.length > 0) {
    deps.log.warn(
      'host-task',
      'reviewer attestation diverged from host constants; bound host-authoritatively',
      {
        sessionId,
        obligationId: evidence.obligationId,
        childSessionId: evidence.childSessionId,
        divergentFields: divergence,
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
    const withInvocation = appendInvocationEvidence(assurance, evidence);
    if (bindResult.attempt) {
      // Stale any prior attempts for this obligation, then append the new one.
      const deduped = staleObligationAttempts(
        withInvocation,
        evidence.obligationId,
        bindResult.attempt.attemptId,
        evidence.fulfilledAt ?? evidence.invokedAt ?? new Date().toISOString(),
      );
      return {
        ...s,
        reviewAssurance: appendReviewAttempt(deduped, bindResult.attempt),
      };
    }
    return { ...s, reviewAssurance: withInvocation };
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
      capturedVerdict: evidence.capturedVerdict,
      bindOutcome: bindResult.bindOutcome,
    },
  );
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
  hookOutput.output = strictBlockedOutput('HOST_SUBAGENT_TASK_REQUIRED', {
    reason: `${REVIEWER_SUBAGENT_TYPE} Task call did not produce bindable host-task evidence`,
    policy,
    policyMode: policy,
    bindOutcome: bindResult.bindOutcome,
    reviewerSubagentType: REVIEWER_SUBAGENT_TYPE,
  });
}
