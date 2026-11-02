/** Component proof for the current V2 capture window; not installed-host evidence. */
import { describe, expect, it } from 'vitest';
import { hashText } from '../../../shared/hashing.js';
import { ReviewInvocationEvidence } from '../../../state/evidence-review-invocation.js';
import {
  NativeReviewCaptureError,
  NativeReviewCaptureFence,
  NativeReviewCaptureOutcomeUnknownError,
} from './native-review-capture.js';
import { NativeReviewInitialController } from './native-review-initial.js';

const OBLIGATION = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '11111111-2222-4111-8111-111111111111';
const MODEL = { providerID: 'capture', modelID: 'probe', variant: 'chosen' } as const;
const PREFIX = 'You are a subagent spawned by another session.\n';
const PROMPT = 'review the frozen plan';
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
  attestation: { toolObligationId: OBLIGATION },
});

function user(text = `${PREFIX}${PROMPT}`, id = 'msg_user') {
  return { type: 'user', id, text, files: [] };
}
function assistant(patch: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    id: 'msg_answer',
    agent: 'flowguard-reviewer',
    model: { providerID: 'capture', id: 'probe', variant: 'chosen' },
    finish: 'stop',
    time: { completed: 1_700_000_000_000 },
    content: [{ type: 'text', text: 'initial review' }],
    ...patch,
  };
}
function idle(outcome = 'succeeded') {
  return { type: 'idle', outcome };
}

function verifyInitialReviewerExecution(history: readonly unknown[], digest: string) {
  const initial = new NativeReviewInitialController();
  initial.admit('child', 'msg_user', user().text);
  initial.context('child', [user()]);
  initial.request('child', [user()], assistant().model);
  return initial.complete('child', history, digest);
}

function captured() {
  const fence = new NativeReviewCaptureFence();
  const lease = fence.begin({
    childSessionId: 'child',
    nativeCallId: 'native-call',
    obligationId: OBLIGATION,
    attemptId: ATTEMPT,
    model: MODEL,
    requestMessageId: 'msg_serialize',
    requestText: 'serialize',
  });
  fence.observePrompt('child', lease.leaseId, lease.requestMessageId, 'serialize');
  const tools = { read: {}, write: {} };
  fence.observeContext('child', lease.leaseId, tools);
  fence.observeModelRequest('child', lease.leaseId, 'primary', {
    providerID: 'capture',
    id: 'probe',
    variant: 'chosen',
  });
  const baseline = [user(), assistant(), idle()];
  const history = [
    ...baseline,
    user('serialize', lease.requestMessageId),
    assistant({ content: [{ type: 'text', text: PAYLOAD }] }),
    idle(),
  ];
  return { fence, lease, tools, baseline, history };
}

