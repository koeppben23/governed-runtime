/**
 * @module integration/orchestration-dead-state-recovery.test
 * @description Tests for the dead-state recovery mechanism (Fix 2a/2b/2c).
 *
 * Validates:
 * - Plan tool: re-submission allowed when last obligation is blocked
 * - Plan tool: max-cap blocks after 3 consecutive blocked obligations
 * - Plan tool: normal PLAN_REVIEW_IN_PROGRESS still blocks when obligation is not blocked
 * - Implement tool: re-recording allowed when in IMPL_REVIEW with blocked obligation
 * - Implement tool: max-cap blocks after 3 consecutive blocked implement obligations
 * - Architecture tool: re-submission allowed when last obligation is blocked
 * - Architecture tool: max-cap blocks after 3 consecutive blocked obligations
 *
 * These tests directly exercise tool execute() with persisted state containing
 * blocked review obligations, simulating the dead-state scenario after
 * STRICT_REVIEW_ORCHESTRATION_FAILED.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all categories present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import { plan, implement, architecture } from './tools/index.js';
import { readState, writeState } from '../adapters/persistence.js';
import { hashText } from '../shared/hashing.js';
import {
  appendObligationWithAttempt,
  artifactReviewSubjectScope,
  createReviewObligation,
  freezeReviewMaterial,
} from './review/assurance.js';
import type { SessionState } from '../state/schema.js';
import type { ReviewAttempt, ReviewObligation } from '../state/evidence.js';

// ─── Git Mock ────────────────────────────────────────────────────────────────

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

vi.mock('../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/actor.js')>();
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'best_effort' as const,
    }),
  };
});

// ─── Test Setup ──────────────────────────────────────────────────────────────

let ws: TestWorkspace;
let ctx: TestToolContext;

beforeEach(async () => {
  ws = await createTestWorkspace();
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  await ws.cleanup();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function currentSessionDir(): Promise<string> {
  const { computeFingerprint, sessionDir: resolveSessionDir } =
    await import('../adapters/workspace/index.js');
  const fp = await computeFingerprint(ws.tmpDir);
  return resolveSessionDir(fp.fingerprint, ctx.sessionID);
}

/** Create a blocked review obligation for testing. */
function makeBlockedObligation(
  obligationType: 'plan' | 'implement' | 'architecture',
  iteration = 0,
  planVersion = 1,
): ReviewObligation {
  return {
    obligationId: crypto.randomUUID(),
    obligationType,
    subjectDigest: 'test-subject-digest-blocked',
    iteration,
    planVersion,
    criteriaVersion: 'p37-v1',
    mandateDigest: 'test-mandate-digest-blocked',
    maxReviewerOutputRepairAttempts: 1,
    status: 'blocked',
    blockedCode: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
    createdAt: new Date().toISOString(),
    pluginHandshakeAt: new Date().toISOString(),
    invocationId: null,
    fulfilledAt: null,
    consumedAt: null,
    reviewSubjectScope: { kind: 'unavailable', reason: 'blocked obligation fixture' },
  };
}

/** Create a pending (active) review obligation. */
function makePendingObligation(
  obligationType: 'plan' | 'implement' | 'architecture',
  iteration = 0,
  planVersion = 1,
): ReviewObligation {
  return {
    obligationId: crypto.randomUUID(),
    obligationType,
    subjectDigest: 'test-subject-digest-pending',
    iteration,
    planVersion,
    criteriaVersion: 'p37-v1',
    mandateDigest: 'test-mandate-digest-pending',
    maxReviewerOutputRepairAttempts: 1,
    status: 'pending',
    blockedCode: null,
    createdAt: new Date().toISOString(),
    pluginHandshakeAt: null,
    invocationId: null,
    fulfilledAt: null,
    consumedAt: null,
    reviewSubjectScope: {
      kind: 'repository_change',
      paths: ['src/foo.ts'],
      revisions: ['base', 'head'],
    },
  };
}

