/**
 * @module integration/plugin-regulated-recovery.test
 * @description Integration tests for the before-hook regulated completion
 * recovery: resuming an interrupted completion over REAL persistence and audit
 * adapters, without holding the non-reentrant session lock across the chain.
 *
 * @test-policy HAPPY, BAD
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../state/schema.js';
import {
  makeState,
  REGULATED_POLICY_SNAPSHOT,
  REVIEW_APPROVE,
  TICKET,
  PLAN_RECORD,
  SELF_REVIEW_CONVERGED,
  VALIDATION_PASSED,
  IMPL_EVIDENCE,
  IMPL_REVIEW_CONVERGED,
} from '../fixtures.js';
import { initWorkspace } from '../adapters/workspace/index.js';
import { readState, writeState } from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { createTestWorkspace, withTestEnv, type TestWorkspace } from './test-helpers.js';
import { reconcilePendingAuditOperations } from './plugin-audit.js';
import { writeStateWithArtifactsAndAuditOperations } from './tools/helpers.js';
import { createSessionCompletionAuditDeps } from './services/regulated-completion.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { recoverRegulatedCompletion } from './plugin-regulated-recovery.js';

const archiveMock = vi.hoisted(() => ({
  archiveRegulatedEvidence: vi.fn(),
}));
const verificationMock = vi.hoisted(() => ({
  verifyRegulatedArchive: vi.fn().mockResolvedValue({
    passed: true,
    findings: [],
    manifest: null,
    verifiedAt: '2026-01-01T00:00:00.000Z',
  }),
}));

vi.mock('../adapters/workspace/archive.js', () => archiveMock);
vi.mock('../adapters/workspace/archive-verify-chain.js', () => verificationMock);

import { archiveRegulatedEvidence } from '../adapters/workspace/archive.js';
import { verifyRegulatedArchive } from '../adapters/workspace/archive-verify-chain.js';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const AT = '2026-01-01T00:00:00.000Z';

let ws: TestWorkspace;
let cleanupEnv: () => void;

beforeEach(async () => {
  cleanupEnv = withTestEnv({ FLOWGUARD_POLICY_PATH: undefined });
  ws = await createTestWorkspace();
  archiveMock.archiveRegulatedEvidence.mockResolvedValue('/regulated-archive.tar.gz');
});

afterEach(async () => {
  vi.clearAllMocks();
  cleanupEnv();
  await ws.cleanup();
});

function reviewState(phase: 'EVIDENCE_REVIEW' | 'COMPLETE') {
  return makeState(phase, {
    ticket: TICKET,
    plan: PLAN_RECORD,
    selfReview: SELF_REVIEW_CONVERGED,
    reviewDecision: REVIEW_APPROVE,
    validation: VALIDATION_PASSED,
    implementation: IMPL_EVIDENCE,
    implReview: IMPL_REVIEW_CONVERGED,
    policySnapshot: REGULATED_POLICY_SNAPSHOT,
    // Only the terminal COMPLETE state carries the completion transition —
    // the persisted EVIDENCE_REVIEW checkpoint predates it, exactly as in the
    // real rail entry path.
    ...(phase === 'COMPLETE'
      ? {
          transition: {
            from: 'EVIDENCE_REVIEW',
            to: 'COMPLETE',
            event: 'APPROVE',
            at: AT,
          },
        }
      : {}),
  });
}

function terminalDecisionIntent() {
  return {
    phase: 'EVIDENCE_REVIEW' as const,
    event: 'decision:DEC-001',
    occurredAt: AT,
    detail: {
      kind: 'decision',
      decisionId: 'DEC-001',
      decisionSequence: 1,
      gatePhase: 'EVIDENCE_REVIEW',
      verdict: REVIEW_APPROVE.verdict,
      rationale: REVIEW_APPROVE.rationale,
      decidedBy: REVIEW_APPROVE.decidedBy,
      decidedAt: REVIEW_APPROVE.decidedAt,
      fromPhase: 'EVIDENCE_REVIEW',
      toPhase: 'COMPLETE',
      transitionEvent: 'APPROVE',
      policyMode: 'regulated',
    },
  };
}

function terminalLifecycleIntent() {
  return {
    phase: 'COMPLETE' as const,
    event: 'lifecycle:session_completed',
    occurredAt: new Date().toISOString(),
    detail: { kind: 'lifecycle', action: 'session_completed', finalPhase: 'COMPLETE' },
  };
}

async function seedSession(state: SessionState): Promise<{ fingerprint: string; sessDir: string }> {
  const initialized = await initWorkspace(ws.tmpDir, SESSION_ID);
  await writeState(initialized.sessionDir, state);
  return { fingerprint: initialized.fingerprint, sessDir: initialized.sessionDir };
}

function recoveryRuntime(sessDir: string, fingerprint: string, state: SessionState) {
  return {
    ws: {
      getSessionDir: (candidate: string) => (candidate === SESSION_ID ? sessDir : null),
    },
    log: { warn: vi.fn() },
    auditDeps: createSessionCompletionAuditDeps({
      sessDir,
      sessionID: SESSION_ID,
      fingerprint,
      state,
    }),
  } as unknown as FlowGuardPluginRuntime;
}

async function auditEvents(sessDir: string) {
  return (await readAuditTrail(sessDir)).events;
}

describe('recoverRegulatedCompletion', () => {
  it('drains a terminal outbox checkpoint after a crash and archives exactly-once', async () => {
    // Crash window: the terminal transition + decision semantic operation are
    // committed to the durable outbox, but reconciliation never ran.
    const { fingerprint, sessDir } = await seedSession(reviewState('EVIDENCE_REVIEW'));
    await writeStateWithArtifactsAndAuditOperations(sessDir, reviewState('COMPLETE'), undefined, [
      terminalDecisionIntent(),
    ]);

    await recoverRegulatedCompletion(
      recoveryRuntime(sessDir, fingerprint, (await readState(sessDir))!),
      SESSION_ID,
    );

    const finalState = await readState(sessDir);
    expect(finalState?.archiveStatus).toBe('verified');
    expect(finalState?.regulatedArchiveStatus).toBe('verified');
    const events = await auditEvents(sessDir);
    expect(events.filter((event) => event.detail.kind === 'decision')).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.detail.kind === 'transition' &&
          event.detail.from === 'EVIDENCE_REVIEW' &&
          event.detail.to === 'COMPLETE',
      ),
    ).toHaveLength(1);
    expect(events.filter((event) => event.event === 'lifecycle:session_completed')).toHaveLength(1);
    expect(archiveRegulatedEvidence).toHaveBeenCalledTimes(1);
  });

  it('retries after a lifecycle outbox crash without duplicating terminal evidence', async () => {
    const { fingerprint, sessDir } = await seedSession(reviewState('EVIDENCE_REVIEW'));
    await writeStateWithArtifactsAndAuditOperations(sessDir, reviewState('COMPLETE'), undefined, [
      terminalDecisionIntent(),
    ]);
    const deps = createSessionCompletionAuditDeps({
      sessDir,
      sessionID: SESSION_ID,
      fingerprint,
      state: (await readState(sessDir))!,
    });
    await reconcilePendingAuditOperations(deps, SESSION_ID, 'flowguard_decision');
    const pending = await readState(sessDir);
    await writeStateWithArtifactsAndAuditOperations(
      sessDir,
      { ...pending!, archiveStatus: 'pending', regulatedArchiveStatus: 'pending' },
      undefined,
      [terminalLifecycleIntent()],
    );

    await recoverRegulatedCompletion(
      recoveryRuntime(sessDir, fingerprint, (await readState(sessDir))!),
      SESSION_ID,
    );

    const finalState = await readState(sessDir);
    expect(finalState?.archiveStatus).toBe('verified');
    const events = await auditEvents(sessDir);
    expect(events.filter((event) => event.detail.kind === 'decision')).toHaveLength(1);
    expect(events.filter((event) => event.event === 'lifecycle:session_completed')).toHaveLength(1);
    expect(archiveRegulatedEvidence).toHaveBeenCalledTimes(1);
  });

  it('does not resume an already verified session', async () => {
    const { fingerprint, sessDir } = await seedSession(reviewState('COMPLETE'));
    const verified = {
      ...(await readState(sessDir))!,
      archiveStatus: 'verified' as const,
      regulatedArchiveStatus: 'verified' as const,
    };
    await writeState(sessDir, verified);

    await recoverRegulatedCompletion(recoveryRuntime(sessDir, fingerprint, verified), SESSION_ID);

    expect(archiveRegulatedEvidence).not.toHaveBeenCalled();
  });

  it('skips recovery for a non-terminal session', async () => {
    const { fingerprint, sessDir } = await seedSession(reviewState('EVIDENCE_REVIEW'));
    const state = await readState(sessDir);

    await recoverRegulatedCompletion(recoveryRuntime(sessDir, fingerprint, state!), SESSION_ID);

    expect(archiveRegulatedEvidence).not.toHaveBeenCalled();
  });

  it.each(['ARCH_COMPLETE', 'REVIEW_COMPLETE'] as const)(
    'leaves a regulated %s session byte-semantically unchanged',
    async (phase) => {
      const { fingerprint, sessDir } = await seedSession(
        makeState(phase, {
          policySnapshot: REGULATED_POLICY_SNAPSHOT,
          reviewDecision: REVIEW_APPROVE,
          transition: { from: 'ARCH_REVIEW', to: phase, event: 'APPROVE', at: AT },
        }),
      );
      const before = JSON.stringify(await readState(sessDir));

      await recoverRegulatedCompletion(
        recoveryRuntime(sessDir, fingerprint, (await readState(sessDir))!),
        SESSION_ID,
      );

      expect(archiveRegulatedEvidence).not.toHaveBeenCalled();
      expect(JSON.stringify(await readState(sessDir))).toBe(before);
      expect((await auditEvents(sessDir)).length).toBe(0);
    },
  );

  it('concurrent recovery commits exactly one terminal decision and lifecycle', async () => {
    const { fingerprint, sessDir } = await seedSession(reviewState('EVIDENCE_REVIEW'));
    await writeStateWithArtifactsAndAuditOperations(sessDir, reviewState('COMPLETE'), undefined, [
      terminalDecisionIntent(),
    ]);

    await Promise.all([
      recoverRegulatedCompletion(
        recoveryRuntime(sessDir, fingerprint, (await readState(sessDir))!),
        SESSION_ID,
      ),
      recoverRegulatedCompletion(
        recoveryRuntime(sessDir, fingerprint, (await readState(sessDir))!),
        SESSION_ID,
      ),
    ]);

    const events = await auditEvents(sessDir);
    expect(events.filter((event) => event.detail.kind === 'decision')).toHaveLength(1);
    expect(events.filter((event) => event.event === 'lifecycle:session_completed')).toHaveLength(1);
    expect(archiveRegulatedEvidence).toHaveBeenCalledTimes(1);
    expect(verifyRegulatedArchive).toHaveBeenCalledTimes(1);
    expect((await readState(sessDir))?.archiveStatus).toBe('verified');
  });

  it('a late concurrent recovery never re-publishes archive bytes that were already verified', async () => {
    const { fingerprint, sessDir } = await seedSession(reviewState('EVIDENCE_REVIEW'));
    await writeStateWithArtifactsAndAuditOperations(sessDir, reviewState('COMPLETE'), undefined, [
      terminalDecisionIntent(),
    ]);
    const state = await readState(sessDir);

    // Barrier-controlled interleaving: recovery A blocks inside the archive
    // step; recovery B enters while A still holds the completion lock.
    let releaseArchive!: () => void;
    archiveMock.archiveRegulatedEvidence.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseArchive = () => resolve('/a.tar.gz');
        }),
    );
    const runtime = () => recoveryRuntime(sessDir, fingerprint, state!);

    const first = recoverRegulatedCompletion(runtime(), SESSION_ID);
    while (archiveMock.archiveRegulatedEvidence.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const second = recoverRegulatedCompletion(runtime(), SESSION_ID);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseArchive();
    await Promise.all([first, second]);

    expect(archiveRegulatedEvidence).toHaveBeenCalledTimes(1);
    expect(verifyRegulatedArchive).toHaveBeenCalledTimes(1);
    const finalState = await readState(sessDir);
    expect(finalState?.archiveStatus).toBe('verified');
    expect(finalState?.pendingAuditOperations.every((op) => op.status === 'reconciled')).toBe(true);
  });
});
