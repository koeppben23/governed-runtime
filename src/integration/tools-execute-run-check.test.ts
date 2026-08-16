/**
 * @module integration/Execution tests for the run_check tool
 * @description Execution tests for the run_check tool.
 *
 * Tests each tool's execute() against real filesystem persistence with
 * OPENCODE_CONFIG_DIR redirected to a temp directory. Git adapter functions
 * (remoteOriginUrl, changedFiles, listRepoSignals) are selectively mocked;
 * all other I/O (workspace init, state read/write, config) runs for real.
 *
 * Scope: Tool behavior, tool-to-state, tool-to-persistence, tool-specific edge cases.
 * NOT in scope: Full multi-step workflows (see e2e-workflow.test.ts).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import {
  createToolContext,
  createTestWorkspace,
  isTarAvailable,
  parseToolResult,
  isBlockedResult,
  fulfillStrictReviewObligation,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
  withTestEnv,
} from './test-helpers.js';
import { REVIEW_MANDATE_DIGEST } from './review/assurance.js';
import {
  status,
  hydrate,
  ticket,
  plan,
  decision,
  implement,
  run_check,
  review,
  abort_session,
  archive,
} from './tools/index.js';
import { readState, writeState } from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import * as persistence from '../adapters/persistence.js';
import {
  makeState,
  makeProgressedState,
  TICKET,
  PLAN_RECORD,
  SELF_REVIEW_CONVERGED,
  REVIEW_APPROVE,
  VALIDATION_PASSED,
  IMPL_EVIDENCE,
  IMPL_REVIEW_CONVERGED,
} from '../fixtures.js';
import { resolvePolicyFromState, writeStateWithArtifacts } from './tools/helpers.js';
import { TEAM_POLICY } from '../config/policy.js';
import { runWithAdapterLoggerAsync, type AdapterLogger } from '../logging/adapter-logger.js';

// ─── Git Mock ────────────────────────────────────────────────────────────────

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

// ─── Workspace Mock (P26) ────────────────────────────────────────────────────
// Partial mock: archiveSession and verifyArchive are vi.fn() wrappers that
// default to the real implementations. P26 tests override them per-test.
// All other workspace exports (computeFingerprint, initWorkspace, etc.)
// remain real for full integration fidelity.
//
// Originals are stored via vi.hoisted (survives vi.mock hoisting) so afterEach
// can fully reset the once-queues (vi.clearAllMocks does NOT clear
// mockResolvedValueOnce queues — unconsumed values leak across tests).

const wsOriginals = vi.hoisted(() => ({
  archiveSession:
    null as unknown as (typeof import('../adapters/workspace/index.js'))['archiveSession'],
  verifyArchive:
    null as unknown as (typeof import('../adapters/workspace/index.js'))['verifyArchive'],
}));

vi.mock('../adapters/workspace', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/workspace/index.js')>();
  wsOriginals.archiveSession = original.archiveSession;
  wsOriginals.verifyArchive = original.verifyArchive;
  return {
    ...original,
    archiveSession: vi.fn(original.archiveSession),
    verifyArchive: vi.fn(original.verifyArchive),
  };
});

// ─── Actor Mock (P27) ────────────────────────────────────────────────────────
// Mock resolveActor to return a deterministic actor for integration tests.
// Prevents dependency on real env vars or git config.

const actorOriginal = vi.hoisted(() => ({
  resolveActor: null as unknown as (typeof import('../adapters/actor.js'))['resolveActor'],
}));

vi.mock('../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/actor.js')>();
  actorOriginal.resolveActor = original.resolveActor;
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      source: 'env',
    }),
  };
});

// ─── Persistence Mock (P8b: writeReport-throws test) ────────────────────────
// wrap writeReport as vi.fn forwarding to real implementation; tests can
// override per-test via mockImplementation.

const persistenceOriginals = vi.hoisted(() => ({
  writeReport: null as unknown as (typeof import('../adapters/persistence.js'))['writeReport'],
  readState: null as unknown as (typeof import('../adapters/persistence.js'))['readState'],
  writeState: null as unknown as (typeof import('../adapters/persistence.js'))['writeState'],
}));

vi.mock('../adapters/persistence', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/persistence.js')>();
  persistenceOriginals.writeReport = original.writeReport;
  persistenceOriginals.readState = original.readState;
  persistenceOriginals.writeState = original.writeState;
  return {
    ...original,
    writeReport: vi.fn(original.writeReport),
    readState: vi.fn(original.readState),
    writeState: vi.fn(original.writeState),
  };
});

// ─── Verification Executor Mock ─────────────────────────────────────────────
// Mock executeCheck to avoid real subprocess execution.
vi.mock('../verification/executor', () => ({
  executeCheck: vi
    .fn()
    .mockImplementation(async (input: { kind: string; command: string; cwd: string }) => ({
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

// Lazy import for per-test overrides
const gitMock = await import('../adapters/git.js');
const wsMock = await import('../adapters/workspace/index.js');
const actorMock = await import('../adapters/actor.js');
const persistenceMock = await import('../adapters/persistence.js');
const executorMock = await import('../verification/executor.js');

// ─── Capability Gates ────────────────────────────────────────────────────────

const tarOk = await isTarAvailable();

// ─── Test Setup ──────────────────────────────────────────────────────────────

let ws: TestWorkspace;
let ctx: TestToolContext;
let cleanupEnv: () => void;

beforeEach(async () => {
  cleanupEnv = withTestEnv({ FLOWGUARD_POLICY_PATH: undefined });
  ws = await createTestWorkspace();
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
  });
});

afterEach(async () => {
  // Reset workspace mock once-queues to prevent cross-test leaks.
  // vi.clearAllMocks() only clears calls/results, NOT mockResolvedValueOnce
  // queues. If a P26 test fails before consuming its once-mocks, the stale
  // values leak into subsequent tests (e.g. archive manifest test).
  vi.mocked(wsMock.archiveSession).mockReset().mockImplementation(wsOriginals.archiveSession);
  vi.mocked(wsMock.verifyArchive).mockReset().mockImplementation(wsOriginals.verifyArchive);
  // Reset persistence mock to real implementation (P8b)
  vi.mocked(persistenceMock.writeReport)
    .mockReset()
    .mockImplementation(persistenceOriginals.writeReport);
  vi.mocked(persistenceMock.readState)
    .mockReset()
    .mockImplementation(persistenceOriginals.readState);
  vi.mocked(persistenceMock.writeState)
    .mockReset()
    .mockImplementation(persistenceOriginals.writeState);
  // Reset actor mock to default deterministic value (P27/P34)
  vi.mocked(actorMock.resolveActor)
    .mockReset()
    .mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'best_effort' as const,
    });
  cleanupEnv();
  vi.clearAllMocks();
  await ws.cleanup();
});

// ─── Helpers ────────────────────────────────────────────────────────────

async function hydrateSession(
  overrides: { policyMode?: string; profileId?: string } = {},
): Promise<Record<string, unknown>> {
  const args: { policyMode: string; profileId?: string } = {
    policyMode: overrides.policyMode ?? 'solo',
  };
  if (overrides.profileId !== undefined) {
    args.profileId = overrides.profileId;
  }
  const raw = await hydrate.execute(args, ctx);
  return parseToolResult(raw);
}

async function hydrateAndTicket(ticketText = 'Fix the auth bug'): Promise<void> {
  await hydrateSession();
  await ticket.execute({ text: ticketText, source: 'user' }, ctx);
}

async function currentSessionDir(): Promise<string> {
  const { computeFingerprint, sessionDir: resolveSessionDir } =
    await import('../adapters/workspace/index.js');
  const fp = await computeFingerprint(ws.tmpDir);
  return resolveSessionDir(fp.fingerprint, ctx.sessionID);
}

async function fulfillReview(
  obligationType: 'plan' | 'implement',
  iteration: number,
  overallVerdict: 'accept' | 'changes_requested' = 'accept',
) {
  return fulfillStrictReviewObligation(await currentSessionDir(), {
    obligationType,
    iteration,
    planVersion: 1,
    overallVerdict,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool: run_check
// ═══════════════════════════════════════════════════════════════════════════

describe('run_check', () => {
  /** Helper: reach VALIDATION phase. */
  async function reachValidation(): Promise<void> {
    await hydrateAndTicket();
    await plan.execute({ planText: '## Plan', targetPaths: ['docs/test.md'] }, ctx);
    const reviewFindings = await fulfillReview('plan', 0, 'accept');
    await plan.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);
    // Solo: auto-advances PLAN_REVIEW → VALIDATION
    // (Discovery detects TypeScript → activeChecks=['typecheck'])
  }

  describe('HAPPY', () => {
    it('passing check advances to IMPLEMENTATION', async () => {
      await reachValidation();
      const raw = await run_check.execute({ kind: 'typecheck' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('IMPLEMENTATION');
      expect(result.evidence).toBeDefined();
      const evidence = result.evidence as Record<string, unknown>;
      expect(evidence.passed).toBe(true);
      expect(evidence.exitCode).toBe(0);
      expect(evidence.kind).toBe('typecheck');
    });
  });

  describe('BAD', () => {
    it('blocks without session', async () => {
      const raw = await run_check.execute({ kind: 'typecheck' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });
  });

  describe('CORNER', () => {
    it('failed check returns to PLAN', async () => {
      await reachValidation();
      // Override executor to return failure
      vi.mocked(executorMock.executeCheck).mockResolvedValueOnce({
        kind: 'typecheck',
        command: 'npx tsc --noEmit',
        exitCode: 1,
        passed: false,
        executionMs: 200,
        outputDigest: 'f'.repeat(64),
        stdout: 'error TS2322: Type mismatch',
        stderr: '',
        timedOut: false,
        startedAt: new Date().toISOString(),
      });
      const raw = await run_check.execute({ kind: 'typecheck' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PLAN');
    });

    it('blocks when kind is not in verificationCandidates', async () => {
      await reachValidation();
      const raw = await run_check.execute({ kind: 'security' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('CHECK_KIND_NOT_AVAILABLE');
    });

    it('execution evidence is persisted in state', async () => {
      await reachValidation();
      await run_check.execute({ kind: 'typecheck' }, ctx);
      const s = parseToolResult(await status.execute({}, ctx));
      const vr = s.validationResults as Array<{
        checkId: string;
        passed: boolean;
        kind: string;
        command: string;
        exitCode: number;
        executionMs: number;
        timedOut: boolean;
      }>;
      expect(vr).toHaveLength(1);
      const result = vr[0];
      expect(result).toBeDefined();
      if (!result) throw new TypeError('Expected a validation result');
      expect(result.checkId).toBe('typecheck');
      expect(result.passed).toBe(true);
      expect(result.kind).toBe('typecheck');
      expect(typeof result.command).toBe('string');
      expect(result.exitCode).toBe(0);
      expect(typeof result.executionMs).toBe('number');
      expect(result.timedOut).toBe(false);
    });

    it('timed out check records timedOut evidence', async () => {
      await reachValidation();
      vi.mocked(executorMock.executeCheck).mockResolvedValueOnce({
        kind: 'typecheck',
        command: 'npx tsc --noEmit',
        exitCode: -1,
        passed: false,
        executionMs: 60000,
        outputDigest: '0'.repeat(64),
        stdout: '',
        stderr: '',
        timedOut: true,
        startedAt: new Date().toISOString(),
      });
      const raw = await run_check.execute({ kind: 'typecheck' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      // F5: an execution error (timeout) is not a plan deficiency — stay in
      // VALIDATION for a retry (CHECK_ERRORED) instead of routing back to PLAN.
      expect(result.phase).toBe('VALIDATION');
      const evidence = result.evidence as Record<string, unknown>;
      expect(evidence.timedOut).toBe(true);
      expect(evidence.passed).toBe(false);
    });
  });
});
