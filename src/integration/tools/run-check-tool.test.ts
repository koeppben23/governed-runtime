/**
 * @module integration/tools/run-check-tool.test
 * @description Standalone tests for flowguard_run_check tool.
 *
 * Tests the tool's specific behavior:
 * - HAPPY: Successful check execution and state recording
 * - BAD: Phase blocks, missing candidates, inactive check kinds
 * - CORNER: Replaces existing result for same checkId, advances on all passed
 * - EDGE: Timeout evidence, failed check evidence shape
 *
 * Uses mocked executor (no real subprocesses) and real filesystem persistence.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  withStrictReviewFindings,
  GIT_MOCK_DEFAULTS,
  isBlockedResult,
  type TestToolContext,
  type TestWorkspace,
} from '../test-helpers.js';
import { status, hydrate, ticket, plan, run_check } from '../tools/index.js';
import { readState, writeState } from '../../adapters/persistence.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../../adapters/workspace/index.js';
import { executeCheck } from '../../verification/executor.js';
import { PersistenceError } from '../../adapters/persistence.js';
import { withSessionWriteLockRetry } from '../../adapters/lock-retry.js';
import {
  resetAdapterLogger,
  setAdapterLogger,
  type AdapterLogger,
} from '../../logging/adapter-logger.js';
import { runWithLogContextAsync } from '../../logging/log-context.js';
import type { ToolDefinition } from '../tools/helpers.js';

type RunCheckResult = {
  error?: boolean;
  code?: string;
  message?: string;
  evidence: {
    kind: string;
    passed: boolean;
    exitCode: number;
    executionMs: number;
    outputDigest: string;
    timedOut: boolean;
  };
  derivedRepairGuidance?: unknown;
  remainingChecks?: unknown[];
  status?: string;
};

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

vi.mock('../../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../adapters/actor.js')>();
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'claim_validated' as const,
    }),
  };
});

vi.mock('../../verification/executor', () => ({
  executeCheck: vi
    .fn()
    .mockImplementation(async (input: { kind: string; command: string; cwd: string }) => ({
      kind: input.kind,
      command: input.command,
      exitCode: 0,
      passed: true,
      executionMs: 150,
      outputDigest: 'a'.repeat(64),
      stdout: 'All clear',
      stderr: '',
      timedOut: false,
      startedAt: '2026-01-01T00:00:00.000Z',
    })),
}));

vi.mock('../../adapters/lock-retry.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../adapters/lock-retry.js')>();
  return {
    ...original,
    withSessionWriteLockRetry: vi.fn(
      (...args: Parameters<typeof original.withSessionWriteLockRetry>) =>
        original.withSessionWriteLockRetry(...args),
    ),
  };
});

// ─── Setup ───────────────────────────────────────────────────────────────────

let ws: TestWorkspace;
let ctx: TestToolContext;

beforeEach(async () => {
  ws = await createTestWorkspace();
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
  });
  vi.mocked(executeCheck).mockClear();
});

afterEach(async () => {
  resetAdapterLogger();
  await ws.cleanup();
});

function captureLogger(): {
  log: AdapterLogger;
  entries: { level: string; service: string; message: string; extra?: Record<string, unknown> }[];
} {
  const entries: {
    level: string;
    service: string;
    message: string;
    extra?: Record<string, unknown>;
  }[] = [];
  return {
    entries,
    log: {
      info(service, message, extra) {
        entries.push({ level: 'info', service, message, extra });
      },
      warn(service, message, extra) {
        entries.push({ level: 'warn', service, message, extra });
      },
      error(service, message, extra) {
        entries.push({ level: 'error', service, message, extra });
      },
      warnOnce(service, message, extra) {
        entries.push({ level: 'warn', service, message, extra });
      },
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function callOk(tool: ToolDefinition, args: unknown) {
  const sd = await getSessDir();
  const finalArgs = await withStrictReviewFindings(sd, args);
  const raw = await tool.execute(finalArgs, ctx);
  const result = parseToolResult(raw);
  if (result.error) {
    throw new Error(`Tool returned error: ${result.code} — ${result.message}`);
  }
  return result;
}

async function getSessDir(): Promise<string> {
  const fp = await computeFingerprint(ctx.worktree);
  return resolveSessionDir(fp.fingerprint, ctx.sessionID);
}

async function driveToValidation(): Promise<void> {
  await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
  await callOk(ticket, { text: 'Test task', source: 'user' });
  await callOk(plan, { planText: '## Plan\nTest plan' });
  await callOk(plan, { reviewVerdict: 'accept' });
  // Now should be in VALIDATION phase
}

// ─── HAPPY ───────────────────────────────────────────────────────────────────

describe('HAPPY', () => {
  it('executes check and returns evidence', async () => {
    await driveToValidation();
    const result = parseToolResult<RunCheckResult>(
      await run_check.execute({ kind: 'typecheck' }, ctx),
    );

    expect(result.error).toBeUndefined();
    expect(result.evidence).toBeDefined();
    expect(result.evidence.kind).toBe('typecheck');
    expect(result.evidence.passed).toBe(true);
    expect(result.evidence.exitCode).toBe(0);
    expect(result.evidence.executionMs).toBe(150);
    expect(result.evidence.outputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('records validation result in state', async () => {
    await driveToValidation();
    await callOk(run_check, { kind: 'typecheck' });

    const sd = await getSessDir();
    const state = await readState(sd);
    expect(state).not.toBeNull();
    expect(state!.validation.length).toBe(1);
    const [validation] = state!.validation;
    expect(validation).toBeDefined();
    expect(validation!.checkId).toBe('typecheck');
    expect(validation!.passed).toBe(true);
    expect(validation!.outputDigest).toBe('a'.repeat(64));
  });

  it('advances to IMPLEMENTATION when all active checks pass', async () => {
    await driveToValidation();
    // Discovery detects TypeScript → activeChecks=['typecheck']
    const sd = await getSessDir();
    const state = await readState(sd);
    expect(state!.activeChecks).toContain('typecheck');

    // Pass the check
    await callOk(run_check, { kind: 'typecheck' });

    const finalState = await readState(sd);
    expect(finalState!.phase).toBe('IMPLEMENTATION');
  });

  it('calls executeCheck with correct arguments', async () => {
    await driveToValidation();
    await callOk(run_check, { kind: 'typecheck' });

    expect(executeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'typecheck',
        command: expect.any(String),
        cwd: ws.tmpDir,
      }),
    );
  });
});

// ─── BAD ─────────────────────────────────────────────────────────────────────

describe('BAD', () => {
  it('blocks in wrong phase (TICKET)', async () => {
    await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
    await callOk(ticket, { text: 'Test', source: 'user' });
    const result = parseToolResult(await run_check.execute({ kind: 'typecheck' }, ctx));

    expect(result.error).toBe(true);
    expect(result.code).toBe('COMMAND_NOT_ALLOWED');
  });

  it('blocks when kind has no verificationCandidate', async () => {
    await driveToValidation();
    // 'security' is not in verificationCandidates (discovery only finds typecheck from tsconfig.json)
    const result = parseToolResult(await run_check.execute({ kind: 'security' }, ctx));

    expect(result.error).toBe(true);
    expect(result.code).toBe('CHECK_KIND_NOT_AVAILABLE');
  });

  it('blocks when check is not in activeChecks', async () => {
    await driveToValidation();
    // Manually add a verificationCandidate but don't add to activeChecks
    const sd = await getSessDir();
    const state = await readState(sd);
    const patchedState = {
      ...state!,
      verificationCandidates: [
        ...(state!.verificationCandidates ?? []),
        {
          kind: 'security' as const,
          command: 'npm audit',
          source: 'manual',
          confidence: 'low' as const,
          reason: 'manual',
        },
      ],
      // activeChecks does NOT include 'security'
    };
    await writeState(sd, patchedState);

    const result = parseToolResult(await run_check.execute({ kind: 'security' }, ctx));
    expect(result.error).toBe(true);
    expect(result.code).toBe('CHECK_NOT_ACTIVE');
  });

  it('blocks empty activeChecks under required policy with VALIDATION_EVIDENCE_UNVERIFIED (#400)', async () => {
    await driveToValidation();
    // Force empty active checks + required enforcement, with untrustworthy discovery
    // (solo hydrate leaves discoveryHealth off / no clear health gate).
    const sd = await getSessDir();
    const state = await readState(sd);
    await writeState(sd, {
      ...state!,
      activeChecks: [],
      policySnapshot: {
        ...state!.policySnapshot,
        validationEvidence: { enforcement: 'required', allowNoCommands: false },
      },
    });

    const result = parseToolResult<RunCheckResult>(
      await run_check.execute({ kind: 'typecheck' }, ctx),
    );
    expect(result.error).toBe(true);
    expect(result.code).toBe('VALIDATION_EVIDENCE_UNVERIFIED');
  });

  it('blocks empty activeChecks with NO_ACTIVE_CHECKS when enforcement is off (#400)', async () => {
    await driveToValidation();
    const sd = await getSessDir();
    const state = await readState(sd);
    await writeState(sd, {
      ...state!,
      activeChecks: [],
      policySnapshot: {
        ...state!.policySnapshot,
        validationEvidence: { enforcement: 'off', allowNoCommands: false },
      },
    });

    const result = parseToolResult(await run_check.execute({ kind: 'typecheck' }, ctx));
    expect(result.error).toBe(true);
    expect(result.code).toBe('NO_ACTIVE_CHECKS');
  });
});

// ─── CORNER ──────────────────────────────────────────────────────────────────

describe('CORNER', () => {
  it('replaces existing result for same checkId on re-run', async () => {
    await driveToValidation();

    // Pre-seed a failed validation result in state (simulating a prior failed run
    // where the session was manually patched back to VALIDATION for re-try)
    const sd = await getSessDir();
    const state = await readState(sd);
    const patchedState = {
      ...state!,
      validation: [
        {
          checkId: 'typecheck',
          passed: false,
          detail: 'Failed (exit 1)',
          executedAt: '2026-01-01T00:00:00.000Z',
          kind: 'typecheck' as const,
          command: 'npx tsc --noEmit',
          exitCode: 1,
          executionMs: 200,
          outputDigest: 'b'.repeat(64),
          timedOut: false,
        },
      ],
    };
    await writeState(sd, patchedState);

    // Now pass it (default mock returns passed=true)
    await callOk(run_check, { kind: 'typecheck' });

    const finalState = await readState(sd);
    expect(finalState!.validation.length).toBe(1); // Replaced, not appended
    const [validation] = finalState!.validation;
    expect(validation).toBeDefined();
    expect(validation!.passed).toBe(true);
    expect(validation!.outputDigest).toBe('a'.repeat(64));
  });

  it('records failed check without advancing phase', async () => {
    await driveToValidation();

    vi.mocked(executeCheck).mockResolvedValueOnce({
      kind: 'typecheck',
      command: 'npx tsc --noEmit',
      exitCode: 1,
      passed: false,
      executionMs: 800,
      outputDigest: 'c'.repeat(64),
      stdout: 'error TS2345: Argument...',
      stderr: '',
      timedOut: false,
      startedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = parseToolResult<RunCheckResult>(
      await run_check.execute({ kind: 'typecheck' }, ctx),
    );
    expect(result.evidence.passed).toBe(false);
    expect(result.evidence.exitCode).toBe(1);
    expect(result.derivedRepairGuidance).toBeDefined();
    if (result.derivedRepairGuidance) {
      const rg = result.derivedRepairGuidance as Record<string, unknown>;
      expect(rg.kind).toBe('derived_repair_guidance');
      expect(rg.advisory).toBe(true);
      expect(rg.source).toBe('run_check_output');
      expect(rg.status).toBe('available');
      expect(rg.notVerified).toEqual(
        expect.arrayContaining([expect.stringContaining('NOT_VERIFIED')]),
      );
    }

    const sd = await getSessDir();
    const state = await readState(sd);
    // Phase goes to PLAN on failure (CHECK_FAILED transition)
    expect(state!.phase).toBe('PLAN');
    // Derived repair guidance is persisted
    const [validation] = state!.validation;
    expect(validation).toBeDefined();
    expect(validation!.derivedRepairGuidance).toBeDefined();
  });
});

// ─── EDGE ────────────────────────────────────────────────────────────────────

describe('EDGE', () => {
  it('timeout evidence shape is correct', async () => {
    await driveToValidation();

    vi.mocked(executeCheck).mockResolvedValueOnce({
      kind: 'typecheck',
      command: 'npx tsc --noEmit',
      exitCode: 124,
      passed: false,
      executionMs: 60000,
      outputDigest: 'd'.repeat(64),
      stdout: '',
      stderr: '',
      timedOut: true,
      startedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = parseToolResult<RunCheckResult>(
      await run_check.execute({ kind: 'typecheck' }, ctx),
    );
    expect(result.evidence.timedOut).toBe(true);
    expect(result.evidence.exitCode).toBe(124);
    expect(result.status).toContain('timed out');
    expect(result.derivedRepairGuidance).toBeDefined();
    if (result.derivedRepairGuidance) {
      const rg = result.derivedRepairGuidance as Record<string, unknown>;
      expect(rg.status).toBe('available');
      expect(rg.category).toBe('timeout');
      expect(rg.confidence).toBe('high');
    }
  });

  it('same exitCode/passed/timedOut/outputDigest with different derivedRepairGuidance does not change validation', async () => {
    await driveToValidation();

    vi.mocked(executeCheck).mockResolvedValueOnce({
      kind: 'typecheck',
      command: 'npx tsc --noEmit',
      exitCode: 1,
      passed: false,
      executionMs: 200,
      outputDigest: 'a'.repeat(64),
      stdout: 'src/x.ts(1,1): error TS2322: type mismatch',
      stderr: '',
      timedOut: false,
      startedAt: '2026-01-01T00:00:00.000Z',
    });

    const result1 = parseToolResult<RunCheckResult>(
      await run_check.execute({ kind: 'typecheck' }, ctx),
    );
    expect(result1.evidence.passed).toBe(false);
    expect(result1.evidence.exitCode).toBe(1);
    expect(result1.evidence.timedOut).toBe(false);
    expect(result1.evidence.outputDigest).toBe('a'.repeat(64));
    // Guidance exists but does not change pass/fail
    expect(result1.derivedRepairGuidance).toBeDefined();
  });

  it('returns remainingChecks showing which checks still need to pass', async () => {
    await driveToValidation();
    const sd = await getSessDir();
    const state = await readState(sd);

    // If only one active check (typecheck), after passing it remainingChecks should be empty
    if (state!.activeChecks.length === 1) {
      const result = parseToolResult(await run_check.execute({ kind: 'typecheck' }, ctx));
      expect(result.remainingChecks).toEqual([]);
    }
  });
});

// ─── CONCURRENCY — Lock Contention & Retry (#504) ─────────────────────────────

describe('CONCURRENCY', () => {
  it('LOCK_TIMEOUT_EXHAUSTED: returns BLOCKED after all retries fail', async () => {
    await driveToValidation();
    const { log, entries } = captureLogger();
    setAdapterLogger(log);

    const exhaustedError = new PersistenceError(
      'LOCK_TIMEOUT_EXHAUSTED',
      'Could not acquire session write lock after 4 attempts (10000ms timeout per attempt, 100/200/400ms delays). Last error: test contention',
    );
    vi.mocked(withSessionWriteLockRetry).mockRejectedValueOnce(exhaustedError);

    const raw = await runWithLogContextAsync({ traceId: 'trace-run-check' }, () =>
      run_check.execute({ kind: 'typecheck' }, ctx),
    );
    const result = parseToolResult(raw) as Record<string, unknown>;

    expect(result.error).toBe(true);
    expect(result.code).toBe('LOCK_TIMEOUT_EXHAUSTED');
    expect(result.message).toContain('validation_result_persistence');
    expect(result.message).toContain('3 retries');
    const exhausted = entries.find((entry) => entry.message === 'lock_exhausted');
    expect(exhausted?.extra).toMatchObject({
      sessionId: ctx.sessionID,
      checkId: 'typecheck',
      errorCode: 'LOCK_TIMEOUT_EXHAUSTED',
      causedBy: 'validation result persistence could not acquire session write lock',
      retries: 3,
      traceId: 'trace-run-check',
    });
    expect(exhausted?.extra?.traceId).toBe('trace-run-check');

    vi.mocked(withSessionWriteLockRetry).mockRestore();
  });

  it('rate-limits lock retry diagnostics to first and final retry markers', async () => {
    await driveToValidation();
    const { log, entries } = captureLogger();
    setAdapterLogger(log);

    vi.mocked(withSessionWriteLockRetry).mockImplementationOnce(
      async (_sessDir, operation, opts) => {
        const err = new PersistenceError('LOCK_TIMEOUT', 'test contention');
        opts?.onRetry?.(1, 100, err);
        opts?.onRetry?.(2, 200, err);
        opts?.onRetry?.(3, 400, err);
        return operation({ release: vi.fn().mockResolvedValue(undefined), waited: true });
      },
    );

    await runWithLogContextAsync({ traceId: 'trace-retry' }, () =>
      run_check.execute({ kind: 'typecheck' }, ctx),
    );

    const retryLogs = entries.filter(
      (entry) => entry.service === 'flowguard_run_check' && entry.level === 'warn',
    );
    expect(retryLogs.map((entry) => entry.extra?.attempt)).toEqual([1, 3]);
    for (const entry of retryLogs) {
      expect(entry.extra).toMatchObject({
        retries: 3,
        traceId: 'trace-retry',
        errorCode: 'LOCK_TIMEOUT',
        causedBy: 'session_write_lock_contention',
      });
      expect(entry.extra!.traceId).toBe('trace-retry');
      expect(JSON.stringify(entry.extra)).not.toContain('test contention');
    }

    const healthLogs = entries.filter((entry) => entry.message === 'lock_health');
    expect(healthLogs.map((entry) => entry.extra?.checkId)).toEqual(['typecheck', 'typecheck']);

    vi.mocked(withSessionWriteLockRetry).mockRestore();
  });

  it('parallel checks: all results persisted despite real lock contention (#504)', async () => {
    await driveToValidation();

    const sd = await getSessDir();
    const s = await readState(sd);
    await writeState(sd, {
      ...s!,
      activeChecks: ['typecheck', 'lint', 'test', 'build'],
      verificationCandidates: [
        ...(s!.verificationCandidates ?? []),
        {
          kind: 'lint',
          command: 'npm run lint',
          source: 'discovery' as const,
          confidence: 'high' as const,
          reason: 'test',
        },
        {
          kind: 'test',
          command: 'npm test',
          source: 'discovery' as const,
          confidence: 'high' as const,
          reason: 'test',
        },
        {
          kind: 'build',
          command: 'npm run build',
          source: 'discovery' as const,
          confidence: 'high' as const,
          reason: 'test',
        },
      ],
    });

    // Execute 4 checks in parallel — each check runs outside the lock,
    // only the persist step contends. With retry, all should succeed.
    const results = await Promise.all([
      run_check.execute({ kind: 'typecheck' }, ctx),
      run_check.execute({ kind: 'lint' }, ctx),
      run_check.execute({ kind: 'test' }, ctx),
      run_check.execute({ kind: 'build' }, ctx),
    ]);

    const parsedResults = results.map((r) => parseToolResult(r) as Record<string, unknown>);
    const errors = parsedResults.filter((r) => r.error);
    if (errors.length > 0) {
      console.error('Parallel check errors:', JSON.stringify(errors, null, 2));
    }
    expect(errors.length).toBe(0);

    const finalState = await readState(sd);
    expect(finalState!.validation.length).toBe(4);
    expect(finalState!.validation.every((v) => v.passed)).toBe(true);
    expect(finalState!.phase).toBe('IMPLEMENTATION');
  });
});

// ─── STALE STATE — Revalidation Under Lock (#504) ─────────────────────────────

describe('STALE_STATE', () => {
  it('does not persist result when session advances between check execution and lock persistence (race)', async () => {
    await driveToValidation();

    const sd = await getSessDir();
    const stateBefore = await readState(sd);

    // Hook into executeCheck: after Phase A validates but before it returns,
    // mutate state to simulate a concurrent tool call advancing the session.
    // Phase A sees VALIDATION, Phase B runs the check, Phase C re-reads
    // fresh state under lock and must block stale persistence.
    vi.mocked(executeCheck).mockImplementationOnce(async (input) => {
      // Simulate a concurrent command advancing the session past VALIDATION
      await writeState(sd, {
        ...(await readState(sd))!,
        phase: 'COMPLETE' as const,
      });
      return {
        kind: input.kind,
        command: input.command,
        exitCode: 0,
        passed: true,
        executionMs: 150,
        outputDigest: 'a'.repeat(64),
        stdout: 'All clear',
        stderr: '',
        timedOut: false,
        startedAt: '2026-01-01T00:00:00.000Z',
      };
    });

    const result = parseToolResult(await run_check.execute({ kind: 'typecheck' }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.error).toBe(true);
    // Phase C re-reads under lock, sees COMPLETE, blocks with COMMAND_NOT_ALLOWED
    expect(result.code).toBe('COMMAND_NOT_ALLOWED');

    // Sanity: state was NOT corrupted — no validation result persisted
    const afterState = await readState(sd);
    expect(afterState!.phase).toBe('COMPLETE');
    expect(afterState!.validation.length).toBe(0);

    // Restore state so beforeEach teardown can clean up
    await writeState(sd, stateBefore!);
  });

  it('does not persist result when activeChecks cleared during check execution (race)', async () => {
    await driveToValidation();

    const sd = await getSessDir();
    const stateBefore = await readState(sd);

    vi.mocked(executeCheck).mockImplementationOnce(async (input) => {
      // Simulate activeChecks being cleared mid-flight
      await writeState(sd, {
        ...(await readState(sd))!,
        activeChecks: [],
      });
      return {
        kind: input.kind,
        command: input.command,
        exitCode: 0,
        passed: true,
        executionMs: 150,
        outputDigest: 'a'.repeat(64),
        stdout: 'All clear',
        stderr: '',
        timedOut: false,
        startedAt: '2026-01-01T00:00:00.000Z',
      };
    });

    const result = parseToolResult(await run_check.execute({ kind: 'typecheck' }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.error).toBe(true);
    // Phase C re-reads under lock, sees empty activeChecks, blocks
    expect(result.code).toBe('NO_ACTIVE_CHECKS');

    const afterState = await readState(sd);
    expect(afterState!.validation.length).toBe(0);

    await writeState(sd, stateBefore!);
  });
});
