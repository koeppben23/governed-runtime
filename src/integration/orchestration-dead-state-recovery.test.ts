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
import type { SessionState } from '../state/schema.js';
import type { ReviewObligation } from '../state/evidence.js';

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
    iteration,
    planVersion,
    criteriaVersion: 'p35-v1',
    mandateDigest: 'test-mandate-digest-blocked',
    status: 'blocked',
    blockedCode: 'STRICT_REVIEW_ORCHESTRATION_FAILED',
    createdAt: new Date().toISOString(),
    pluginHandshakeAt: new Date().toISOString(),
    invocationId: null,
    fulfilledAt: null,
    consumedAt: null,
  } as ReviewObligation;
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
    iteration,
    planVersion,
    criteriaVersion: 'p35-v1',
    mandateDigest: 'test-mandate-digest-pending',
    status: 'pending',
    blockedCode: null,
    createdAt: new Date().toISOString(),
    pluginHandshakeAt: null,
    invocationId: null,
    fulfilledAt: null,
    consumedAt: null,
  } as ReviewObligation;
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
      obligations: blockedObligations,
      invocations: state.reviewAssurance?.invocations ?? [],
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
      verdict: 'approve',
    },
    implementation: {
      changedFiles: ['src/test.ts'],
      domainFiles: ['src/test.ts'],
      digest: 'impl-digest',
      executedAt: new Date().toISOString(),
    },
    reviewAssurance: {
      obligations: blockedObligations,
      invocations: [],
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
      obligations: blockedObligations,
      invocations: [],
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
        },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('ORCHESTRATION_PERMANENTLY_FAILED');
    });
  });

  describe('EDGE: normal PLAN_REVIEW_IN_PROGRESS still works', () => {
    it('blocks re-submission when obligation is pending (not blocked)', async () => {
      const { hydrate, ticket: ticketTool } = await import('./tools/index.js');
      await hydrate.execute({ policyMode: 'solo' }, ctx);
      await ticketTool.execute({ text: 'Test task', source: 'user' }, ctx);
      await plan.execute(
        {
          planText:
            '## Objective\nTest\n## Approach\nTest\n## Steps\n1. test\n## Files to Modify\ntest.ts\n## Edge Cases\n1. none\n## Validation Criteria\n1. pass\n## Verification Plan\n1. test',
        },
        ctx,
      );

      // State now has selfReview and a pending obligation — re-submission should be blocked
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      const obligations = state!.reviewAssurance?.obligations ?? [];
      // Verify at least one obligation exists and it's NOT blocked
      const lastObl = obligations[obligations.length - 1];
      expect(lastObl?.status).not.toBe('blocked');

      const raw = await plan.execute(
        {
          planText:
            '## Objective\nNew\n## Approach\nNew\n## Steps\n1. new\n## Files to Modify\nnew.ts\n## Edge Cases\n1. none\n## Validation Criteria\n1. pass\n## Verification Plan\n1. test',
        },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('PLAN_REVIEW_IN_PROGRESS');
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
          obligations: [makePendingObligation('architecture', 0, 1)],
          invocations: [],
        },
      };
      await writeState(sessDir, updatedState);

      const raw = await architecture.execute(
        {
          title: 'Another Decision',
          adrText: '## Context\nNew\n## Decision\nNew\n## Consequences\nNew',
        },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('ADR_REVIEW_IN_PROGRESS');
    });
  });
});
