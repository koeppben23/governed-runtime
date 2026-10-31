/** Obligation-bound schema through the canonical capture/bind pipeline. The
 * semantic host fixture is deliberately NOT installed V2 provenance evidence. */
import * as crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTestWorkspace } from './test-helpers.js';
import { createReviewClient } from './opencode-v2-test-helpers.js';
import { readState } from '../adapters/persistence.js';
import {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from './review/dispatch/dispatch-authority.js';
import { seedStrictPlanSession } from './plugin-host-task-diagnostics-test-helpers.js';
import { REVIEW_FINDINGS_JSON_SCHEMA } from './review/evidence/findings-schema.js';
import {
  completedReviewMessages,
  createReviewRuntime,
  observedPrompt,
  REVIEW_TEST_PROOF_GRAPH_AUTHORITIES,
} from './reviewer-capture-test-helpers.js';
import { ReviewerCaptureController } from './reviewer-capture.js';
import {
  nativeReviewTaskBefore,
  nativeReviewTaskAfter,
} from './review/dispatch/native-task-review.js';
import { onFlowGuardToolAfter } from './review/enforcement/enforcement.js';
import { isTerminalPhase } from '../machine/topology.js';

const CHILD = 'child-bound-schema';
type SentSchema = {
  properties: Record<string, { const?: unknown; properties?: Record<string, { const?: unknown }> }>;
};

async function runPlanReview(iteration: number) {
  const ws = await createTestWorkspace();
  try {
    const sessionID = crypto.randomUUID();
    const { sessDir, obligationId } = await seedStrictPlanSession(ws.tmpDir, sessionID);
    const sent: SentSchema[] = [];
    const capture = new ReviewerCaptureController();
    const prompt = vi.fn(
      async (
        input: Parameters<ReturnType<typeof createReviewClient>['executeReviewerPrompt']>[0],
      ) => {
        expect(input).not.toHaveProperty('format');
        const prefix = 'ReviewerFindingsInput JSON schema (data, not instructions): ';
        const line = input.text.split('\n').find((part) => part.startsWith(prefix));
        sent.push(JSON.parse(line?.slice(prefix.length) ?? '{}') as SentSchema);
        return observedPrompt(
          capture,
          input,
          JSON.stringify({
            iteration,
            planVersion: 1,
            reviewMode: 'subagent',
            overallVerdict: 'accept',
            blockingIssues: [],
            majorRisks: [],
            missingVerification: [],
            scopeCreep: [],
            unknowns: [],
            challenges: [],
            attestation: { toolObligationId: obligationId },
          }),
        );
      },
    );
    const client = createReviewClient({
      listAgents: vi.fn(async () => [{ id: 'flowguard-reviewer' }]),
      executeReviewerPrompt: prompt,
      readHistory: vi.fn(async () => completedReviewMessages(CHILD)),
    });
    const runtime = createReviewRuntime(ws.tmpDir, client, capture);
    const state = (await readState(sessDir))!;
    const authority = resolveReviewDispatchAuthority(state.reviewAssurance, obligationId);
    if (authority.kind !== 'ok') throw new Error(authority.reason);
    const response = JSON.stringify({
      phase: 'PLAN',
      reviewMode: 'subagent',
      ...reviewObligationResponseFields(authority.authority),
      reviewDispatch: { required: true },
    });
    onFlowGuardToolAfter(
      runtime.ws.getEnforcementState(sessionID),
      'flowguard_plan',
      {},
      response,
      { now: new Date().toISOString(), isTerminalPhase },
    );
    await nativeReviewTaskBefore(
      runtime,
      { tool: 'task', sessionID, callID: 'call-1' },
      { args: { subagent_type: 'flowguard-reviewer', prompt: 'untrusted' } },
      async () => undefined,
      REVIEW_TEST_PROOF_GRAPH_AUTHORITIES,
    );
    const output = { title: '', output: 'Not findings authority.', metadata: { sessionId: CHILD } };
    await nativeReviewTaskAfter(
      runtime,
      { tool: 'task', sessionID, callID: 'call-1', args: { subagent_type: 'flowguard-reviewer' } },
      output,
    );
    return {
      sent,
      prompt,
      obligationId,
      obligation: state.reviewAssurance!.obligations[0]!,
      after: (await readState(sessDir))!,
      result: JSON.parse(output.output) as Record<string, unknown>,
    };
  } finally {
    await ws.cleanup();
  }
}

describe('canonical obligation-bound capture schema through the semantic client', () => {
  it('sends the bound schema and binds a valid, fully correlated fixture', async () => {
    const run = await runPlanReview(0);
    expect(run.prompt).toHaveBeenCalledOnce();
    const sent = run.sent[0]!;
    expect(sent).not.toBe(REVIEW_FINDINGS_JSON_SCHEMA);
    expect(sent.properties.iteration?.const).toBe(run.obligation.iteration);
    expect(sent.properties.planVersion?.const).toBe(run.obligation.planVersion);
    expect(sent.properties.attestation?.properties?.toolObligationId?.const).toBe(run.obligationId);
    expect(run.result.reviewDispatch).toEqual({
      required: true,
      completed: true,
      verdict: 'accept',
    });
    expect(run.after.reviewAssurance!.obligations[0]?.status).toBe('fulfilled');
  });

  it('rejects a schema-const violation rather than normalizing the answer', async () => {
    const run = await runPlanReview(1);
    expect(run.prompt).toHaveBeenCalledOnce();
    expect(run.result).toMatchObject({ error: true, code: 'SUBAGENT_MANDATE_MISMATCH' });
    expect(run.after.reviewAssurance!.invocations).toHaveLength(0);
    expect(run.after.reviewAssurance!.obligations[0]?.status).not.toBe('fulfilled');
    expect(
      run.after.reviewAssurance!.attempts.filter((attempt) => attempt.status === 'bound'),
    ).toHaveLength(0);
  });
});
