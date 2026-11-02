/** Component evidence-binding contract for V6; not an installed-host proof. */
import { describe, expect, it } from 'vitest';
import { readState } from '../../../adapters/persistence.js';
import { seedStrictPlanSession } from '../../plugin-host-task-diagnostics-test-helpers.js';
import { createTestWorkspace } from '../../test-helpers.js';
import { ensureReviewAssurance } from '../../../state/review-dispatch.js';
import { hashFindings } from '../findings-hash.js';
import { recordEvidenceOrBlockReuse } from '../evidence/reviewer-evidence-recorder.js';
import type { SessionState } from '../../../state/schema.js';
import type { SemanticAuditIntent } from '../../audit-outbox.js';
import { NativeReviewCaptureFence } from './native-review-capture.js';

const CAPTURE_PROMPT = 'serialize';
const PAYLOAD = JSON.stringify({
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
  attestation: { toolObligationId: '11111111-1111-4111-8111-111111111111' },
});

function proof() {
  const model = { providerID: 'capture', modelID: 'probe', variant: 'chosen' } as const;
  const fence = new NativeReviewCaptureFence();
  const lease = fence.begin({
    childSessionId: 'child',
    nativeCallId: 'native-call',
    obligationId: '11111111-1111-4111-8111-111111111111',
    attemptId: '11111111-2222-4111-8111-111111111111',
    model,
    requestText: CAPTURE_PROMPT,
  });
  fence.observePrompt('child', lease.leaseId, lease.requestMessageId, CAPTURE_PROMPT);
  fence.observeContext('child', lease.leaseId, {});
  fence.observeModelRequest('child', lease.leaseId, 'primary', {
    providerID: 'capture',
    id: 'probe',
    variant: 'chosen',
  });
  const baseline = [
    {
      type: 'user',
      id: 'msg_initial',
      text: `You are a subagent spawned by another session.\nfrozen`,
      files: [],
    },
    { type: 'assistant', id: 'msg_review', content: [{ type: 'text', text: 'review' }] },
    { type: 'idle', outcome: 'succeeded' },
  ];
  const history = [
    ...baseline,
    { type: 'user', id: lease.requestMessageId, text: CAPTURE_PROMPT, files: [] },
    {
      type: 'assistant',
      id: 'msg_answer',
      agent: 'flowguard-reviewer',
      model: { providerID: 'capture', id: 'probe', variant: 'chosen' },
      finish: 'stop',
      time: { completed: 1_700_000_000_000 },
      content: [{ type: 'text', text: PAYLOAD }],
    },
    { type: 'idle', outcome: 'succeeded' },
  ];
  return fence.verify('child', lease.leaseId, baseline, history);
}

function withV6State(state: SessionState, child = 'child'): SessionState {
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const attempt = assurance.attempts[0]!;
  const obligation = assurance.obligations[0]!;
  return {
    ...state,
    reviewAssurance: {
      ...assurance,
      attempts: assurance.attempts.map((item) =>
        item.attemptId === attempt.attemptId ? { ...item, childSessionId: child } : item,
      ),
      dispatches: [
        {
          dispatchId: '44444444-4444-4444-8444-444444444444',
          attemptId: attempt.attemptId,
          obligationId: obligation.obligationId,
          hostCallId: 'native-call',
          canonicalPromptDigest: 'a'.repeat(64),
          dispatchAuthorizedAt: new Date().toISOString(),
          dispatchStatus: 'authorized',
        },
      ],
    },
  };
}

