/** Canonical capture-validator fixtures, never evidence of installed V2 provenance. */
import type { OrchestratorClient } from './review/types.js';
import { ReviewerCaptureController } from './reviewer-capture.js';
import { createWorkspace } from './plugin-workspace.js';
import { createNoopLogger } from '../logging/logger.js';
import type { NativeReviewTransportRuntime } from './review/dispatch/native-task-review-types.js';
import { evaluateProofGraphGate } from '../audit/proofgraph/gate.js';
import { renderPlanClaimDeclarations } from '../presentation/plan-claim-declarations.js';

export const REVIEW_TEST_PROOF_GRAPH_AUTHORITIES = {
  evaluateProofGraphGate,
  renderPlanClaimDeclarations,
};

export const CAPTURE_OBLIGATION = '44444444-4444-4444-8444-444444444444';
export const CAPTURE_ATTEMPT = '55555555-5555-4555-8555-555555555555';
export const CAPTURE_MODEL = {
  providerID: 'test-provider',
  modelID: 'test-model',
  variant: 'high',
} as const;

export function reviewerInputFixture() {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    attestation: { toolObligationId: CAPTURE_OBLIGATION },
  };
}

export function completedReviewMessages(child: string, model = CAPTURE_MODEL) {
  return [
    {
      info: {
        id: 'msg_native_request',
        sessionID: child,
        role: 'user',
        agent: 'flowguard-reviewer',
        model,
      },
    },
    {
      info: {
        id: 'msg_native_answer',
        parentID: 'msg_native_request',
        sessionID: child,
        role: 'assistant',
        agent: 'flowguard-reviewer',
        ...model,
        finish: 'stop',
      },
      parts: [{ type: 'text', text: 'Final review answer.' }],
    },
  ];
}

/** Test the current canonical review contract directly, with real persistence.
 * This is not a host adapter, a plugin factory or a V2 completion attestation. */
export function createReviewRuntime(
  root: string,
  client: OrchestratorClient,
  reviewerCapture = new ReviewerCaptureController(),
): NativeReviewTransportRuntime {
  const ws = createWorkspace({ auditWorktree: root });
  const log = createNoopLogger();
  return {
    ws,
    log,
    logError: (message, error) => log.error('review-test', message, { error }),
    reviewerOutputCapFailures: new Map(),
    reviewerExecutionFailures: new Map(),
    orchestratorDeps: {
      client,
      reviewerCapture,
      log,
      resolveSessionAuthority: (id) => ws.resolveSessionAuthority(id),
      updateReviewAssurance: ws.updateReviewAssurance,
      blockReviewOutcome: ws.blockReviewOutcome,
      getEnforcementState: ws.getEnforcementState,
    },
  };
}

export function observedPrompt(
  controller: ReviewerCaptureController,
  opts: Parameters<OrchestratorClient['executeReviewerPrompt']>[0],
  text: string,
) {
  const { requestId, sessionId, model: selected, agent } = opts;
  if (!requestId || !selected || !agent)
    throw new Error('Host fixture requires explicit request identity.');
  const model = {
    providerID: selected.providerID,
    modelID: selected.modelID,
    ...(selected.variant === null ? {} : { variant: selected.variant }),
  };
  const parts = [{ type: 'text', text: opts.text }];
  const user = { id: requestId, sessionID: sessionId, role: 'user', agent, model };
  controller.onMessage({ sessionID: sessionId }, { message: user, parts });
  controller.onMessages({ messages: [{ info: user, parts }] });
  controller.onParams(
    {
      sessionID: sessionId,
      agent,
      message: user,
      model: { providerID: model.providerID, id: model.modelID },
    },
    { options: {} },
  );
  return {
    info: {
      id: `msg_response_${requestId}`,
      parentID: requestId,
      sessionID: sessionId,
      role: 'assistant',
      agent,
      providerID: model.providerID,
      modelID: model.modelID,
      ...(selected.variant === null ? {} : { variant: selected.variant }),
      finish: 'stop',
      time: { completed: Date.now() },
    },
    parts: [{ type: 'text', text }],
  };
}
