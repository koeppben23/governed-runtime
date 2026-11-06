/**
 * @module integration/diagnostics/views.test
 * @description Read-only diagnostic views and their authority boundaries.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { initWorkspace } from '../../adapters/workspace/index.js';
import { writeState } from '../../adapters/persistence.js';
import { writeDiagnosticExport } from '../../adapters/diagnostics/export.js';
import {
  BINDING,
  FIXED_TIME,
  IMPL_REVIEW_CONVERGED,
  PLAN_RECORD,
  makeProgressedState,
  makeState,
} from '../../fixtures.js';
import type { PlanRecord, ReviewFindings } from '../../state/evidence.js';
import { computeRecordDigest } from '../../state/evidence-plan.js';
import { hashText } from '../../shared/hashing.js';
import { getLogDir } from '../../logging/file-sink.js';
import { createTestWorkspace, type TestWorkspace } from '../test-helpers.js';
import { buildExplorerView } from './explorer-view.js';
import { buildReviewView } from './review-view.js';
import { readLogView } from './log-view.js';
import { buildNotificationView } from './notification-view.js';
import {
  renderExplorerView,
  renderLogView,
  renderNotificationView,
  renderReviewView,
} from './render.js';

const ROOT_ID = 'ses_root';
const ROOT_STATE_ID = '00000000-0000-4000-8000-000000000101';
const CHILD_STATE_ID = '00000000-0000-4000-8000-000000000102';
const CHILD_ID = 'child-session-1';
const PLAN_DIGEST = PLAN_RECORD.current.digest;
const FIXED_NOW = () => new Date('2026-01-01T00:00:00.000Z');

let ws: TestWorkspace;

beforeEach(async () => {
  ws = await createTestWorkspace();
});
afterEach(async () => {
  await ws.cleanup();
});

function boundState(
  stateId: string,
  hostSessionId: string,
  fingerprint: string,
  phase: Parameters<typeof makeState>[0] = 'READY',
  overrides: Record<string, unknown> = {},
) {
  return makeState(phase, {
    id: stateId,
    flowguardSessionId: stateId,
    binding: { ...BINDING, hostSessionId, worktree: ws.tmpDir, fingerprint },
    ...overrides,
  });
}

function rootLinkedAssurance() {
  // Reuse the canonical fixture and only rebind the root parent, exactly like
  // the debug-export tests. No synthetic review evidence is created.
  const assurance = makeProgressedState('PLAN_REVIEW').reviewAssurance!;
  return {
    ...assurance,
    invocations: assurance.invocations.map((invocation) => ({
      ...invocation,
      parentSessionId: ROOT_ID,
    })),
  };
}

async function writeRoot(overrides: Record<string, unknown> = {}) {
  const { sessionDir, fingerprint, workspaceDir } = await initWorkspace(ws.tmpDir, ROOT_ID);
  await writeState(sessionDir, boundState(ROOT_STATE_ID, ROOT_ID, fingerprint, 'READY', overrides));
  return { sessionDir, fingerprint, workspaceDir };
}

async function writeProgressed(
  phase: NonNullable<Parameters<typeof makeState>[0]>,
  overrides: Record<string, unknown> = {},
) {
  const { sessionDir, fingerprint } = await initWorkspace(ws.tmpDir, ROOT_ID);
  const progressed = makeProgressedState(phase);
  await writeState(
    sessionDir,
    makeState(phase, {
      ...progressed,
      id: ROOT_STATE_ID,
      flowguardSessionId: ROOT_STATE_ID,
      binding: { ...BINDING, hostSessionId: ROOT_ID, worktree: ws.tmpDir, fingerprint },
      ...overrides,
    }),
  );
  return { sessionDir, fingerprint };
}

async function writeChild(fingerprint: string, phase: Parameters<typeof makeState>[0] = 'READY') {
  const { sessionDir } = await initWorkspace(ws.tmpDir, CHILD_ID);
  await writeState(sessionDir, boundState(CHILD_STATE_ID, CHILD_ID, fingerprint, phase));
  return sessionDir;
}

function findings(overrides: Partial<ReviewFindings> = {}): ReviewFindings {
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
    reviewedBy: { sessionId: CHILD_ID },
    reviewedAt: FIXED_TIME,
    attestation: {
      mandateDigest: 'mandate-digest-of-plan-review-criteria',
      criteriaVersion: 'criteria-v1',
      toolObligationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      iteration: 0,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
    },
    challenges: [],
    ...overrides,
  };
}

function planWithBody(body: string, version = 1): PlanRecord {
  const digest = hashText(body);
  const revisionId = randomUUID();
  const base = {
    body,
    digest,
    sections: ['Plan'],
    createdAt: FIXED_TIME,
    revisionId,
    planVersion: version,
    supersedesRecordDigest: null,
    originatingReviewObligationId: null,
    revisionReason: null,
    lineageStatus: 'verified' as const,
  };
  const current = {
    ...base,
    recordDigest: computeRecordDigest({
      contentDigest: digest,
      planVersion: version,
      supersedesRecordDigest: null,
      originatingReviewObligationId: null,
      revisionReason: null,
      revisionId,
    }),
  };
  return {
    current,
    history: [],
    reviewFindings: [],
    reviewCompletion: 'pending',
  };
}

describe('diagnostic explorer view', () => {
  it('HAPPY — projects exact lineage and review-assurance IDs', async () => {
    const { fingerprint } = await writeRoot({ reviewAssurance: rootLinkedAssurance() });
    await writeChild(fingerprint);

    const view = await buildExplorerView({ root: ws.tmpDir, sessionId: ROOT_ID, now: FIXED_NOW });

    expect(view.status).toBe('COMPLETE');
    expect(view.completeness).toEqual({ lineage: 'complete', canonicalState: 'complete' });
    expect(view.sessions.map((session) => session.sessionId)).toEqual([ROOT_ID, CHILD_ID]);
    expect(view.sessions[1]).toMatchObject({
      parentSessionId: ROOT_ID,
      lineage: 'verified',
      state: 'captured',
      binding: 'verified',
    });
    expect(view.reviewLinks?.obligations[0]).toMatchObject({
      obligationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      obligationType: 'plan',
      subjectDigest: PLAN_DIGEST,
    });
    expect(view.reviewLinks?.attempts[0]?.attemptId).toBe('ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(view.reviewLinks?.dispatches[0]?.dispatchId).toBe(
      '88888888-8888-4888-8888-888888888888',
    );
    expect(view.reviewLinks?.invocations[0]?.invocationId).toBe(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    );
    const markdown = renderExplorerView(view);
    expect(markdown).toContain('Session Explorer');
    expect(markdown).toContain(CHILD_ID);
    expect(markdown).toContain('not evidence');
  });

  it('BAD — keeps a foreign-parent child visible as not_verified without reading it', async () => {
    // The canonical fixture names a different parent, so lineage is ambiguous.
    await writeRoot({
      reviewAssurance: makeProgressedState('PLAN_REVIEW').reviewAssurance,
    });

    const view = await buildExplorerView({ root: ws.tmpDir, sessionId: ROOT_ID, now: FIXED_NOW });

    expect(view.status).toBe('PARTIAL');
    expect(view.completeness.lineage).toBe('partial');
    expect(view.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: CHILD_ID,
          lineage: 'not_verified',
          state: 'unavailable',
          binding: 'unknown',
          warningCodes: ['SESSION_LINEAGE_NOT_VERIFIED'],
        }),
      ]),
    );
    expect(view.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SESSION_LINEAGE_NOT_VERIFIED' })]),
    );
    expect(renderExplorerView(view)).toContain('no speculative parent or reviewer link');
  });

  it('CORNER — reports the session limit instead of silently dropping a child', async () => {
    const { fingerprint } = await writeRoot({ reviewAssurance: rootLinkedAssurance() });
    await writeChild(fingerprint);

    const view = await buildExplorerView({
      root: ws.tmpDir,
      sessionId: ROOT_ID,
      maxSessions: 1,
      now: FIXED_NOW,
    });

    expect(view.status).toBe('PARTIAL');
    expect(view.sessions).toHaveLength(1);
    expect(view.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SESSION_LIMIT_TRUNCATED' })]),
    );
  });

  it('EDGE — reports NOT_VERIFIED when the root has no canonical state', async () => {
    const view = await buildExplorerView({
      root: ws.tmpDir,
      sessionId: 'ses_missing',
      now: FIXED_NOW,
    });

    expect(view.status).toBe('NOT_VERIFIED');
    expect(view.completeness).toEqual({
      lineage: 'not_verified',
      canonicalState: 'not_verified',
    });
    expect(view.sessions[0]).toMatchObject({ state: 'absent', lineage: 'verified' });
    expect(view.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SESSION_STATE_ABSENT' })]),
    );
  });
});

describe('diagnostic review view', () => {
  it('HAPPY — shows the exact subject digest, reviewer verdict and read-only boundary', async () => {
    const plan: PlanRecord = { ...PLAN_RECORD, reviewFindings: [findings()] };
    await writeRoot({ plan, reviewAssurance: rootLinkedAssurance() });

    const view = await buildReviewView({ root: ws.tmpDir, sessionId: ROOT_ID, now: FIXED_NOW });

    expect(view.status).toBe('COMPLETE');
    expect(view.subject).toMatchObject({
      kind: 'plan',
      revision: 'v1',
      digest: PLAN_DIGEST,
      reviewerVerdict: 'accept',
      subjectBinding: 'matched',
      contentVerified: 'verified',
    });
    expect(view.decisionAuthority).toBe('not_granted');
    expect(view.proof).not.toBeNull();
    const markdown = renderReviewView(view);
    expect(markdown).toContain(PLAN_DIGEST);
    expect(markdown).toContain('Reviewer');
    expect(markdown).toContain('Decision authority:** NOT GRANTED');
    expect(markdown).toContain('not evidence');
  });

  it('BAD — reports stale findings against the displayed plan revision', async () => {
    const plan: PlanRecord = {
      ...PLAN_RECORD,
      reviewFindings: [findings({ planVersion: 2 })],
    };
    await writeRoot({ plan, reviewAssurance: rootLinkedAssurance() });

    const view = await buildReviewView({ root: ws.tmpDir, sessionId: ROOT_ID, now: FIXED_NOW });

    expect(view.status).toBe('PARTIAL');
    expect(view.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'REVIEW_FINDINGS_STALE' }),
        expect.objectContaining({ code: 'REVIEW_FINDINGS_UNBOUND' }),
      ]),
    );
    expect(view.subject.reviewerVerdict).toBeNull();
    expect(view.subject.findingsVersion).toBeNull();
    expect(view.subject.unboundReview).toMatchObject({
      verdict: 'accept',
      findingsVersion: 'plan v2',
      reason: 'stale_revision',
    });
    expect(renderReviewView(view)).toContain('Historical / unassigned reviewer output');
  });

  it('BAD — does not apply stale architecture findings to the displayed ADR', async () => {
    const state = makeProgressedState('ARCH_REVIEW');
    await writeProgressed('ARCH_REVIEW', {
      architecture: {
        ...state.architecture!,
        digest: 'different-adr-digest',
        reviewFindings: [findings()],
      },
    });

    const view = await buildReviewView({ root: ws.tmpDir, sessionId: ROOT_ID, now: FIXED_NOW });

    expect(view.subject.kind).toBe('architecture');
    expect(view.subject.reviewerVerdict).toBeNull();
    expect(view.subject.unboundReview).toMatchObject({
      verdict: 'accept',
      reason: 'subject_mismatch',
    });
    expect(view.warnings.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['REVIEW_FINDINGS_UNBOUND', 'REVIEW_SUBJECT_MISMATCH']),
    );
  });

  it('BAD — does not apply unbound implementation findings to the displayed implementation', async () => {
    await writeProgressed('IMPL_REVIEW', { implReviewFindings: [findings()] });

    const view = await buildReviewView({ root: ws.tmpDir, sessionId: ROOT_ID, now: FIXED_NOW });

    expect(view.subject.kind).toBe('implementation');
    expect(view.subject.reviewerVerdict).toBeNull();
    expect(view.subject.unboundReview).toMatchObject({
      verdict: 'accept',
      reason: 'subject_not_verified',
    });
    expect(view.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'REVIEW_FINDINGS_UNBOUND' })]),
    );
  });

  it('BAD — does not present a stale implementation-review loop as current', async () => {
    await writeProgressed('IMPL_REVIEW', {
      implReview: { ...IMPL_REVIEW_CONVERGED, currDigest: 'stale-impl-digest' },
    });

    const view = await buildReviewView({ root: ws.tmpDir, sessionId: ROOT_ID, now: FIXED_NOW });

    expect(view.subject.kind).toBe('implementation');
    expect(view.subject.reviewerVerdict).toBeNull();
    expect(view.subject.reviewCompletion).toBeNull();
    expect(view.subject.historicalImplReview).toMatchObject({
      verdict: 'accept',
      currDigest: 'stale-impl-digest',
      expectedDigest: 'digest-of-impl',
      reason: 'digest_mismatch',
    });
    expect(view.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'REVIEW_IMPL_LOOP_STALE' })]),
    );
    expect(renderReviewView(view)).toContain('Historical implementation-review loop');
  });

  it('BAD — reports a subject mismatch instead of implying approval', async () => {
    const plan = planWithBody('## Plan\nA different current revision');
    await writeRoot({ plan, reviewAssurance: rootLinkedAssurance() });

    const view = await buildReviewView({ root: ws.tmpDir, sessionId: ROOT_ID, now: FIXED_NOW });

    expect(view.status).toBe('PARTIAL');
    expect(view.subject.subjectBinding).toBe('mismatch');
    expect(view.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'REVIEW_SUBJECT_MISMATCH' })]),
    );
    expect(renderReviewView(view)).toContain('mismatch');
  });

  it('CORNER — shows declarations without inventing an evaluation', async () => {
    const claimId = randomUUID();
    const declaration = {
      claimId,
      statement: 'The diagnostic view is read-only.',
      critical: true,
      authoritySectionId: 'plan',
      claimScope: 'specific_behavior' as const,
      expectedCheckId: 'test',
    };
    const plan: PlanRecord = {
      ...PLAN_RECORD,
      claimDeclarations: { flow: 'plan', version: 'v2', claims: [declaration] },
    };
    await writeRoot({
      plan,
      proofContract: {
        version: 'contract.v2',
        claims: [
          {
            claimId,
            statement: declaration.statement,
            signalClass: 'fact',
            critical: true,
            claimScope: 'specific_behavior',
            provenance: null,
            evidenceRefs: [],
            counterexampleRefs: [],
          },
        ],
      },
    });

    const view = await buildReviewView({ root: ws.tmpDir, sessionId: ROOT_ID, now: FIXED_NOW });

    expect(view.proof?.claims).toHaveLength(1);
    expect(view.proof?.claims[0]).toMatchObject({
      claimId,
      verificationState: null,
      evidenceRefCount: 0,
      counterexampleRefCount: 0,
    });
    expect(view.proof?.certificates).toHaveLength(0);
    const markdown = renderReviewView(view);
    expect(markdown).toContain('Declarations versus evaluation');
    expect(markdown).toContain('not evaluated');
  });

  it('BAD — reports missing reviewer evidence instead of implying a review', async () => {
    await writeRoot({ plan: PLAN_RECORD });

    const view = await buildReviewView({ root: ws.tmpDir, sessionId: ROOT_ID, now: FIXED_NOW });

    expect(view.status).toBe('PARTIAL');
    expect(view.subject.reviewerVerdict).toBeNull();
    expect(view.warnings.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['REVIEW_VERDICT_NOT_RECORDED', 'REVIEW_OBLIGATION_NOT_VERIFIED']),
    );
  });

  it('CORNER — displays and verifies an exact implementation diff artifact', async () => {
    const diff = 'diff --git a/src/a.ts b/src/a.ts\n+export const a = 1;\n';
    const diffDigest = hashText(diff);
    const state = makeProgressedState('EVIDENCE_REVIEW');
    const { sessionDir, fingerprint } = await initWorkspace(ws.tmpDir, ROOT_ID);
    await writeState(
      sessionDir,
      makeState('EVIDENCE_REVIEW', {
        ...state,
        id: ROOT_STATE_ID,
        flowguardSessionId: ROOT_STATE_ID,
        binding: { ...BINDING, hostSessionId: ROOT_ID, worktree: ws.tmpDir, fingerprint },
        implementation: { ...state.implementation!, diffDigest },
      }),
    );
    await writeFile(path.join(sessionDir, `implementation-diff.${diffDigest}.patch`), diff);

    const view = await buildReviewView({ root: ws.tmpDir, sessionId: ROOT_ID, now: FIXED_NOW });

    expect(view.subject.kind).toBe('implementation');
    expect(view.subject.content).toContain('+export const a = 1;');
    expect(view.subject.contentVerified).toBe('verified');
    expect(view.subject.paths).toEqual([...state.implementation!.changedFiles]);
  });

  it('EDGE — reports NOT_VERIFIED when canonical state is unavailable', async () => {
    const view = await buildReviewView({
      root: ws.tmpDir,
      sessionId: 'ses_missing',
      now: FIXED_NOW,
    });

    expect(view.status).toBe('NOT_VERIFIED');
    expect(view.subject.kind).toBe('unavailable');
    expect(view.subject.digest).toBeNull();
    expect(view.decisionAuthority).toBe('not_granted');
    expect(renderReviewView(view)).toContain('No reviewable subject recorded');
  });
});

describe('diagnostic log view', () => {
  async function logDir(): Promise<string> {
    const { workspaceDir } = await initWorkspace(ws.tmpDir, ROOT_ID);
    const dir = getLogDir(workspaceDir);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  function line(entry: Record<string, unknown>): string {
    return `${JSON.stringify(entry)}\n`;
  }

  it('HAPPY — reads the bounded tail, filters and redacts existing JSONL', async () => {
    const dir = await logDir();
    await writeFile(
      path.join(dir, 'flowguard-2026-01-01.log'),
      line({
        ts: '2026-01-01T00:00:00.000Z',
        level: 'info',
        service: 'plugin',
        message: 'started',
        sessionId: 's1',
        traceId: 't1',
      }) +
        line({
          ts: '2026-01-01T00:00:01.000Z',
          level: 'warn',
          service: 'plugin',
          message: 'token=secret at /home/user/private/file.ts',
          sessionId: 's1',
          traceId: 't1',
          fields: { password: 'super-secret' },
        }),
    );
    await writeFile(
      path.join(dir, 'flowguard-2026-01-02.log'),
      line({
        ts: '2026-01-02T00:00:00.000Z',
        level: 'error',
        service: 'policy',
        message: 'failed',
        sessionId: 's2',
        traceId: 't2',
      }),
    );

    const view = await readLogView({
      directory: dir,
      filter: { levels: ['warn', 'error'], sessionId: 's1' },
      now: FIXED_NOW,
    });

    expect(view.status).toBe('COMPLETE');
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]).toMatchObject({ level: 'warn', sessionId: 's1', traceId: 't1' });
    expect(view.entries[0]?.message).not.toContain('token=secret');
    expect(view.entries[0]?.message).not.toContain('/home/user/private');
    expect(JSON.stringify(view.entries[0]?.fields)).not.toContain('super-secret');
    expect(view.correlation.withSessionId).toBe(3);
    expect(view.correlation.withTraceId).toBe(3);
    expect(view.files).toHaveLength(2);
  });

  it('BAD — reports missing correlation under an active filter', async () => {
    const dir = await logDir();
    await writeFile(
      path.join(dir, 'flowguard-2026-01-01.log'),
      line({ ts: '2026-01-01T00:00:00.000Z', level: 'error', service: 'x', message: 'no ids' }),
    );

    const view = await readLogView({ directory: dir, filter: { sessionId: 's1' } });

    expect(view.entries).toHaveLength(0);
    expect(view.correlation.missingFilteredSessionId).toBe(1);
    expect(view.correlation.withoutSessionId).toBe(1);
  });

  it('BAD — reports PARTIAL when some JSONL lines are malformed', async () => {
    const dir = await logDir();
    await writeFile(
      path.join(dir, 'flowguard-2026-01-01.log'),
      line({ ts: '2026-01-01T00:00:00.000Z', level: 'info', service: 'x', message: 'valid' }) +
        '{ not valid json\n',
    );

    const view = await readLogView({ directory: dir });

    expect(view.parseErrors).toBe(1);
    expect(view.entries).toHaveLength(1);
    expect(view.status).toBe('PARTIAL');
    expect(renderLogView(view)).toContain('Malformed JSONL entries: 1');
  });

  it('CORNER — makes byte truncation explicit', async () => {
    const dir = await logDir();
    await writeFile(
      path.join(dir, 'flowguard-2026-01-01.log'),
      line({
        ts: '2026-01-01T00:00:00.000Z',
        level: 'info',
        service: 'x',
        message: 'x'.repeat(500),
      }),
    );

    const view = await readLogView({ directory: dir, maxBytes: 120, maxLines: 2 });

    expect(view.status).toBe('PARTIAL');
    expect(view.truncated).toBe(true);
    expect(view.truncationReasons.length).toBeGreaterThan(0);
    expect(renderLogView(view)).toContain('Truncation is active');
  });

  it('EDGE — reports NOT_VERIFIED for a missing log directory', async () => {
    const view = await readLogView({ directory: path.join(ws.tmpDir, 'missing-logs') });

    expect(view.status).toBe('NOT_VERIFIED');
    expect(view.directory).toContain('missing-logs');
    expect(view.truncationReasons).toEqual(['log directory is missing or unreadable']);
  });
});

describe('notification capability', () => {
  it('reports unsupported delivery and keeps the file-log fallback', () => {
    const view = buildNotificationView({ logDirectory: '/tmp/logs', now: FIXED_NOW });
    const markdown = renderNotificationView(view);

    expect(view.status).toBe('NOT_VERIFIED');
    expect(view.delivery).toBe('unsupported');
    expect(view.fallback.directory).toBe('/tmp/logs');
    expect(markdown).toContain('No toast, panel, notification or governance action was attempted.');
  });
});

describe('cross-surface consistency', () => {
  it('shows the same session lineage and plan digest as the debug export', async () => {
    const plan: PlanRecord = { ...PLAN_RECORD, reviewFindings: [findings()] };
    const { fingerprint } = await writeRoot({ plan, reviewAssurance: rootLinkedAssurance() });
    await writeChild(fingerprint);
    const outputDir = path.join(ws.tmpDir, 'diagnostic-export');
    const exported = await writeDiagnosticExport({
      root: ws.tmpDir,
      sessionId: ROOT_ID,
      outputDir,
      redactionMode: 'basic',
      includeHost: false,
      now: FIXED_NOW,
    });
    const graph = JSON.parse(await readFile(path.join(outputDir, 'session-graph.json'), 'utf8'));
    const explorer = await buildExplorerView({
      root: ws.tmpDir,
      sessionId: ROOT_ID,
      now: FIXED_NOW,
    });
    const review = await buildReviewView({ root: ws.tmpDir, sessionId: ROOT_ID, now: FIXED_NOW });

    expect(explorer.sessions.map((session) => session.sessionId)).toEqual(
      graph.sessions.map((session: { sessionId: string }) => session.sessionId),
    );
    expect(explorer.sessions.map((session) => session.lineage)).toEqual(
      graph.sessions.map((session: { lineage: string }) => session.lineage),
    );
    expect(exported.manifest.counts.sessions).toBe(2);
    expect(review.subject.digest).toBe(PLAN_DIGEST);
    expect(renderReviewView(review)).toContain(PLAN_DIGEST);
  });
});
