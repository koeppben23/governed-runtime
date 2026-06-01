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
  await ws.cleanup();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function callOk(
  tool: { execute: (args: unknown, ctx: TestToolContext) => Promise<string> },
  args: unknown,
) {
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
  await callOk(plan, { reviewVerdict: 'approve' });
  // Now should be in VALIDATION phase
}

// ─── HAPPY ───────────────────────────────────────────────────────────────────

describe('HAPPY', () => {
  it('executes check and returns evidence', async () => {
    await driveToValidation();
    const result = parseToolResult(await run_check.execute({ kind: 'typecheck' }, ctx));

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
    expect(state!.validation[0].checkId).toBe('typecheck');
    expect(state!.validation[0].passed).toBe(true);
    expect(state!.validation[0].outputDigest).toBe('a'.repeat(64));
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
          kind: 'security',
          command: 'npm audit',
          source: 'manual',
          confidence: 'low',
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

    const result = parseToolResult(await run_check.execute({ kind: 'typecheck' }, ctx));
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
    expect(finalState!.validation[0].passed).toBe(true);
    expect(finalState!.validation[0].outputDigest).toBe('a'.repeat(64));
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

    const result = parseToolResult(await run_check.execute({ kind: 'typecheck' }, ctx));
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
    expect(state!.validation[0].derivedRepairGuidance).toBeDefined();
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

    const result = parseToolResult(await run_check.execute({ kind: 'typecheck' }, ctx));
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

    const result1 = parseToolResult(await run_check.execute({ kind: 'typecheck' }, ctx));
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
