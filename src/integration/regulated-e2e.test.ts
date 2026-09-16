/**
 * @module integration/regulated-e2e.test
 * @description Regulated Mode Critical Path Integration Suite (T1).
 *
 * Scope is intentionally narrow: prove the regulated path and its fail-closed
 * gates over real persisted session state. Archive mechanics and policy matrix
 * drift are covered by T3 and T2 respectively.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  withStrictReviewFindings,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import {
  status,
  hydrate,
  ticket,
  plan,
  decision,
  run_check,
  implement,
  review_implementation,
  export as exportTool,
} from './tools/index.js';
import { readState, writeState } from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import { verifyRegulatedArchive } from '../adapters/workspace/archive-verify-chain.js';
import { verifyChain } from '../audit/integrity.js';
import { clearUserDecisionIntents, recordUserDecisionIntent } from './user-decision-intent.js';
import type { ToolDefinition } from './tools/helpers.js';

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    isGitRepo: vi.fn().mockResolvedValue(true),
    isGitRepoStrict: vi.fn().mockResolvedValue(true),
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

vi.mock('../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/actor.js')>();
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'regulated-initiator',
      email: 'initiator@regulated.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'claim_validated' as const,
    }),
  };
});

// Mock the verification executor to avoid real subprocess execution
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

const actorMock = await import('../adapters/actor.js');

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
  clearUserDecisionIntents();
  vi.mocked(actorMock.resolveActor)
    .mockReset()
    .mockResolvedValue({
      id: 'regulated-initiator',
      email: 'initiator@regulated.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'claim_validated' as const,
    });
  vi.clearAllMocks();
  await ws.cleanup();
});

async function callOk(tool: ToolDefinition, args: unknown): Promise<Record<string, unknown>> {
  const finalArgs = await withStrictReviewFindings(await sessDir(), args);
  recordDecisionIntentForTool(tool, finalArgs);
  const result = parseToolResult(await tool.execute(finalArgs, ctx));
  if (result.error) {
    throw new Error(`Tool returned error: ${result.code} - ${result.message}`);
  }
  return result;
}

async function callBlocked(tool: ToolDefinition, args: unknown): Promise<Record<string, unknown>> {
  recordDecisionIntentForTool(tool, args);
  const result = parseToolResult(await tool.execute(args, ctx));
  expect(result.error).toBe(true);
  expect(result.code).toBeDefined();
  return result;
}

function recordDecisionIntentForTool(tool: ToolDefinition, args: unknown): void {
  if (tool !== decision || typeof args !== 'object' || args === null) return;
  const verdict = (args as { verdict?: unknown }).verdict;
  if (verdict !== 'approve' && verdict !== 'changes_requested' && verdict !== 'reject') return;
  recordUserDecisionIntent({
    sessionId: ctx.sessionID,
    command: '/review-decision',
    expectedVerdict: verdict,
  });
}

async function phase(): Promise<string> {
  return (parseToolResult(await status.execute({}, ctx)).phase as string) ?? '';
}

async function sessDir(): Promise<string> {
  const fp = await computeFingerprint(ctx.worktree);
  return resolveSessionDir(fp.fingerprint, ctx.sessionID);
}

async function bootstrapRegulatedPlanReview(): Promise<void> {
  await callOk(hydrate, { policyMode: 'regulated', profileId: 'baseline' });
  await callOk(ticket, { text: 'Regulated task', source: 'user' });
  await callOk(plan, {
    planText: '## Plan\nImplement the task with tests.',
    targetPaths: ['docs/test.md'],
  });
  for (let i = 0; i < 4 && (await phase()) !== 'PLAN_REVIEW'; i++) {
    await callOk(plan, { reviewVerdict: 'accept' });
  }
  expect(await phase()).toBe('PLAN_REVIEW');
}

async function approveWithReviewer(id = 'regulated-reviewer'): Promise<void> {
  vi.mocked(actorMock.resolveActor).mockResolvedValue({
    id,
    email: `${id}@regulated.dev`,
    displayName: null,
    source: 'claim' as const,
    assurance: 'claim_validated' as const,
  });
  await callOk(decision, { verdict: 'approve', rationale: 'Approved by separate actor' });
}

async function driveToEvidenceReview(): Promise<void> {
  await approveWithReviewer('plan-reviewer');
  // Approval enters VALIDATION and the runtime runs the active checks
  // automatically (discovery detects TypeScript → activeChecks=['typecheck']),
  // advancing to IMPLEMENTATION.
  expect(await phase()).toBe('IMPLEMENTATION');
  const postValidation = await readState(await sessDir());
  expect(postValidation!.validation.length).toBeGreaterThan(0);

  await callOk(implement, {});
  // Entering IMPL_VALIDATION runs the checks automatically against the
  // recorded revision before advancing to IMPL_REVIEW.
  expect(await phase()).toBe('IMPL_REVIEW');
  const postImplValidation = await readState(await sessDir());
  expect(postImplValidation!.implValidation.length).toBeGreaterThan(0);

  for (let i = 0; i < 8 && (await phase()) !== 'EVIDENCE_REVIEW'; i++) {
    await callOk(review_implementation, { reviewVerdict: 'accept' });
  }
  expect(await phase()).toBe('EVIDENCE_REVIEW');
}

describe('regulated-e2e critical path', () => {
  it('completes regulated lifecycle with different approving actor and archive status recorded', async () => {
    await bootstrapRegulatedPlanReview();
    await driveToEvidenceReview();
    await approveWithReviewer('evidence-reviewer');

    expect(await phase()).toBe('EXPORT_READY');
    const exportResult = await callOk(exportTool, {});
    expect(exportResult.phase).toBe('COMPLETE');
    expect(exportResult.archiveStatus).toBe('verified');

    const state = await readState(await sessDir());
    expect(state?.phase).toBe('COMPLETE');
    expect(state?.policySnapshot.mode).toBe('regulated');
    expect(state?.regulatedArchiveStatus).toBe('verified');
    expect(state?.exportCompletionEvidence).not.toBeNull();
    const events = (await readAuditTrail(await sessDir())).events;
    const approvalTransitionIndex = events.findIndex(
      (event) =>
        event.detail.kind === 'transition' &&
        event.detail.from === 'EVIDENCE_REVIEW' &&
        event.detail.to === 'EXPORT_READY' &&
        event.detail.event === 'APPROVE',
    );
    const exportTransitionIndex = events.findIndex(
      (event) =>
        event.detail.kind === 'transition' &&
        event.detail.from === 'EXPORT_READY' &&
        event.detail.to === 'COMPLETE' &&
        event.detail.event === 'EXPORT_MATERIALIZED',
    );
    const decisionIndex = events.findIndex(
      (event) =>
        event.detail.kind === 'decision' &&
        event.detail.fromPhase === 'EVIDENCE_REVIEW' &&
        event.detail.toPhase === 'EXPORT_READY',
    );
    const lifecycleIndex = events.findIndex(
      (event) => event.event === 'lifecycle:session_completed',
    );
    expect(approvalTransitionIndex).toBeGreaterThanOrEqual(0);
    expect(exportTransitionIndex).toBeGreaterThan(approvalTransitionIndex);
    expect(decisionIndex).toBeGreaterThan(approvalTransitionIndex);
    expect(lifecycleIndex).toBeGreaterThan(decisionIndex);
    expect(lifecycleIndex).toBeGreaterThan(exportTransitionIndex);
    const fingerprint = await computeFingerprint(ctx.worktree);
    expect((await verifyRegulatedArchive(fingerprint.fingerprint, ctx.sessionID)).passed).toBe(
      true,
    );
  });

  it('blocks same actor approval with FOUR_EYES_ACTOR_MATCH', async () => {
    await bootstrapRegulatedPlanReview();

    const result = await callBlocked(decision, { verdict: 'approve', rationale: 'Self approval' });
    expect(result.code).toBe('FOUR_EYES_ACTOR_MATCH');
    expect(await phase()).toBe('PLAN_REVIEW');
  });

  it('blocks legacy regulated sessions without decision identity', async () => {
    await bootstrapRegulatedPlanReview();

    const dir = await sessDir();
    const state = await readState(dir);
    await writeState(dir, { ...state!, initiatedByIdentity: undefined });

    const result = await callBlocked(decision, { verdict: 'approve', rationale: 'Legacy session' });
    expect(result.code).toBe('DECISION_IDENTITY_REQUIRED');
    expect(await phase()).toBe('PLAN_REVIEW');
  });

  it('blocks unknown reviewer identity with REGULATED_ACTOR_UNKNOWN', async () => {
    await bootstrapRegulatedPlanReview();
    vi.mocked(actorMock.resolveActor).mockResolvedValue({
      id: 'unknown-reviewer',
      email: null,
      displayName: null,
      source: 'unknown' as const,
      assurance: 'best_effort' as const,
    });

    const result = await callBlocked(decision, { verdict: 'approve', rationale: 'Unknown actor' });
    expect(result.code).toBe('REGULATED_ACTOR_UNKNOWN');
    expect(await phase()).toBe('PLAN_REVIEW');
  });

  it('blocks run_check for a kind not in verificationCandidates', async () => {
    await bootstrapRegulatedPlanReview();
    await approveWithReviewer();
    // Reset the validation projection to the pending wait state so the explicit
    // run_check compatibility surface is gated directly (automatic validation
    // already advanced to IMPLEMENTATION).
    const dir = await sessDir();
    const state = await readState(dir);
    const patched = {
      ...state!,
      phase: 'VALIDATION' as const,
      validation: [],
      validationAttempts: [],
      implementation: null,
    };
    delete (patched as { implementationBaseAuthority?: unknown }).implementationBaseAuthority;
    await writeState(dir, patched);

    const result = await callBlocked(run_check, { kind: 'security' });
    expect(result.code).toBe('CHECK_KIND_NOT_AVAILABLE');
    expect(await phase()).toBe('VALIDATION');
  });

  it('audit verification rejects non-v3 unchained records in every mode', async () => {
    await callOk(hydrate, { policyMode: 'regulated', profileId: 'baseline' });
    const dir = await sessDir();
    const legacyEvent = {
      id: crypto.randomUUID(),
      sessionId: ctx.sessionID,
      phase: 'READY',
      event: 'non_v3_event',
      occurredAt: new Date().toISOString(),
      actor: 'legacy',
      detail: { source: 'test' },
    };
    await fs.appendFile(path.join(dir, 'audit.jsonl'), `${JSON.stringify(legacyEvent)}\n`, 'utf-8');

    // The epoch reader itself rejects the non-v3 record.
    await expect(readAuditTrail(dir)).rejects.toMatchObject({
      code: 'AUDIT_ENVELOPE_INVALID',
    });

    // Verification over raw lines also fails closed.
    const raw = await fs.readFile(path.join(dir, 'audit.jsonl'), 'utf-8');
    const events = raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const result = verifyChain(events);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('AUDIT_ENVELOPE_INVALID');
  });
});
