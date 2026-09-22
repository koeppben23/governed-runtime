/**
 * @module integration/decision-receipt-durable-e2e.test
 * @description End-to-end regression for the durable human-decision receipt.
 *
 * The defect this pins: `/review-decision approve` at PLAN_REVIEW enters
 * VALIDATION, and the runtime runs the active checks automatically in the SAME
 * tool call. The persisted `state.transition` is then the validation exit, so
 * the former afterhook projection could no longer see the APPROVE transition
 * and emitted no decision receipt for the first human approval.
 *
 * This test drives the real tool chain — hydrate → ticket → plan → review
 * convergence → decision (with automatic validation) — and asserts exactly one
 * durable receipt with `fromPhase PLAN_REVIEW`, re-read through the canonical
 * receipt query.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  withStrictReviewFindings,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import { hydrate, ticket, plan, decision, status } from './tools/index.js';
import { readState, writeState } from '../adapters/persistence.js';
import type { PendingAuditOperation } from '../state/schema.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { decisionReceipts } from '../audit/query.js';
import { computeFingerprint } from '../adapters/workspace/index.js';
import { createSessionCompletionAuditDeps } from './services/regulated-completion.js';
import { reconcilePendingAuditOperations } from './plugin-audit.js';
import { TOOL_FLOWGUARD_DECISION } from './tool-names.js';
import { clearUserDecisionIntents, recordUserDecisionIntent } from './user-decision-intent.js';

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
    headCommitFull: vi.fn().mockResolvedValue('d'.repeat(40)),
  };
});

vi.mock('../adapters/frozen-repository.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/frozen-repository.js')>();
  return {
    ...original,
    freezeRepositoryIdentity: vi.fn(() => ({
      kind: 'local' as const,
      rootCommitDigest: 'sha256:' + 'b'.repeat(64),
    })),
    freezeWorktreeCandidate: vi.fn().mockResolvedValue('c'.repeat(40)),
  };
});

// The automatic validation run must not spawn real subprocesses.
vi.mock('../verification/executor', () => ({
  executeCheck: vi.fn().mockImplementation(async (input: { kind: string; command: string }) => ({
    kind: input.kind,
    command: input.command,
    exitCode: 0,
    passed: true,
    executionMs: 100,
    outputDigest: 'a'.repeat(64),
    stdout: 'OK',
    stderr: '',
    timedOut: false,
    startedAt: new Date().toISOString(),
  })),
}));

const INITIATOR_ACTOR = {
  id: 'alice-initiator',
  email: 'alice@example.com',
  displayName: 'Alice Initiator',
  source: 'env' as const,
  assurance: 'best_effort' as const,
};

const REVIEWER_ACTOR = {
  id: 'bob-reviewer',
  email: 'bob@example.com',
  displayName: 'Bob Reviewer',
  source: 'env' as const,
  assurance: 'best_effort' as const,
};

const actorOriginal = vi.hoisted(() => ({
  resolveActor: null as unknown as (typeof import('../adapters/actor.js'))['resolveActor'],
}));

vi.mock('../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/actor.js')>();
  actorOriginal.resolveActor = original.resolveActor;
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'alice-initiator',
      email: 'alice@example.com',
      displayName: 'Alice Initiator',
      source: 'env',
      assurance: 'best_effort',
    }),
  };
});

const actorMock = await import('../adapters/actor.js');

let ws: TestWorkspace;
let ctx: TestToolContext;

beforeEach(async () => {
  ws = await createTestWorkspace();
  try {
    await import('node:fs/promises').then((fs) =>
      fs.rm(path.join(ws.tmpDir, '.opencode', 'flowguard.json'), { force: true }),
    );
  } catch {
    /* ok */
  }
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
  });
});

afterEach(async () => {
  clearUserDecisionIntents();
  vi.clearAllMocks();
  await ws.cleanup();
});

async function resolveSessionDir(): Promise<string> {
  const { sessionDir } = await import('../adapters/workspace/index.js');
  const fp = await computeFingerprint(ws.tmpDir);
  return sessionDir(fp.fingerprint, ctx.sessionID);
}

async function advanceToPlanReview(): Promise<void> {
  await hydrate.execute({ policyMode: 'team' }, ctx);
  await ticket.execute({ text: 'Implement bounded feature', source: 'user' }, ctx);
  await plan.execute(
    { planText: '## Plan\n1. Implement feature', targetPaths: ['docs/test.md'] },
    ctx,
  );
  for (let i = 0; i < 5; i++) {
    const s = parseToolResult(await status.execute({}, ctx));
    if (s.phase === 'PLAN_REVIEW') break;
    const sessDir = await resolveSessionDir();
    await plan.execute(await withStrictReviewFindings(sessDir, { reviewVerdict: 'accept' }), ctx);
  }
  const s = parseToolResult(await status.execute({}, ctx));
  expect(s.phase).toBe('PLAN_REVIEW');
}