async function fixture() {
  const ws = await createTestWorkspace();
  const seeded = await seedStrictPlanSession(ws.tmpDir, 'parent');
  const state = withV6State((await readState(seeded.sessDir))!);
  const now = new Date().toISOString();
  const stateRef = { current: state };
  let lastIntents: readonly SemanticAuditIntent[] = [];
  const deps = {
    updateReviewAssurance: async (
      _dir: string,
      update: (value: SessionState, now: string) => SessionState,
      intents?: (value: SessionState, now: string) => readonly SemanticAuditIntent[],
    ) => {
      stateRef.current = update(stateRef.current, now);
      lastIntents = intents ? [...intents(stateRef.current, now)] : [];
    },
  };
  return {
    ws,
    seeded,
    stateRef,
    deps,
    lastIntents: () => lastIntents,
    now,
  };
}

describe('V6 evidence binding', () => {
  it('binds child, attempt, invocation, dispatch and obligation atomically', async () => {
    const h = await fixture();
    const captured = proof();
    const findings = JSON.parse(PAYLOAD);
    const result = await recordEvidenceOrBlockReuse(h.deps as never, h.seeded.sessDir, {
      obligationId: '11111111-1111-4111-8111-111111111111',
      obligationType: 'plan',
      sessionId: 'parent',
      childSessionId: 'child',
      hostCallId: 'native-call',
      attemptId: '11111111-2222-4111-8111-111111111111',
      promptHash: 'a'.repeat(64),
      findingsHash: hashFindings(findings),
      invokedAt: h.now,
      fulfilledAt: h.now,
      reviewerResult: {
        sessionId: 'child',
        findings,
        reviewOutputMode: 'validated_json',
        reviewAssuranceLevel: 'host_message_validated',
        capture: captured.capture,
      },
      nativeProvenance: captured.provenance,
      semanticIntents: () => [
        {
          phase: 'PLAN',
          event: 'review:subagent_invoked',
          occurredAt: h.now,
          detail: {},
        },
      ],
    });
    expect(result).toBe('fulfilled');
    const assurance = h.stateRef.current.reviewAssurance!;
    expect(assurance.attempts[0]).toMatchObject({ status: 'bound', childSessionId: 'child' });
    expect(assurance.obligations[0]!.status).toBe('fulfilled');
    expect(assurance.dispatches[0]).toMatchObject({
      hostCallId: 'native-call',
      dispatchStatus: 'completed',
    });
    expect(assurance.invocations[0]).toMatchObject({
      invocationMode: 'native_subagent_message_json',
      transportVersion: 6,
      childSessionId: 'child',
    });
    expect(h.lastIntents()).toHaveLength(1);
    await h.ws.cleanup();
  });

  it('rejects foreign provenance and expiry before writing an invocation', async () => {
    const h = await fixture();
    const captured = proof();
    const findings = JSON.parse(PAYLOAD);
    const base = {
      obligationId: '11111111-1111-4111-8111-111111111111',
      obligationType: 'plan' as const,
      sessionId: 'parent',
      childSessionId: 'child',
      hostCallId: 'native-call',
      attemptId: '11111111-2222-4111-8111-111111111111',
      promptHash: 'a'.repeat(64),
      findingsHash: hashFindings(findings),
      invokedAt: h.now,
      fulfilledAt: h.now,
      reviewerResult: {
        sessionId: 'child',
        findings,
        reviewOutputMode: 'validated_json' as const,
        reviewAssuranceLevel: 'host_message_validated' as const,
        capture: captured.capture,
      },
    };
    expect(
      await recordEvidenceOrBlockReuse(h.deps as never, h.seeded.sessDir, {
        ...base,
        nativeProvenance: { ...captured.provenance, nativeCallId: 'foreign' },
      }),
    ).toBe('lineage_unavailable');
    expect(h.stateRef.current.reviewAssurance!.invocations).toHaveLength(0);
    expect(
      await recordEvidenceOrBlockReuse(h.deps as never, h.seeded.sessDir, {
        ...base,
        nativeProvenance: captured.provenance,
        executionFailed: () => true,
      }),
    ).toBe('execution_expired');
    expect(h.stateRef.current.reviewAssurance!.invocations).toHaveLength(0);
    await h.ws.cleanup();
  });
});