describe('V2 native capture proof', () => {
  it('accepts the exact initial reviewer completion and rejects mutation, compaction and interruption', () => {
    const digest = hashText(PROMPT);
    expect(verifyInitialReviewerExecution([user(), assistant(), idle()], digest)).toMatchObject({
      model: MODEL,
    });
    expect(() =>
      verifyInitialReviewerExecution([user(`${PREFIX}foreign`), assistant(), idle()], digest),
    ).toThrow('history changed');
    expect(() =>
      verifyInitialReviewerExecution(
        [user(), assistant(), { type: 'compaction', status: 'completed' }, idle()],
        digest,
      ),
    ).toThrow('unexplained extra entries');
    expect(() =>
      verifyInitialReviewerExecution([user(), assistant(), idle('interrupted')], digest),
    ).toThrow('successful terminal boundary');
  });

  it('builds one exact V6 capture/provenance window and removes all tools', () => {
    const { fence, lease, tools, baseline, history } = captured();
    expect(tools).toEqual({});
    const proof = fence.verify('child', lease.leaseId, baseline, history);
    expect(proof.capture).toMatchObject({
      childSessionId: 'child',
      obligationId: OBLIGATION,
      attemptId: ATTEMPT,
      requestMessageId: lease.requestMessageId,
      responseMessageId: 'msg_answer',
      model: MODEL,
      payloadText: PAYLOAD,
    });
    expect(proof.provenance).toMatchObject({
      nativeCallId: 'native-call',
      model: MODEL,
      terminal: { outcome: 'succeeded', finish: 'stop' },
      modelRequest: { kind: 'primary', model: MODEL },
      userMessageCount: 1,
      toolAttemptCount: 0,
    });
    const invocation = ReviewInvocationEvidence.safeParse({
      invocationId: '33333333-3333-4333-8333-333333333333',
      obligationId: OBLIGATION,
      obligationType: 'plan',
      parentSessionId: 'parent',
      childSessionId: 'child',
      agentType: 'flowguard-reviewer',
      attemptId: ATTEMPT,
      invocationMode: 'native_subagent_message_json',
      transportVersion: 6,
      capture: proof.capture,
      nativeProvenance: proof.provenance,
      hostVisible: true,
      transcriptNavigable: true,
      promptHash: hashText(PROMPT),
      mandateDigest: 'mandate',
      criteriaVersion: 'criteria',
      findingsHash: 'a'.repeat(64),
      invokedAt: new Date().toISOString(),
      fulfilledAt: new Date().toISOString(),
      consumedByObligationId: null,
      capturedRawFindings: JSON.parse(PAYLOAD),
      source: 'host-orchestrated',
      reviewOutputMode: 'validated_json',
      reviewAssuranceLevel: 'host_message_validated',
    });
    expect(invocation.success, JSON.stringify(invocation.error?.issues)).toBe(true);
  });

  it('rejects replay, foreign/mutated requests, model drift and baseline changes', () => {
    const first = captured();
    expect(() =>
      first.fence.observePrompt(
        'child',
        first.lease.leaseId,
        first.lease.requestMessageId,
        'foreign',
      ),
    ).toThrow(NativeReviewCaptureError);
    const second = captured();
    expect(() =>
      second.fence.verify('child', second.lease.leaseId, second.baseline, [
        ...second.baseline,
        user('foreign', second.lease.requestMessageId),
        assistant({ content: [{ type: 'text', text: PAYLOAD }] }),
        idle(),
      ]),
    ).toThrow('exact terminal assistant');
    const third = captured();
    const mutatedBaseline = [
      { ...third.baseline[0], text: `${PREFIX}mutated` },
      ...third.baseline.slice(1),
    ];
    expect(() =>
      third.fence.verify('child', third.lease.leaseId, third.baseline, [
        ...mutatedBaseline,
        ...third.history.slice(3),
      ]),
    ).toThrow('baseline window');
    const fourth = captured();
    expect(() =>
      fourth.fence.verify('child', fourth.lease.leaseId, fourth.baseline, [
        ...fourth.baseline,
        user('serialize', fourth.lease.requestMessageId),
        assistant({
          content: [{ type: 'text', text: PAYLOAD }],
          model: { providerID: 'capture', id: 'other', variant: 'chosen' },
        }),
        idle(),
      ]),
    ).toThrow('exact terminal assistant');
  });

  it('distinguishes a tool attempt from an unknown/interrupted terminal outcome', () => {
    const tool = captured();
    expect(() => tool.fence.beforeTool('child')).toThrow(NativeReviewCaptureError);
    expect(() =>
      tool.fence.verify('child', tool.lease.leaseId, tool.baseline, tool.history),
    ).toThrow(NativeReviewCaptureError);

    const unknown = captured();
    expect(() =>
      unknown.fence.verify('child', unknown.lease.leaseId, unknown.baseline, [
        ...unknown.baseline,
        user('serialize', unknown.lease.requestMessageId),
        assistant({ finish: undefined, error: { type: 'aborted' } }),
        idle('interrupted'),
      ]),
    ).toThrow(NativeReviewCaptureOutcomeUnknownError);
  });

  it('rejects a V6 invocation without matching provenance and a V5 invocation carrying it', () => {
    const { fence, lease, baseline, history } = captured();
    const proof = fence.verify('child', lease.leaseId, baseline, history);
    const base = {
      invocationId: '33333333-3333-4333-8333-333333333333',
      obligationId: OBLIGATION,
      obligationType: 'plan',
      parentSessionId: 'parent',
      childSessionId: 'child',
      agentType: 'flowguard-reviewer',
      attemptId: ATTEMPT,
      capture: proof.capture,
      hostVisible: true,
      transcriptNavigable: true,
      promptHash: hashText(PROMPT),
      mandateDigest: 'mandate',
      criteriaVersion: 'criteria',
      findingsHash: 'a'.repeat(64),
      invokedAt: new Date().toISOString(),
      fulfilledAt: new Date().toISOString(),
      consumedByObligationId: null,
      capturedRawFindings: JSON.parse(PAYLOAD),
      source: 'host-orchestrated',
      reviewOutputMode: 'validated_json',
      reviewAssuranceLevel: 'host_message_validated',
    };
    expect(
      ReviewInvocationEvidence.safeParse({
        ...base,
        invocationMode: 'native_subagent_message_json',
        transportVersion: 6,
      }).success,
    ).toBe(false);
    expect(
      ReviewInvocationEvidence.safeParse({
        ...base,
        invocationMode: 'native_task_message_json',
        transportVersion: 5,
        nativeProvenance: proof.provenance,
      }).success,
    ).toBe(false);
  });

  it('enforces lease exclusivity, observation order and lifecycle ownership', () => {
    const fence = new NativeReviewCaptureFence();
    const lease = fence.begin({
      childSessionId: 'child',
      nativeCallId: 'native-call',
      obligationId: OBLIGATION,
      attemptId: ATTEMPT,
      model: MODEL,
      requestMessageId: 'msg_serialize',
      requestText: 'serialize',
    });
    expect(() =>
      fence.begin({
        childSessionId: 'child',
        nativeCallId: 'other',
        obligationId: OBLIGATION,
        attemptId: ATTEMPT,
        model: MODEL,
        requestMessageId: 'msg_other',
        requestText: 'serialize',
      }),
    ).toThrow('already owns');
    expect(fence.activeLease('child')).toBe(lease.leaseId);
    expect(fence.isActive('child', lease.leaseId)).toBe(true);
    fence.quarantine('child', lease.leaseId);
    expect(fence.activeLease('child')).toBeUndefined();
    expect(fence.isActive('child', lease.leaseId)).toBe(false);
    fence.release('child', lease.leaseId);
    expect(fence.activeLease('child')).toBeUndefined();
    expect(() => fence.observeContext('missing', lease.leaseId, {})).toThrow('unavailable');
  });

  it.each([
    [
      'prompt duplicate',
      (f: NativeReviewCaptureFence, l: ReturnType<NativeReviewCaptureFence['begin']>) => {
        f.observePrompt('child', l.leaseId, l.requestMessageId, 'serialize');
        f.observePrompt('child', l.leaseId, l.requestMessageId, 'serialize');
      },
    ],
    [
      'prompt foreign id',
      (f: NativeReviewCaptureFence, l: ReturnType<NativeReviewCaptureFence['begin']>) =>
        f.observePrompt('child', l.leaseId, 'msg_foreign', 'serialize'),
    ],
    [
      'prompt foreign digest',
      (f: NativeReviewCaptureFence, l: ReturnType<NativeReviewCaptureFence['begin']>) =>
        f.observePrompt('child', l.leaseId, l.requestMessageId, 'foreign'),
    ],
    [
      'context duplicate',
      (f: NativeReviewCaptureFence, l: ReturnType<NativeReviewCaptureFence['begin']>) => {
        f.observeContext('child', l.leaseId, {});
        f.observeContext('child', l.leaseId, {});
      },
    ],
    [
      'model duplicate',
      (f: NativeReviewCaptureFence, l: ReturnType<NativeReviewCaptureFence['begin']>) => {
        f.observeModelRequest('child', l.leaseId, 'primary', MODEL);
        f.observeModelRequest('child', l.leaseId, 'primary', MODEL);
      },
    ],
    [
      'model kind',
      (f: NativeReviewCaptureFence, l: ReturnType<NativeReviewCaptureFence['begin']>) =>
        f.observeModelRequest('child', l.leaseId, 'compaction', MODEL),
    ],
    [
      'model drift',
      (f: NativeReviewCaptureFence, l: ReturnType<NativeReviewCaptureFence['begin']>) =>
        f.observeModelRequest('child', l.leaseId, 'primary', { ...MODEL, variant: 'other' }),
    ],
  ] as const)('rejects %s without releasing the lease', (_label, act) => {
    const fence = new NativeReviewCaptureFence();
    const lease = fence.begin({
      childSessionId: 'child',
      nativeCallId: 'native-call',
      obligationId: OBLIGATION,
      attemptId: ATTEMPT,
      model: MODEL,
      requestMessageId: 'msg_serialize',
      requestText: 'serialize',
    });
    expect(() => act(fence, lease)).toThrow();
    expect(fence.isActive('child', lease.leaseId)).toBe(false);
  });

  it.each([
    [
      'wrong user id',
      (w: Record<string, unknown>[]) => {
        w[0]!.id = 'msg_other';
      },
    ],
    [
      'wrong user text',
      (w: Record<string, unknown>[]) => {
        w[0]!.text = 'foreign';
      },
    ],
    [
      'user files',
      (w: Record<string, unknown>[]) => {
        w[0]!.files = ['foreign'];
      },
    ],
    [
      'assistant type',
      (w: Record<string, unknown>[]) => {
        w[1]!.type = 'user';
      },
    ],
    [
      'assistant id',
      (w: Record<string, unknown>[]) => {
        w[1]!.id = 'raw';
      },
    ],
    [
      'assistant agent',
      (w: Record<string, unknown>[]) => {
        w[1]!.agent = 'general';
      },
    ],
    [
      'assistant finish',
      (w: Record<string, unknown>[]) => {
        w[1]!.finish = 'length';
      },
    ],
    [
      'assistant error',
      (w: Record<string, unknown>[]) => {
        w[1]!.error = { type: 'aborted' };
      },
    ],
    [
      'assistant time',
      (w: Record<string, unknown>[]) => {
        w[1]!.time = {};
      },
    ],
    [
      'assistant model',
      (w: Record<string, unknown>[]) => {
        w[1]!.model = { providerID: 'capture', id: 'other', variant: 'chosen' };
      },
    ],
    [
      'assistant non-text',
      (w: Record<string, unknown>[]) => {
        w[1]!.content = [{ type: 'file' }];
      },
    ],
    [
      'assistant synthetic text',
      (w: Record<string, unknown>[]) => {
        w[1]!.content = [{ type: 'text', text: PAYLOAD, synthetic: true }];
      },
    ],
    [
      'assistant ignored text',
      (w: Record<string, unknown>[]) => {
        w[1]!.content = [{ type: 'text', text: PAYLOAD, ignored: true }];
      },
    ],
  ] as const)('rejects a captured window with %s', (_label, mutate) => {
    const { fence, lease, baseline, history } = captured();
    const window = history
      .slice(baseline.length)
      .map((entry) => ({ ...(entry as Record<string, unknown>) }));
    mutate(window);
    expect(() =>
      fence.verify('child', lease.leaseId, baseline, [...baseline, ...window]),
    ).toThrow();
  });

  it('ignores reasoning/step parts but rejects malformed initial histories', () => {
    const digest = hashText(PROMPT);
    const reasoning = assistant({
      content: [
        { type: 'reasoning', text: 'hidden' },
        { type: 'step-start' },
        { type: 'text', text: 'review' },
        { type: 'step-finish' },
      ],
    });
    expect(verifyInitialReviewerExecution([user(), reasoning, idle()], digest)).toMatchObject({
      model: MODEL,
    });
    for (const history of [
      null,
      [],
      [user(), user()],
      [user(), assistant({ content: [{ type: 'file' }] }), idle()],
      [user(), assistant({ finish: 'length' }), idle()],
      [user(), assistant({ error: { type: 'aborted' } }), idle()],
      [user(), assistant(), idle('interrupted')],
      [user(), { type: 'compaction' }, assistant(), idle()],
    ])
      expect(() => verifyInitialReviewerExecution(history as readonly unknown[], digest)).toThrow();
  });
});
