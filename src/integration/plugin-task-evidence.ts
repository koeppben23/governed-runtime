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
import { buildHostTaskEvidence } from './review-evidence-binding.js';
import { appendInvocationEvidence, ensureReviewAssurance } from './review-assurance.js';
import { strictBlockedOutput } from './plugin-helpers.js';
import { REVIEWER_SUBAGENT_TYPE } from './review-enforcement-types.js';

import type { SessionState } from '../state/schema.js';
import type { PluginWorkspace } from './plugin-workspace.js';

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
    const bindResult = buildHostTaskEvidence(eState, sessionId, obligations, invocations, now);
    const evidence = bindResult.evidence;

    if (evidence) {
      deps.log.info('host-task', 'evidence created', {
        sessionId,
        bindOutcome: bindResult.bindOutcome,
        invocationId: evidence.invocationId,
        obligationId: evidence.obligationId,
        childSessionId: evidence.childSessionId,
        findingsHash: evidence.findingsHash,
      });
      await deps.ws.updateReviewAssurance(sessDir, (s) => {
        return {
          ...s,
          reviewAssurance: appendInvocationEvidence(
            ensureReviewAssurance(s.reviewAssurance),
            evidence,
          ),
        };
      });
    } else if (policy === 'host_task_required') {
      deps.log.warn('host-task', 'output blocked — no bindable evidence', {
        sessionId,
        policy,
        bindOutcome: bindResult.bindOutcome,
        ...bindResult.diagnostic,
      });
      hookOutput.output = strictBlockedOutput('HOST_SUBAGENT_TASK_REQUIRED', {
        reason: `${REVIEWER_SUBAGENT_TYPE} Task call did not produce bindable host-task evidence`,
      });
    } else {
      deps.log.warn('host-task', 'bind failed', {
        sessionId,
        bindOutcome: bindResult.bindOutcome,
        ...bindResult.diagnostic,
      });
    }
  } catch (err) {
    deps.logError('host task evidence creation failed', err);
    hookOutput.output = strictBlockedOutput('HOST_SUBAGENT_TASK_REQUIRED', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}