/** Hydrate a session and advance to PLAN phase with blocked obligation. */
async function setupPlanDeadState(blockedCount = 1): Promise<void> {
  const { hydrate, ticket: ticketTool } = await import('./tools/index.js');
  await hydrate.execute({ policyMode: 'solo' }, ctx);
  await ticketTool.execute({ text: 'Test task', source: 'user' }, ctx);

  // Submit initial plan to advance to PLAN phase with selfReview
  await plan.execute(
    {
      planText:
        '## Objective\nTest\n## Approach\nTest\n## Steps\n1. test\n## Files to Modify\ntest.ts\n## Edge Cases\n1. none\n## Validation Criteria\n1. pass\n## Verification Plan\n1. test',
      targetPaths: ['docs/test.md'],
    },
    ctx,
  );

  // Now manually corrupt the state to simulate blocked obligation(s)
  const sessDir = await currentSessionDir();
  const state = await readState(sessDir);
  if (!state) throw new Error('No state');

  const blockedObligations = Array.from({ length: blockedCount }, (_, i) =>
    makeBlockedObligation('plan', 0, i + 1),
  );

  const updatedState: SessionState = {
    ...state,
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v5' as const,
      obligations: blockedObligations,
      invocations: state.reviewAssurance?.invocations ?? [],
      attempts: [],
    },
  };

  await writeState(sessDir, updatedState);
}

/** Hydrate and advance to IMPL_REVIEW phase with blocked obligation. */
async function setupImplementDeadState(blockedCount = 1): Promise<void> {
  const { hydrate, ticket: ticketTool } = await import('./tools/index.js');
  await hydrate.execute({ policyMode: 'solo' }, ctx);
  await ticketTool.execute({ text: 'Test task', source: 'user' }, ctx);

  // Submit a plan through normal flow so plan artifacts are materialized on disk
  await plan.execute(
    {
      planText:
        '## Objective\nTest\n## Approach\nTest\n## Steps\n1. test\n## Files to Modify\ntest.ts\n## Edge Cases\n1. none\n## Validation Criteria\n1. pass\n## Verification Plan\n1. test',
      targetPaths: ['docs/test.md'],
    },
    ctx,
  );

  // Now manually advance to IMPL_REVIEW state with blocked obligation
  const sessDir = await currentSessionDir();
  const state = await readState(sessDir);
  if (!state) throw new Error('No state');

  const blockedObligations = Array.from({ length: blockedCount }, (_, i) =>
    makeBlockedObligation('implement', i, 1),
  );

  const implState: SessionState = {
    ...state,
    phase: 'IMPL_REVIEW' as SessionState['phase'],
    selfReview: {
      iteration: 1,
      maxIterations: 3,
      prevDigest: null,
      currDigest: 'test-digest',
      revisionDelta: 'none',
      verdict: 'accept',
    },
    implementation: {
      changedFiles: ['src/test.ts'],
      domainFiles: ['src/test.ts'],
      digest: 'impl-digest',
      executedAt: new Date().toISOString(),
    },
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v5' as const,
      obligations: blockedObligations,
      invocations: [],
      attempts: [],
    },
  };

  await writeState(sessDir, implState);
}

/** Setup architecture dead state with blocked obligation. */
async function setupArchitectureDeadState(blockedCount = 1): Promise<void> {
  const { hydrate } = await import('./tools/index.js');
  await hydrate.execute({ policyMode: 'solo' }, ctx);

  const sessDir = await currentSessionDir();
  const state = await readState(sessDir);
  if (!state) throw new Error('No state');

  const blockedObligations = Array.from({ length: blockedCount }, (_, i) =>
    makeBlockedObligation('architecture', 0, i + 1),
  );

  const archState: SessionState = {
    ...state,
    phase: 'ARCHITECTURE' as SessionState['phase'],
    architecture: {
      id: 'ADR-001',
      title: 'Test Decision',
      adrText: '## Context\nTest\n## Decision\nTest\n## Consequences\nTest',
      status: 'proposed',
      reviewCompletion: 'pending',
      digest: 'adr-digest',
      createdAt: new Date().toISOString(),
    },
    selfReview: {
      iteration: 0,
      maxIterations: 3,
      prevDigest: null,
      currDigest: 'adr-digest',
      revisionDelta: 'major',
      verdict: 'changes_requested',
    },
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v5' as const,
      obligations: blockedObligations,
      invocations: [],
      attempts: [],
    },
  };

  await writeState(sessDir, archState);
}

// =============================================================================
// Plan Tool — Dead-State Recovery
// =============================================================================

