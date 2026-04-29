/**
 * @module integration/policy-matrix.test
 * @description Policy Mode Matrix Integration Suite (T2).
 *
 * Proves policy modes produce different operational decisions where governance
 * semantics differ and identical decisions where global invariants apply.
 *
 * Matrix: 5 scenarios x 4 modes = 20 explicit cells.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
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
import { status, hydrate, ticket, plan, decision, validate } from './tools/index.js';
import { readAuditTrail, readState, writeState } from '../adapters/persistence.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import { verifyChain } from '../audit/integrity.js';

type Mode = 'solo' | 'team' | 'team-ci' | 'regulated';
type CellResult = { allowed: boolean; code?: string; phase?: string; detail?: string };

const MODES: Mode[] = ['solo', 'team', 'team-ci', 'regulated'];

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
      id: 'matrix-actor',
      email: 'matrix@policy.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'claim_validated' as const,
    }),
  };
});

const actorMock = await import('../adapters/actor.js');

let ws: TestWorkspace;
let previousCI: string | undefined;

beforeEach(async () => {
  previousCI = process.env.CI;
  ws = await createTestWorkspace();
});

afterEach(async () => {
  vi.mocked(actorMock.resolveActor)
    .mockReset()
    .mockResolvedValue({
      id: 'matrix-actor',
      email: 'matrix@policy.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'claim_validated' as const,
    });
  vi.clearAllMocks();
  if (previousCI === undefined) delete process.env.CI;
  else process.env.CI = previousCI;
  await ws.cleanup();
});

function contextFor(mode: Mode): TestToolContext {
  return createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${mode.replace('-', '_')}_${crypto.randomUUID().replace(/-/g, '')}`,
  });
}

async function callOk(
  tool: { execute: (args: unknown, context: TestToolContext) => Promise<string> },
  args: unknown,
  ctx: TestToolContext,
): Promise<Record<string, unknown>> {
  const finalArgs = await withStrictReviewFindings(await sessionDir(ctx), args);
  const result = parseToolResult(await tool.execute(finalArgs, ctx));
  if (result.error) {
    throw new Error(`Tool returned error: ${result.code} - ${result.message}`);
  }
  return result;
}

async function callResult(
  tool: { execute: (args: unknown, context: TestToolContext) => Promise<string> },
  args: unknown,
  ctx: TestToolContext,
): Promise<CellResult> {
  const result = parseToolResult(await tool.execute(args, ctx));
  return {
    allowed: result.error !== true,
    code: result.code as string | undefined,
    phase: result.phase as string | undefined,
    detail: (result.message ?? result.status) as string | undefined,
  };
}

async function currentPhase(ctx: TestToolContext): Promise<string> {
  return parseToolResult(await status.execute({}, ctx)).phase as string;
}

async function sessionDir(ctx: TestToolContext): Promise<string> {
  const fp = await computeFingerprint(ctx.worktree);
  return resolveSessionDir(fp.fingerprint, ctx.sessionID);
}

async function hydrateMode(mode: Mode, ctx: TestToolContext): Promise<void> {
  if (mode === 'team-ci') process.env.CI = '1';
  await callOk(hydrate, { policyMode: mode, profileId: 'baseline' }, ctx);
}

async function drivePastPlan(mode: Mode, ctx: TestToolContext): Promise<string> {
  await hydrateMode(mode, ctx);
  await callOk(ticket, { text: `${mode} matrix task`, source: 'user' }, ctx);
  await callOk(plan, { planText: '## Plan\nTest matrix policy behavior.' }, ctx);
  for (let i = 0; i < 5; i++) {
    const phase = await currentPhase(ctx);
    if (phase === 'PLAN_REVIEW' || phase === 'VALIDATION') return phase;
    await callOk(plan, { selfReviewVerdict: 'approve' }, ctx);
  }
  return currentPhase(ctx);
}

async function scenarioSameActorApproval(mode: Mode): Promise<CellResult> {
  const ctx = contextFor(mode);
  vi.mocked(actorMock.resolveActor).mockResolvedValue({
    id: `same-${mode}`,
    email: `${mode}@policy.dev`,
    displayName: null,
    source: 'env' as const,
    assurance: 'claim_validated' as const,
  });
  const phase = await drivePastPlan(mode, ctx);
  if (phase !== 'PLAN_REVIEW') return { allowed: true, phase, detail: 'auto_approved' };
  return callResult(decision, { verdict: 'approve', rationale: 'Same actor approval' }, ctx);
}

async function scenarioDifferentActorApproval(mode: Mode): Promise<CellResult> {
  const ctx = contextFor(mode);
  vi.mocked(actorMock.resolveActor).mockResolvedValue({
    id: `initiator-${mode}`,
    email: `initiator-${mode}@policy.dev`,
    displayName: null,
    source: 'env' as const,
    assurance: 'claim_validated' as const,
  });
  const phase = await drivePastPlan(mode, ctx);
  if (phase !== 'PLAN_REVIEW') return { allowed: true, phase, detail: 'auto_approved' };
  vi.mocked(actorMock.resolveActor).mockResolvedValue({
    id: `reviewer-${mode}`,
    email: `reviewer-${mode}@policy.dev`,
    displayName: null,
    source: 'claim' as const,
    assurance: 'claim_validated' as const,
  });
  return callResult(decision, { verdict: 'approve', rationale: 'Different actor approval' }, ctx);
}

async function scenarioLowAssuranceApproval(mode: Mode): Promise<CellResult> {
  const ctx = contextFor(mode);
  vi.mocked(actorMock.resolveActor).mockResolvedValue({
    id: `initiator-low-${mode}`,
    email: `initiator-low-${mode}@policy.dev`,
    displayName: null,
    source: 'env' as const,
    assurance: 'claim_validated' as const,
  });
  const phase = await drivePastPlan(mode, ctx);
  if (phase !== 'PLAN_REVIEW') return { allowed: true, phase, detail: 'auto_approved' };

  if (mode === 'regulated') {
    const dir = await sessionDir(ctx);
    const state = await readState(dir);
    await writeState(dir, {
      ...state!,
      policySnapshot: {
        ...state!.policySnapshot,
        minimumActorAssuranceForApproval: 'claim_validated',
      },
    });
  }

  vi.mocked(actorMock.resolveActor).mockResolvedValue({
    id: `low-assurance-${mode}`,
    email: `low-assurance-${mode}@policy.dev`,
    displayName: null,
    source: 'env' as const,
    assurance: 'best_effort' as const,
  });
  return callResult(decision, { verdict: 'approve', rationale: 'Low assurance approval' }, ctx);
}

async function scenarioMissingValidationEvidence(mode: Mode): Promise<CellResult> {
  const ctx = contextFor(mode);
  const phase = await drivePastPlan(mode, ctx);
  if (phase === 'PLAN_REVIEW') {
    vi.mocked(actorMock.resolveActor).mockResolvedValue({
      id: `reviewer-validation-${mode}`,
      email: `reviewer-validation-${mode}@policy.dev`,
      displayName: null,
      source: 'claim' as const,
      assurance: 'claim_validated' as const,
    });
    await callOk(decision, { verdict: 'approve', rationale: 'Move to validation' }, ctx);
  }
  return callResult(
    validate,
    { results: [{ checkId: 'test_quality', passed: true, detail: 'Missing rollback check' }] },
    ctx,
  );
}

async function scenarioLegacyAuditStrictness(mode: Mode): Promise<CellResult> {
  const ctx = contextFor(mode);
  await hydrateMode(mode, ctx);
  const dir = await sessionDir(ctx);
  const legacyEvent = {
    id: crypto.randomUUID(),
    sessionId: ctx.sessionID,
    phase: 'READY',
    event: 'legacy_event',
    timestamp: new Date().toISOString(),
    actor: 'legacy',
    detail: { source: 'policy-matrix' },
  };
  await fs.appendFile(path.join(dir, 'audit.jsonl'), `${JSON.stringify(legacyEvent)}\n`, 'utf-8');
  const { events } = await readAuditTrail(dir);
  const result = verifyChain(events as unknown as Array<Record<string, unknown>>, {
    strict: mode === 'regulated',
  });
  return {
    allowed: result.valid,
    code: result.valid ? undefined : result.reason,
    phase: await currentPhase(ctx),
  };
}

const MATRIX: Array<{
  scenario: string;
  run: (mode: Mode) => Promise<CellResult>;
  expected: Record<Mode, { allowed: boolean; code?: string; phase?: string }>;
}> = [
  {
    scenario: 'same_actor_approval',
    run: scenarioSameActorApproval,
    expected: {
      solo: { allowed: true, phase: 'VALIDATION' },
      team: { allowed: true, phase: 'VALIDATION' },
      'team-ci': { allowed: true, phase: 'VALIDATION' },
      regulated: { allowed: false, code: 'FOUR_EYES_ACTOR_MATCH' },
    },
  },
  {
    scenario: 'different_actor_approval',
    run: scenarioDifferentActorApproval,
    expected: {
      solo: { allowed: true, phase: 'VALIDATION' },
      team: { allowed: true, phase: 'VALIDATION' },
      'team-ci': { allowed: true, phase: 'VALIDATION' },
      regulated: { allowed: true, phase: 'VALIDATION' },
    },
  },
  {
    scenario: 'low_assurance_approval',
    run: scenarioLowAssuranceApproval,
    expected: {
      solo: { allowed: true, phase: 'VALIDATION' },
      team: { allowed: true, phase: 'VALIDATION' },
      'team-ci': { allowed: true, phase: 'VALIDATION' },
      regulated: { allowed: false, code: 'ACTOR_ASSURANCE_INSUFFICIENT' },
    },
  },
  {
    scenario: 'missing_validation_evidence',
    run: scenarioMissingValidationEvidence,
    expected: {
      solo: { allowed: false, code: 'MISSING_CHECKS' },
      team: { allowed: false, code: 'MISSING_CHECKS' },
      'team-ci': { allowed: false, code: 'MISSING_CHECKS' },
      regulated: { allowed: false, code: 'MISSING_CHECKS' },
    },
  },
  {
    scenario: 'legacy_audit_strictness',
    run: scenarioLegacyAuditStrictness,
    expected: {
      solo: { allowed: true, phase: 'READY' },
      team: { allowed: true, phase: 'READY' },
      'team-ci': { allowed: true, phase: 'READY' },
      regulated: { allowed: false, code: 'LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE' },
    },
  },
];

describe('policy mode matrix', () => {
  for (const testCase of MATRIX) {
    for (const mode of MODES) {
      it(`${testCase.scenario} / ${mode}`, async () => {
        const actual = await testCase.run(mode);
        const expected = testCase.expected[mode];

        expect(actual.allowed).toBe(expected.allowed);
        if (expected.code) expect(actual.code).toBe(expected.code);
        if (expected.phase) expect(actual.phase).toBe(expected.phase);
      });
    }
  }
});
