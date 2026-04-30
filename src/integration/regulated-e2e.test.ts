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
import { status, hydrate, ticket, plan, decision, validate, implement } from './tools/index.js';
import { readAuditTrail, readState, writeState } from '../adapters/persistence.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import { verifyChain } from '../audit/integrity.js';

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
      id: 'regulated-initiator',
      email: 'initiator@regulated.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'claim_validated' as const,
    }),
  };
});

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

async function callOk(
  tool: { execute: (args: unknown, context: TestToolContext) => Promise<string> },
  args: unknown,
): Promise<Record<string, unknown>> {
  const finalArgs = await withStrictReviewFindings(await sessDir(), args);
  const result = parseToolResult(await tool.execute(finalArgs, ctx));
  if (result.error) {
    throw new Error(`Tool returned error: ${result.code} - ${result.message}`);
  }
  return result;
}

async function callBlocked(
  tool: { execute: (args: unknown, context: TestToolContext) => Promise<string> },
  args: unknown,
): Promise<Record<string, unknown>> {
  const result = parseToolResult(await tool.execute(args, ctx));
  expect(result.error).toBe(true);
  expect(result.code).toBeDefined();
  return result;
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
  await callOk(plan, { planText: '## Plan\nImplement the task with tests.' });
  for (let i = 0; i < 4 && (await phase()) !== 'PLAN_REVIEW'; i++) {
    await callOk(plan, { selfReviewVerdict: 'approve' });
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
  expect(await phase()).toBe('VALIDATION');
  await callOk(validate, {
    results: [
      { checkId: 'test_quality', passed: true, detail: 'OK' },
      { checkId: 'rollback_safety', passed: true, detail: 'OK' },
    ],
  });
  await callOk(implement, {});
  for (let i = 0; i < 8 && (await phase()) !== 'EVIDENCE_REVIEW'; i++) {
    await callOk(implement, { reviewVerdict: 'approve' });
  }
  expect(await phase()).toBe('EVIDENCE_REVIEW');
}

describe('regulated-e2e critical path', () => {
  it('completes regulated lifecycle with different approving actor and archive status recorded', async () => {
    await bootstrapRegulatedPlanReview();
    await driveToEvidenceReview();
    await approveWithReviewer('evidence-reviewer');

    expect(await phase()).toBe('COMPLETE');
    const state = await readState(await sessDir());
    expect(state?.phase).toBe('COMPLETE');
    expect(state?.policySnapshot.mode).toBe('regulated');
    expect(state?.archiveStatus).toBeDefined();
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

  it('blocks progression when required validation evidence is missing', async () => {
    await bootstrapRegulatedPlanReview();
    await approveWithReviewer();

    const result = await callBlocked(validate, {
      results: [{ checkId: 'test_quality', passed: true, detail: 'Only one check supplied' }],
    });
    expect(result.code).toBe('MISSING_CHECKS');
    expect(await phase()).toBe('VALIDATION');
  });

  it('strict regulated audit verification rejects legacy unchained events', async () => {
    await callOk(hydrate, { policyMode: 'regulated', profileId: 'baseline' });
    const dir = await sessDir();
    const legacyEvent = {
      id: crypto.randomUUID(),
      sessionId: ctx.sessionID,
      phase: 'READY',
      event: 'legacy_event',
      timestamp: new Date().toISOString(),
      actor: 'legacy',
      detail: { source: 'test' },
    };
    await fs.appendFile(path.join(dir, 'audit.jsonl'), `${JSON.stringify(legacyEvent)}\n`, 'utf-8');

    const { events } = await readAuditTrail(dir);
    const result = verifyChain(events as unknown as Array<Record<string, unknown>>, {
      strict: true,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE');
  });
});
