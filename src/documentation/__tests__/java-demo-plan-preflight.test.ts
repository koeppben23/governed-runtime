/** The recovery candidate is an occurrence-bound observation, not a gate or approval. */
import { describe, expect, it, vi } from 'vitest';
import {
  pendingPlanPreflight as projectPreflight,
  planPreflightGate as projectGate,
  planReviewCorrectionProven,
} from '../../../demos/java-task-manager/live-plan-preflight.mjs';
import { Runner } from '../../../demos/java-task-manager/live-runner.mjs';
import { reviewedPlan, validateReviewInvocation } from '../demo-recovery-test-helpers.js';

const SESSION = 'ses_planning';
const DIGEST = 'a'.repeat(64);
const CODE = 'PLAN_EVIDENCE_DESIGN_REQUIRED';
const step = 'plan-step';
const denial = { error: true, code: CODE };
const acceptance = { phase: 'PLAN_REVIEW', planDigest: DIGEST };
const tool = (payload: object, sessionID = SESSION, tool = 'flowguard_plan') =>
  JSON.stringify({
    type: 'tool_use',
    sessionID,
    part: { tool, state: { output: JSON.stringify(payload) } },
  });
const output = (...lines: string[]) => lines.join('\n');

function reviewed() {
  const state = reviewedPlan(DIGEST, 'b'.repeat(64), SESSION);
  return {
    ...state,
    selfReview: { iteration: 2, maxIterations: 2, verdict: 'accept' },
    plan: {
      ...state.plan,
      claimDeclarations: { claims: [{ claimId: 'claim-1' }] },
    },
  };
}

const pendingPlanPreflight = (
  transcript: string,
  label: string,
  state: ReturnType<typeof reviewed>,
  sessionId: string,
  phase: string,
) => projectPreflight(transcript, label, state, sessionId, phase, validateReviewInvocation);
const planPreflightGate = (state: ReturnType<typeof reviewed>, sessionId: string) =>
  projectGate(state, sessionId, validateReviewInvocation);