describe('plan — dead-state recovery (Fix 2a)', () => {
  describe('HAPPY: re-submission after blocked obligation', () => {
    it('allows plan re-submission when last plan obligation is blocked', async () => {
      await setupPlanDeadState(1);

      const raw = await plan.execute(
        {
          planText:
            '## Objective\nRetry\n## Approach\nRetry\n## Steps\n1. retry\n## Files to Modify\ntest.ts\n## Edge Cases\n1. none\n## Validation Criteria\n1. pass\n## Verification Plan\n1. test',
          targetPaths: ['docs/test.md'],
        },
        ctx,
      );
      const result = parseToolResult(raw);

      // Should succeed (not PLAN_REVIEW_IN_PROGRESS)
      expect(result.error).not.toBe(true);
      expect(result.phase).toBeDefined();
      expect(result.status).toContain('Plan submitted');
    });

    it('creates a fresh obligation after re-submission', async () => {
      await setupPlanDeadState(1);

      await plan.execute(
        {
          planText:
            '## Objective\nRetry\n## Approach\nRetry\n## Steps\n1. retry\n## Files to Modify\ntest.ts\n## Edge Cases\n1. none\n## Validation Criteria\n1. pass\n## Verification Plan\n1. test',
          targetPaths: ['docs/test.md'],
        },
        ctx,
      );

      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      const obligations = state!.reviewAssurance?.obligations ?? [];
      // Should have the old blocked + new pending
      const pendingObligations = obligations.filter((o) => o.status !== 'blocked');
      expect(pendingObligations.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('BAD: max-cap prevents infinite retry loop', () => {
    it('blocks with ORCHESTRATION_PERMANENTLY_FAILED after 3 blocked obligations', async () => {
      await setupPlanDeadState(3);

      const raw = await plan.execute(
        {
          planText:
            '## Objective\nRetry\n## Approach\nRetry\n## Steps\n1. retry\n## Files to Modify\ntest.ts\n## Edge Cases\n1. none\n## Validation Criteria\n1. pass\n## Verification Plan\n1. test',
          targetPaths: ['docs/test.md'],
        },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('ORCHESTRATION_PERMANENTLY_FAILED');
    });
  });

  describe('EDGE: pending review loop re-emits its instruction', () => {
    it('re-emits the existing obligation for the SAME plan text and blocks a changed revision', async () => {
      const { hydrate, ticket: ticketTool } = await import('./tools/index.js');
      await hydrate.execute({ policyMode: 'solo' }, ctx);
      await ticketTool.execute({ text: 'Test task', source: 'user' }, ctx);
      const PLAN_TEXT =
        '## Objective\nTest\n## Approach\nTest\n## Steps\n1. test\n## Files to Modify\ntest.ts\n## Edge Cases\n1. none\n## Validation Criteria\n1. pass\n## Verification Plan\n1. test';
      const firstRaw = await plan.execute(
        { planText: PLAN_TEXT, targetPaths: ['docs/test.md'] },
        ctx,
      );
      const first = parseToolResult(firstRaw);

      // State now has selfReview and a pending obligation.
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      const obligations = state!.reviewAssurance?.obligations ?? [];
      const lastObl = obligations[obligations.length - 1];
      expect(lastObl?.status).not.toBe('blocked');

      // SAME revision: the pending obligation re-emits its instruction.
      const sameRaw = await plan.execute(
        { planText: PLAN_TEXT, targetPaths: ['docs/test.md'] },
        ctx,
      );
      const same = parseToolResult(sameRaw);
      expect(same.error).not.toBe(true);
      expect(same.reviewObligationId).toBe(lastObl?.obligationId ?? first.reviewObligationId);

      // CHANGED revision while pending: fail closed — never silently ignored.
      const changedRaw = await plan.execute(
        {
          planText:
            '## Objective\nNew\n## Approach\nNew\n## Steps\n1. new\n## Files to Modify\nnew.ts\n## Edge Cases\n1. none\n## Validation Criteria\n1. pass\n## Verification Plan\n1. test',
          targetPaths: ['docs/test.md'],
        },
        ctx,
      );
      const changed = parseToolResult(changedRaw);
      expect(changed.error).toBe(true);
      expect(changed.code).toBe('REVIEW_SUBJECT_CHANGED_WHILE_PENDING');
    });
  });
});

// =============================================================================
// Implement Tool — Dead-State Recovery
// =============================================================================

describe('implement — dead-state recovery (Fix 2b)', () => {
  describe('HAPPY: re-recording after blocked obligation', () => {
    it('allows implementation re-recording when in IMPL_REVIEW with blocked obligation', async () => {
      await setupImplementDeadState(1);

      const raw = await implement.execute({}, ctx);
      const result = parseToolResult(raw);

      // Should succeed (not COMMAND_NOT_ALLOWED)
      expect(result.error).not.toBe(true);
      expect(result.status).toContain('Implementation recorded');
    });
  });

  describe('BAD: max-cap prevents infinite retry loop', () => {
    it('blocks with ORCHESTRATION_PERMANENTLY_FAILED after 3 blocked obligations', async () => {
      await setupImplementDeadState(3);

      const raw = await implement.execute({}, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('ORCHESTRATION_PERMANENTLY_FAILED');
    });
  });

  describe('EDGE: normal COMMAND_NOT_ALLOWED still works in wrong phase', () => {
    it('blocks implementation in TICKET phase', async () => {
      const { hydrate, ticket: ticketTool } = await import('./tools/index.js');
      await hydrate.execute({ policyMode: 'solo' }, ctx);
      await ticketTool.execute({ text: 'Test task', source: 'user' }, ctx);

      const raw = await implement.execute({}, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });
  });
});

// =============================================================================
// Architecture Tool — Dead-State Recovery
// =============================================================================

describe('architecture — dead-state recovery (Fix 2c)', () => {
  describe('HAPPY: re-submission after blocked obligation', () => {
    it('allows ADR re-submission when last architecture obligation is blocked', async () => {
      await setupArchitectureDeadState(1);

      const raw = await architecture.execute(
        {
          title: 'Test Decision Retry',
          adrText: '## Context\nRetry\n## Decision\nRetry\n## Consequences\nRetry',
          targetPaths: ['docs/test.md'],
        },
        ctx,
      );
      const result = parseToolResult(raw);

      // Should succeed (not ADR_REVIEW_IN_PROGRESS)
      expect(result.error).not.toBe(true);
      expect(result.status).toContain('ADR');
    });
  });

  describe('BAD: max-cap prevents infinite retry loop', () => {
    it('blocks with ORCHESTRATION_PERMANENTLY_FAILED after 3 blocked obligations', async () => {
      await setupArchitectureDeadState(3);

      const raw = await architecture.execute(
        {
          title: 'Test Decision Retry',
          adrText: '## Context\nRetry\n## Decision\nRetry\n## Consequences\nRetry',
          targetPaths: ['docs/test.md'],
        },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('ORCHESTRATION_PERMANENTLY_FAILED');
    });
  });

  describe('EDGE: normal ADR_REVIEW_IN_PROGRESS still works', () => {
    it('blocks re-submission when obligation is pending (not blocked)', async () => {
      await setupArchitectureDeadState(1);

      // Change the obligation to pending instead of blocked
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      if (!state) throw new Error('No state');

      const updatedState: SessionState = {
        ...state,
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v5' as const,
          obligations: [makePendingObligation('architecture', 0, 1)],
          invocations: [],
          attempts: [],
        },
      };
      await writeState(sessDir, updatedState);

      const raw = await architecture.execute(
        {
          title: 'Another Decision',
          adrText: '## Context\nNew\n## Decision\nNew\n## Consequences\nNew',
          targetPaths: ['docs/test.md'],
        },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('ADR_REVIEW_IN_PROGRESS');
    });
  });

  describe('restart identity, revision, and output repair', () => {
    const ADR_TEXT = '## Context\nTest\n## Decision\nTest\n## Consequences\nTest';
    const CREATED_AT = '2026-01-01T00:00:00.000Z';

    async function setArchitectureState(adrText: string): Promise<string> {
      await setupArchitectureDeadState(1);
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      if (!state) throw new Error('No state');
      const updated: SessionState = {
        ...state,
        architecture: {
          ...state.architecture!,
          adrText,
          digest: hashText(adrText),
          createdAt: CREATED_AT,
        },
        selfReview: { ...state.selfReview!, currDigest: hashText(adrText) },
        nextAdrNumber: 2,
      };
      await writeState(sessDir, updated);
      return sessDir;
    }

    it('restart with the same ADR digest preserves ADR identity and mints a fresh obligation', async () => {
      const sessDir = await setArchitectureState(ADR_TEXT);
      const before = await readState(sessDir);
      const blockedObligationId = before!.reviewAssurance!.obligations.find(
        (o) => o.status === 'blocked',
      )!.obligationId;

      const raw = await architecture.execute({ title: 'Test Decision', adrText: ADR_TEXT }, ctx);
      const result = parseToolResult(raw);

      expect(result.error).not.toBe(true);
      expect(result.status).toContain('restarted');
      expect(result.adrId).toBe('ADR-001');
      expect(result.adrDigest).toBe(hashText(ADR_TEXT));
      expect(result.reviewObligationId).toBeDefined();
      expect(result.reviewObligationId).not.toBe(blockedObligationId);

      const after = await readState(sessDir);
      // A blocked review obligation is a new review generation — never a new ADR.
      expect(after!.architecture!.id).toBe('ADR-001');
      expect(after!.architecture!.digest).toBe(hashText(ADR_TEXT));
      expect(after!.architecture!.createdAt).toBe(CREATED_AT);
      expect(after!.nextAdrNumber).toBe(2);
      const pending = after!.reviewAssurance!.obligations.filter((o) => o.status === 'pending');
      expect(pending.length).toBe(1);
      expect(pending[0]!.subjectDigest).toBe(hashText(ADR_TEXT));
      expect(pending[0]!.reviewSubjectScope?.kind).toBe('artifact');
    });

    it('restart with a changed ADR digest revises the same ADR identity with a fresh obligation', async () => {
      const sessDir = await setArchitectureState(ADR_TEXT);
      const revisedText = '## Context\nRevised\n## Decision\nRevised\n## Consequences\nRevised';

      const raw = await architecture.execute({ title: 'Test Decision', adrText: revisedText }, ctx);
      const result = parseToolResult(raw);

      expect(result.error).not.toBe(true);
      expect(result.status).toContain('revised');
      expect(result.adrId).toBe('ADR-001');
      expect(result.adrDigest).toBe(hashText(revisedText));

      const after = await readState(sessDir);
      expect(after!.architecture!.id).toBe('ADR-001');
      expect(after!.architecture!.digest).toBe(hashText(revisedText));
      expect(after!.architecture!.createdAt).toBe(CREATED_AT);
      expect(after!.nextAdrNumber).toBe(2);
      expect(after!.selfReview!.prevDigest).toBe(hashText(ADR_TEXT));
      // The blocked predecessor stays bound to the old digest.
      const blocked = after!.reviewAssurance!.obligations.filter((o) => o.status === 'blocked');
      expect(blocked.length).toBe(1);
      const pending = after!.reviewAssurance!.obligations.filter((o) => o.status === 'pending');
      expect(pending.length).toBe(1);
      expect(pending[0]!.subjectDigest).toBe(hashText(revisedText));
    });

    it('output repair: a repairable rejection reissues a fresh attempt on the SAME obligation', async () => {
      await setupArchitectureDeadState(1);
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      if (!state) throw new Error('No state');

      const pending = createReviewObligation({
        obligationType: 'architecture',
        iteration: 0,
        planVersion: 1,
        now: CREATED_AT,
        subjectDigest: hashText(ADR_TEXT),
        reviewMaterial: freezeReviewMaterial(ADR_TEXT, hashText(ADR_TEXT)),
        reviewSubjectScope: artifactReviewSubjectScope('adr', ADR_TEXT, hashText(ADR_TEXT)),
        changedFiles: [],
        policySnapshot: state.policySnapshot,
      });
      const rejectedAttempt: ReviewAttempt = {
        attemptId: crypto.randomUUID(),
        obligationId: pending.obligationId,
        obligationType: 'architecture',
        subjectDigest: pending.subjectDigest,
        reviewMaterial: pending.reviewMaterial,
        ordinal: 1,
        status: 'rejected',
        origin: { kind: 'initial' },
        rejectionReason: 'schema_invalid',
        repositoryDiscovery: { kind: 'not_applicable' },
        createdAt: CREATED_AT,
      };
      await writeState(sessDir, {
        ...state,
        architecture: { ...state.architecture!, adrText: ADR_TEXT, digest: hashText(ADR_TEXT) },
        selfReview: { ...state.selfReview!, currDigest: hashText(ADR_TEXT) },
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v5' as const,
          obligations: [pending],
          invocations: [],
          attempts: [rejectedAttempt],
        },
      });

      const raw = await architecture.execute({ title: 'Test Decision', adrText: ADR_TEXT }, ctx);
      const result = parseToolResult(raw);

      expect(result.error).not.toBe(true);
      expect(result.status).toContain('repair');
      expect(result.reviewObligationId).toBe(pending.obligationId);

      const after = await readState(sessDir);
      const attempts = after!.reviewAssurance!.attempts.filter(
        (a) => a.obligationId === pending.obligationId,
      );
      expect(attempts.length).toBe(2);
      expect(attempts.filter((a) => a.status === 'created').length).toBe(1);
      expect(attempts.at(-1)!.origin.kind).toBe('output_repair');
    });

    it('restart continues the current review cycle: predecessor, flow state, fresh obligation, and prompt share the iteration', async () => {
      const sessDir = await setArchitectureState(ADR_TEXT);
      const state = await readState(sessDir);
      if (!state) throw new Error('No state');

      const blocked = state.reviewAssurance!.obligations.find((o) => o.status === 'blocked')!;
      await writeState(sessDir, {
        ...state,
        selfReview: { ...state.selfReview!, iteration: 2 },
        reviewAssurance: {
          ...state.reviewAssurance!,
          obligations: [{ ...blocked, iteration: 2 }],
        },
      });

      const raw = await architecture.execute({ title: 'Test Decision', adrText: ADR_TEXT }, ctx);
      const result = parseToolResult(raw);

      expect(result.error).not.toBe(true);
      expect(result.status).toContain('restarted');
      expect(result.reviewObligationIteration).toBe(2);
      expect(result.selfReviewIteration).toBe(2);
      expect(String(result.next)).toContain('iteration=2');

      const after = await readState(sessDir);
      const pending = after!.reviewAssurance!.obligations.filter((o) => o.status === 'pending');
      expect(pending.length).toBe(1);
      expect(pending[0]!.iteration).toBe(2);
    });

    it('fails closed when the blocked predecessor iteration does not match the flow state cycle', async () => {
      const sessDir = await setArchitectureState(ADR_TEXT);
      const state = await readState(sessDir);
      if (!state) throw new Error('No state');

      // Blocked predecessor carries iteration 0 while the flow state already
      // advanced to iteration 2 — an inconsistent review cycle.
      await writeState(sessDir, {
        ...state,
        selfReview: { ...state.selfReview!, iteration: 2 },
      });

      const raw = await architecture.execute({ title: 'Test Decision', adrText: ADR_TEXT }, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('RESTART_CYCLE_ITERATION_MISMATCH');
    });

    it('fails closed when a pending continuation receives a changed ADR digest', async () => {
      await setupArchitectureDeadState(1);
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      if (!state) throw new Error('No state');

      const pending = createReviewObligation({
        obligationType: 'architecture',
        iteration: 0,
        planVersion: 1,
        now: CREATED_AT,
        subjectDigest: hashText(ADR_TEXT),
        reviewMaterial: freezeReviewMaterial(ADR_TEXT, hashText(ADR_TEXT)),
        reviewSubjectScope: artifactReviewSubjectScope('adr', ADR_TEXT, hashText(ADR_TEXT)),
        changedFiles: [],
        policySnapshot: state.policySnapshot,
      });
      const withAttempt = appendObligationWithAttempt(undefined, pending, CREATED_AT);
      await writeState(sessDir, {
        ...state,
        architecture: { ...state.architecture!, adrText: ADR_TEXT, digest: hashText(ADR_TEXT) },
        selfReview: { ...state.selfReview!, currDigest: hashText(ADR_TEXT) },
        reviewAssurance: withAttempt.assurance,
      });

      const changedText = '## Context\nChanged\n## Decision\nChanged\n## Consequences\nChanged';
      const raw = await architecture.execute({ title: 'Test Decision', adrText: changedText }, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_SUBJECT_CHANGED_WHILE_PENDING');
    });

    it('re-emits the pending review for the same ADR digest', async () => {
      await setupArchitectureDeadState(1);
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      if (!state) throw new Error('No state');

      const pending = createReviewObligation({
        obligationType: 'architecture',
        iteration: 0,
        planVersion: 1,
        now: CREATED_AT,
        subjectDigest: hashText(ADR_TEXT),
        reviewMaterial: freezeReviewMaterial(ADR_TEXT, hashText(ADR_TEXT)),
        reviewSubjectScope: artifactReviewSubjectScope('adr', ADR_TEXT, hashText(ADR_TEXT)),
        changedFiles: [],
        policySnapshot: state.policySnapshot,
      });
      const withAttempt = appendObligationWithAttempt(undefined, pending, CREATED_AT);
      await writeState(sessDir, {
        ...state,
        architecture: { ...state.architecture!, adrText: ADR_TEXT, digest: hashText(ADR_TEXT) },
        selfReview: { ...state.selfReview!, currDigest: hashText(ADR_TEXT) },
        reviewAssurance: withAttempt.assurance,
      });

      const raw = await architecture.execute({ title: 'Test Decision', adrText: ADR_TEXT }, ctx);
      const result = parseToolResult(raw);

      expect(result.error).not.toBe(true);
      expect(result.reviewObligationId).toBe(pending.obligationId);
      expect(result.status).toContain('pending');
    });
  });
});
