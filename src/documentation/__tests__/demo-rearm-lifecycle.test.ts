/**
 * @module documentation/demo-rearm-lifecycle
 * @description Keeps the demo harness's structured re-arm lifecycle honest:
 * a re-arm that was fresh at dispatch and whose attempt failed later is
 * `rearm_attempt_failed`, never retroactively "spent/unknown".
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  Runner,
  classifyRearmEvent,
  settleRearmObservation,
} from '../../../demos/java-task-manager/run-live-matrix.mjs';

describe('structured re-arm recovery witness', () => {
  const event = {
    code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
    obligationId: 'ob-1',
    attemptId: 'att-2',
    index: 4,
  };
  function attempt(status: string, overrides: Record<string, unknown> = {}) {
    return {
      attemptId: 'att-2',
      obligationId: 'ob-1',
      status,
      origin: { kind: 'dispatch_rearm' },
      childSessionId: 'ses_child_2',
      ...overrides,
    };
  }
  function state(attemptStatus: string, overrides: Record<string, unknown> = {}) {
    return {
      reviewAssurance: {
        obligations: [{ obligationId: 'ob-1', status: 'pending' }],
        attempts: [
          attempt(attemptStatus, overrides),
          { attemptId: 'att-1', obligationId: 'ob-1', status: 'stale' },
        ],
      },
    };
  }

  it('authorizes a fresh created or bound re-arm attempt exactly once', () => {
    expect(classifyRearmEvent(event, state('created'), new Set())).toMatchObject({
      kind: 'authorized',
      attempt: { attemptId: 'att-2' },
    });
    expect(classifyRearmEvent(event, state('bound'), new Set())).toMatchObject({
      kind: 'authorized',
    });
  });

  it('keeps a re-arm authorized when its fresh attempt failed later', () => {
    expect(classifyRearmEvent(event, state('stale'), new Set())).toMatchObject({
      kind: 'authorized',
      attempt: { status: 'stale' },
    });
  });

  it('never credits an envelope without re-arm lineage or on a replay', () => {
    expect(
      classifyRearmEvent(event, state('stale', { origin: { kind: 'initial' } }), new Set()),
    ).toMatchObject({
      kind: 'stale',
      reason: 'not_rearm_origin',
    });
    expect(
      classifyRearmEvent(event, state('created', { obligationId: 'ob-other' }), new Set()),
    ).toMatchObject({ kind: 'stale', reason: 'attempt_unknown' });
    expect(
      classifyRearmEvent(event, { reviewAssurance: { obligations: [], attempts: [] } }, new Set()),
    ).toMatchObject({ kind: 'stale' });
    expect(classifyRearmEvent(event, null, new Set())).toMatchObject({ kind: 'stale' });
    const seen = new Set(['att-2']);
    expect(classifyRearmEvent(event, state('created'), seen)).toMatchObject({
      kind: 'stale',
      reason: 'rearm_already_observed',
    });
  });

  it('settles a bound re-arm as proven and a failed re-arm with child, denial, and capture state', () => {
    const base = {
      step: 'review-02',
      status: 'pending_verification',
      lifecycle: 'rearm_authorized',
      codes: [event.code],
      evidence: 'structured_rearm',
      obligationId: 'ob-1',
      attemptId: 'att-2',
      childSessionId: 'ses_child_2',
      events: [event],
    };
    const proven = structuredClone(base);
    settleRearmObservation(proven, state('bound'), {
      label: 'review-02',
      step: 'review-02',
      denials: [],
    });
    expect(proven).toMatchObject({
      status: 'proven',
      lifecycle: 'rearm_proven',
      provenBy: 'attempt_bound',
    });

    const failed = structuredClone(base);
    settleRearmObservation(failed, state('stale'), {
      label: 'review-02',
      step: 'review-02',
      denials: [
        { index: 3, code: 'REVIEW_EVIDENCE_NOT_OBSERVED' },
        { index: 9, code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE' },
      ],
    });
    expect(failed).toMatchObject({
      status: 'failed',
      lifecycle: 'rearm_attempt_failed',
      failureCode: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
      childSessionId: 'ses_child_2',
      captureStatus: 'attempt_stale',
      obligationStatus: 'pending',
    });

    const fallback = structuredClone(base);
    settleRearmObservation(
      fallback,
      {
        reviewAssurance: {
          obligations: [
            {
              obligationId: 'ob-1',
              status: 'blocked',
              blockedCode: 'REVIEWER_STEP_BUDGET_EXHAUSTED',
            },
          ],
          attempts: [attempt('stale')],
        },
      },
      { label: 'final', step: 'final', denials: [] },
    );
    expect(fallback).toMatchObject({
      status: 'failed',
      failureCode: 'REVIEWER_STEP_BUDGET_EXHAUSTED',
      obligationStatus: 'blocked',
    });
  });

  it('records a fresh re-arm as pending verification rather than recovered review', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-rearm-telemetry-'));
    try {
      await fs.mkdir(path.join(root, 'evidence'));
      const runner = new Runner(root, { model: 'test/model', flows: [] }, root);
      runner.requireBoundState = () => ({ state: state('created'), sessionDir: root });
      runner.hostStep = async () => ({
        code: 0,
        stderr: '',
        timedOut: false,
        durationMs: 0,
        sessionIds: ['ses_parent'],
        stdout: JSON.stringify({
          type: 'tool_use',
          part: {
            tool: 'task',
            state: {
              output: JSON.stringify({
                reviewDispatch: { required: true, completed: false },
                reviewRetry: { ...event, retryable: true },
              }),
            },
          },
        }),
      });
      const session: {
        workspace: string;
        recoveredDenials?: unknown[];
        recoveryObservations?: unknown[];
      } = { workspace: root };
      await runner.turn(session, 'plan-rearm', 'x');
      expect(session.recoveredDenials).toEqual([]);
      expect(session.recoveryObservations).toContainEqual({
        step: 'plan-rearm',
        status: 'pending_verification',
        lifecycle: 'rearm_authorized',
        codes: [event.code],
        evidence: 'structured_rearm',
        obligationId: 'ob-1',
        attemptId: 'att-2',
        childSessionId: 'ses_child_2',
        events: [{ ...event, index: 1, retryable: true }],
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