describe('plan-preflight evidence projection', () => {
  it.each([
    'PLAN_EVIDENCE_DESIGN_REQUIRED',
    'PLAN_EVIDENCE_DESIGN_INVALID',
    'PLAN_FINDING_RESOLUTION_REQUIRED',
    'PLAN_FINDING_RESOLUTION_INVALID',
    'PLAN_CLAIM_LINEAGE_REQUIRED',
    'PLAN_CLAIM_LINEAGE_INVALID',
    'REVIEW_SUBJECT_CHANGED_WHILE_PENDING',
    'PLAN_CLAIM_SUBMISSION_REJECTED',
  ])('tracks %s only as a pending candidate', (code) => {
    const state = reviewed();
    const transcript = output(
      tool({ error: true, code }),
      tool({ phase: 'PLAN', planDigest: DIGEST }),
      tool(acceptance),
      tool({ phase: 'PLAN_REVIEW' }, SESSION, 'flowguard_status'),
    );
    expect(pendingPlanPreflight(transcript, step, state, SESSION, 'PLAN')).toEqual({
      status: 'pending_verification',
      step,
      codes: [code],
      evidence: 'same_turn_plan_preflight_correction',
      gate: {
        kind: 'subject_approval',
        flowguardSessionId: state.flowguardSessionId,
        hostSessionId: SESSION,
        artifact: 'plan',
        command: 'approve',
        fromPhase: 'PLAN_REVIEW',
        digest: DIGEST,
        recordDigest: 'b'.repeat(64),
        planVersion: 1,
        certificateBefore: null,
        review: {
          obligationId: state.reviewAssurance.obligations[0]!.obligationId,
          invocationId: state.reviewAssurance.invocations[0]!.invocationId,
          attemptId: state.reviewAssurance.attempts[0]!.attemptId,
        },
      },
    });
  });

  it('does not emit a recovery observation for an unrelated denial', () => {
    expect(
      pendingPlanPreflight(
        tool({ error: true, code: 'UNRELATED' }),
        step,
        reviewed(),
        SESSION,
        'PLAN',
      ),
    ).toBeNull();
  });

  it.each([
    [
      'plain correction without acceptance',
      output(tool(denial), tool({ ...acceptance, phase: 'PLAN' })),
      'PLAN',
    ],
    ['foreign denial', output(tool(denial, 'ses_other'), tool(acceptance)), 'PLAN'],
    ['foreign acceptance', output(tool(denial), tool(acceptance, 'ses_other')), 'PLAN'],
    [
      'status in place of plan acceptance',
      output(tool(denial), tool(acceptance, SESSION, 'flowguard_status')),
      'PLAN',
    ],
    [
      'wrong tool for the denial',
      output(tool(denial, SESSION, 'flowguard_status'), tool(acceptance)),
      'PLAN',
    ],
    ['denial after the last success', output(tool(acceptance), tool(denial)), 'PLAN'],
    [
      'failure with an apparent acceptance',
      output(tool(denial), tool({ ...acceptance, error: true })),
      'PLAN',
    ],
    ['old already accepted gate', output(tool(denial), tool(acceptance)), 'PLAN_REVIEW'],
    [
      'first denial binds another subject',
      output(tool({ ...denial, subjectDigest: 'b'.repeat(64) }), tool(denial), tool(acceptance)),
      'PLAN',
    ],
    [
      'second denial after the correction',
      output(tool(denial), tool(acceptance), tool(denial, 'ses_other')),
      'PLAN',
    ],
    [
      'denial binds a different invocation obligation',
      output(tool({ ...denial, obligationId: 'other' }), tool(acceptance)),
      'PLAN',
    ],
    [
      'denial has ambiguous target identities',
      output(
        tool({ ...denial, planDigest: DIGEST, subjectDigest: 'b'.repeat(64) }),
        tool(acceptance),
      ),
      'PLAN',
    ],
  ])('keeps %s pending and unbound', (_name, transcript, phase) => {
    expect(pendingPlanPreflight(transcript, step, reviewed(), SESSION, phase)).toMatchObject({
      status: 'pending_verification',
      gate: null,
    });
  });

  it('binds all denials in sequence and de-duplicates only their reported code', () => {
    const state = reviewed();
    const transcript = output(
      tool({ ...denial, subjectDigest: DIGEST }),
      tool({ ...denial, claimId: 'claim-1' }),
      tool({
        ...denial,
        code: 'PLAN_EVIDENCE_DESIGN_INVALID',
        obligationId: state.reviewAssurance.obligations[0]!.obligationId,
      }),
      tool(acceptance),
    );
    expect(pendingPlanPreflight(transcript, step, state, SESSION, 'PLAN')).toMatchObject({
      status: 'pending_verification',
      codes: [CODE, 'PLAN_EVIDENCE_DESIGN_INVALID'],
      gate: planPreflightGate(state, SESSION),
    });
  });

  const invalidGate: Array<[string, (state: ReturnType<typeof reviewed>) => void]> = [
    [
      'wrong phase',
      (state) => {
        state.phase = 'PLAN';
      },
    ],
    [
      'no FlowGuard identity',
      (state) => {
        state.flowguardSessionId = '';
      },
    ],
    [
      'wrong host session',
      (state) => {
        state.binding.hostSessionId = 'ses_other';
      },
    ],
    [
      'exhausted review',
      (state) => {
        state.plan.reviewCompletion = 'review_exhausted';
      },
    ],
    [
      'changes requested',
      (state) => {
        state.selfReview.verdict = 'changes_requested';
      },
    ],
    [
      'over budget',
      (state) => {
        state.selfReview.iteration = 3;
      },
    ],
    [
      'fractional iteration',
      (state) => {
        state.selfReview.iteration = 1.5;
      },
    ],
    [
      'fractional budget',
      (state) => {
        state.selfReview.maxIterations = 2.5;
      },
    ],
    [
      'no review',
      (state) => {
        Reflect.deleteProperty(state, 'selfReview');
      },
    ],
    [
      'no plan',
      (state) => {
        Reflect.deleteProperty(state, 'plan');
      },
    ],
    [
      'no bound attempt',
      (state) => {
        state.reviewAssurance.attempts = [];
      },
    ],
    [
      'no consumed invocation',
      (state) => {
        state.reviewAssurance.invocations[0]!.consumedByObligationId = 'other';
      },
    ],
    [
      'plan digest begins with junk',
      (state) => {
        const malformed = `_${DIGEST}`;
        state.plan.current.digest =
          state.reviewAssurance.obligations[0]!.subjectDigest =
          state.reviewAssurance.attempts[0]!.subjectDigest =
            malformed;
      },
    ],
    [
      'plan digest ends with junk',
      (state) => {
        const malformed = `${DIGEST}_`;
        state.plan.current.digest =
          state.reviewAssurance.obligations[0]!.subjectDigest =
          state.reviewAssurance.attempts[0]!.subjectDigest =
            malformed;
      },
    ],
    [
      'record digest begins with junk',
      (state) => {
        state.plan.current.recordDigest = `_${DIGEST}`;
      },
    ],
    [
      'record digest ends with junk',
      (state) => {
        state.plan.current.recordDigest = `${DIGEST}_`;
      },
    ],
    [
      'zero revision',
      (state) => {
        state.plan.current.planVersion = 0;
      },
    ],
    [
      'fractional revision',
      (state) => {
        state.plan.current.planVersion = 1.5;
      },
    ],
  ];
  it.each(invalidGate)('does not bind %s', (_name, change) => {
    const state = reviewed();
    change(state);
    expect(planPreflightGate(state, SESSION)).toBeNull();
  });

  it('requires both persisted plan and self review', () => {
    const state = reviewed();
    expect(planReviewCorrectionProven({ plan: state.plan })).toBe(false);
    expect(planReviewCorrectionProven({ selfReview: state.selfReview })).toBe(false);
  });

  it('rechecks the frozen gate at native dispatch, before sending an approval', async () => {
    const original = reviewed();
    const gate = planPreflightGate(original, SESSION);
    const reread = reviewed();
    reread.plan.current.recordDigest = 'c'.repeat(64);
    const runner = new Runner('/fixture', { model: 'test/fixture' }, '/fixture/config');
    runner.reviewInvocationAuthority = async () => validateReviewInvocation;
    runner.requireBoundState = () => ({ state: reread, sessionDir: '/unused' });
    const send = vi.fn();
    runner.hostCommand = send;
    await expect(
      runner.hostCommandTransport({ sessionId: SESSION }, 'approve', 'approve', {
        expectedPlanGate: gate,
        expectedTargetPhase: 'IMPLEMENTATION',
      }),
    ).rejects.toThrow('approve: plan preflight approval lost its verified plan gate');
    expect(send).not.toHaveBeenCalled();
  });
});