/** Seed one runnable validation check so approval triggers auto-validation. */
async function seedActiveCheck(sessDir: string): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.writeFile(path.join(ws.tmpDir, 'README.md'), '# fixture\n', 'utf-8');
  const state = await readState(sessDir);
  expect(state).not.toBeNull();
  await writeState(sessDir, {
    ...state!,
    activeChecks: ['test'],
    verificationCandidates: [
      {
        assertionCapability: 'unsupported' as const,
        candidateId: 'vc_test',
        kind: 'test',
        command: 'node -e "process.exit(0)"',
        source: 'test-fixture',
        confidence: 'high',
        reason: 'Fixture check for the durable decision receipt e2e',
      },
    ],
    executionSubjectInputsByCandidateId: {
      vc_test: [{ kind: 'file', path: 'README.md' }],
    },
  });
}

describe('durable decision receipt e2e', () => {
  it('persists exactly one PLAN_REVIEW receipt when approval auto-runs validation', async () => {
    await advanceToPlanReview();
    const sessDir = await resolveSessionDir();
    await seedActiveCheck(sessDir);

    // The session was initiated by Alice; the plan is approved by Bob.
    vi.mocked(actorMock.resolveActor).mockResolvedValue(REVIEWER_ACTOR);
    recordUserDecisionIntent({
      sessionId: ctx.sessionID,
      command: '/review-decision',
      expectedVerdict: 'approve',
    });
    const result = parseToolResult(
      await decision.execute({ verdict: 'approve', rationale: 'ok' }, ctx),
    );
    expect(result, JSON.stringify(result)).not.toMatchObject({ error: true });
    // The automatic checks ran in the same tool call and left VALIDATION.
    expect(result.phase).toBe('IMPLEMENTATION');

    const afterDecision = await readState(sessDir);
    expect(afterDecision).not.toBeNull();
    expect(afterDecision!.phase).toBe('IMPLEMENTATION');
    expect(afterDecision!.reviewDecision?.verdict).toBe('approve');
    // Session and reviewer identities are distinct in this scenario.
    expect(afterDecision!.actorInfo?.id).toBe(INITIATOR_ACTOR.id);
    expect(afterDecision!.reviewDecision?.decisionIdentity.actorId).toBe(REVIEWER_ACTOR.id);

    const decisionIntents = afterDecision!.pendingAuditOperations.filter(
      (operation): operation is Extract<PendingAuditOperation, { kind: 'semantic' }> =>
        operation.kind === 'semantic' && operation.semantic.event.startsWith('decision:'),
    );
    expect(decisionIntents).toHaveLength(1);
    expect(decisionIntents[0]!.semantic.event).toBe('decision:DEC-001');
    expect(decisionIntents[0]!.semantic.detail.fromPhase).toBe('PLAN_REVIEW');
    expect(decisionIntents[0]!.semantic.detail.verdict).toBe('approve');
    // `actor` is the frozen policy classification, not the deciding identity.
    expect(decisionIntents[0]!.semantic.actor).toBe('human');
    // The concrete identity is Bob's, never the session initiator's.
    expect(decisionIntents[0]!.semantic.actorInfo).toEqual(REVIEWER_ACTOR);
    expect(decisionIntents[0]!.semantic.detail).toMatchObject({
      decisionIdentity: { actorId: REVIEWER_ACTOR.id },
    });

    const { fingerprint } = await computeFingerprint(ws.tmpDir);
    const auditDeps = createSessionCompletionAuditDeps({
      sessDir,
      sessionID: ctx.sessionID,
      fingerprint,
      state: afterDecision!,
    });
    await reconcilePendingAuditOperations(auditDeps, ctx.sessionID, TOOL_FLOWGUARD_DECISION);

    const receipts = decisionReceipts(await readAuditTrail(sessDir));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.decisionId).toBe('DEC-001');
    expect(receipts[0]!.fromPhase).toBe('PLAN_REVIEW');
    expect(receipts[0]!.verdict).toBe('approve');

    const decisionEvents = (await readAuditTrail(sessDir)).filter(
      (event) => event.detail.kind === 'decision',
    );
    expect(decisionEvents).toHaveLength(1);
    expect(decisionEvents[0]!.actor).toBe('human');
    expect(decisionEvents[0]!.actorInfo).toEqual(REVIEWER_ACTOR);
    expect(decisionEvents[0]!.detail.decisionIdentity).toMatchObject({ actorId: 'bob-reviewer' });
  });
});
