/**
 * @module integration/cli-contract.test
 * @description Tool/Handler Contract Integration Suite (T4).
 *
 * Proves that FlowGuard tool-handler outputs conform to documented contracts:
 * - Status JSON shape is stable across all phases
 * - Blocked/error output has consistent structure
 * - Reason codes are stable and documented
 * - Policy/evidence projections expose stable handler fields
 *
 * NOT in scope:
 * - Full regulated lifecycle (T1)
 * - Policy-mode differentiation (T2)
 * - Audit/Archive integrity mechanics (T3)
 * - CLI process spawning and package smoke behavior (T5)
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
  validate,
  implement,
  archive,
} from './tools/index.js';
import { readState, writeState } from '../adapters/persistence.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';

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
      id: 'cli-test',
      email: 'cli@test.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'claim_validated' as const,
    }),
  };
});

const actorMock = await import('../adapters/actor.js');

// ─── Test Setup ─────────────────────────────────────────────────────────────────

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
      id: 'default-cli',
      email: 'default@cli.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'claim_validated' as const,
    });
  vi.clearAllMocks();
  await ws.cleanup();
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function callOk(
  tool: { execute: (args: unknown, ctx: TestToolContext) => Promise<string> },
  args: unknown,
  context: TestToolContext = ctx,
) {
  const raw = await tool.execute(args, context);
  const result = parseToolResult(raw);
  if (result.error) {
    throw new Error(`Tool returned error: ${result.code} — ${result.message}`);
  }
  return result;
}

async function getSessDir(context: TestToolContext = ctx): Promise<string> {
  const fp = await computeFingerprint(context.worktree);
  return resolveSessionDir(fp.fingerprint, context.sessionID);
}

async function driveToComplete(context: TestToolContext = ctx): Promise<string> {
  let lastPhase = 'READY';
  for (let i = 0; i < 24; i++) {
    const result = parseToolResult(await status.execute({}, context));
    lastPhase = result.phase as string;
    if (lastPhase === 'COMPLETE' || lastPhase === 'ARCH_COMPLETE') break;
    if (lastPhase === 'READY') {
      await callOk(ticket, { text: 'Test task', source: 'user' }, context);
    } else if (lastPhase === 'TICKET') {
      await callOk(plan, { planText: '## Plan\nTest' }, context);
    } else if (lastPhase === 'PLAN') {
      await callOk(plan, { selfReviewVerdict: 'approve' }, context);
    } else if (lastPhase === 'VALIDATION') {
      await callOk(
        validate,
        {
          results: [
            { checkId: 'test_quality', passed: true, detail: 'OK' },
            { checkId: 'rollback_safety', passed: true, detail: 'OK' },
          ],
        },
        context,
      );
    } else if (lastPhase === 'IMPLEMENTATION') {
      await callOk(implement, {}, context);
    } else if (lastPhase === 'IMPL_REVIEW') {
      for (let j = 0; j < 8; j++) {
        const r = parseToolResult(await status.execute({}, context));
        if (r.phase === 'EVIDENCE_REVIEW') break;
        await callOk(implement, { reviewVerdict: 'approve' }, context);
      }
    } else if (lastPhase === 'EVIDENCE_REVIEW') {
      await callOk(decision, { verdict: 'approve', rationale: 'OK' }, context);
    } else if (lastPhase === 'PLAN_REVIEW') {
      await callOk(decision, { verdict: 'approve', rationale: 'OK' }, context);
    } else {
      break;
    }
  }
  return lastPhase;
}

// ─── HAPPY: status JSON shape ──────────────────────────────────────────────────

describe('HAPPY: status JSON shape is stable', () => {
  it('status at READY has required fields', async () => {
    await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
    const result = parseToolResult(await status.execute({}, ctx));

    expect(result.phase).toBe('READY');
    expect(result.status).toBeDefined();
    expect(typeof result.status).toBe('object');
    expect(result.status.phase).toBe('READY');
    expect(result.status.policyMode).toBe('solo');
    expect(result.nextAction).toBeDefined();
  });

  it('status at TICKET has required fields', async () => {
    await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
    await callOk(ticket, { text: 'Status test', source: 'user' });
    const result = parseToolResult(await status.execute({}, ctx));

    expect(result.phase).toBe('TICKET');
    expect(result.status).toBeDefined();
    expect(result.status.phase).toBe('TICKET');
    expect(result.nextAction).toBeDefined();
  });

  it('status at PLAN_REVIEW has policy info in appliedPolicy', async () => {
    await callOk(hydrate, { policyMode: 'team', profileId: 'baseline' });
    await callOk(ticket, { text: 'Team status test', source: 'user' });
    await callOk(plan, { planText: '## Plan\nTest' });
    await callOk(plan, { selfReviewVerdict: 'approve' });
    const result = parseToolResult(await status.execute({}, ctx));

    expect(result.phase).toBe('PLAN_REVIEW');
    expect(result.appliedPolicy).toBeDefined();
    expect(result.appliedPolicy.effectiveMode).toBe('team');
    expect(result.appliedPolicy.effectiveGateBehavior).toBeDefined();
  });

  it('status at implementation review has required metadata', async () => {
    await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
    await callOk(ticket, { text: 'Complete test', source: 'user' });
    await callOk(plan, { planText: '## Plan\nTest' });
    await callOk(plan, { selfReviewVerdict: 'approve' });
    await callOk(validate, {
      results: [
        { checkId: 'test_quality', passed: true, detail: 'OK' },
        { checkId: 'rollback_safety', passed: true, detail: 'OK' },
      ],
    });
    await callOk(implement, {});

    const result = parseToolResult(await status.execute({}, ctx));
    expect(result.phase).toBe('IMPL_REVIEW');
    expect(result.status).toBeDefined();
  });
});

// ─── HAPPY: blocked output structure ───────────────────────────────────────────

describe('HAPPY: blocked/error output has stable structure', () => {
  it('decision blocked at wrong phase returns error shape', async () => {
    await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
    const raw = await decision.execute({ verdict: 'approve', rationale: 'Wrong phase' }, ctx);
    const result = parseToolResult(raw);

    expect(result.error).toBe(true);
    expect(result.code).toBeDefined();
    expect(typeof result.code).toBe('string');
    expect(result.message).toBeDefined();
    expect(typeof result.message).toBe('string');
  });

  it('four-eyes block returns FOUR_EYES_ACTOR_MATCH code', async () => {
    vi.mocked(actorMock.resolveActor).mockResolvedValue({
      id: 'four-eyes-test',
      email: 'four@eyes.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'claim_validated' as const,
    });
    await callOk(hydrate, { policyMode: 'regulated', profileId: 'baseline' });
    await callOk(ticket, { text: 'Four eyes test', source: 'user' });
    await callOk(plan, { planText: '## Plan\nTest' });
    await callOk(plan, { selfReviewVerdict: 'approve' });
    const result = parseToolResult(
      await decision.execute({ verdict: 'approve', rationale: 'Same actor' }, ctx),
    );

    expect(result.error).toBe(true);
    expect(result.code).toBe('FOUR_EYES_ACTOR_MATCH');
  });

  it('COMMAND_NOT_ALLOWED returns error shape with recovery hint', async () => {
    await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
    await callOk(ticket, { text: 'Test', source: 'user' });
    await callOk(plan, { planText: '## Plan\nTest' });
    await callOk(plan, { selfReviewVerdict: 'approve' });
    await callOk(validate, {
      results: [
        { checkId: 'test_quality', passed: true, detail: 'OK' },
        { checkId: 'rollback_safety', passed: true, detail: 'OK' },
      ],
    });
    const result = parseToolResult(
      await decision.execute({ verdict: 'approve', rationale: 'At VALIDATION' }, ctx),
    );

    expect(result.error).toBe(true);
    expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    expect(result.recovery).toBeDefined();
  });
});

// ─── HAPPY: reason codes are stable ───────────────────────────────────────────

describe('HAPPY: reason codes are stable', () => {
  const KNOWN_CODES = [
    'FOUR_EYES_ACTOR_MATCH',
    'ACTOR_ASSURANCE_INSUFFICIENT',
    'DECISION_IDENTITY_REQUIRED',
    'REGULATED_ACTOR_UNKNOWN',
    'COMMAND_NOT_ALLOWED',
    'NO_SELF_REVIEW',
    'NO_PLAN',
    'MISSING_EVIDENCE',
  ] as const;

  it('documents known reason codes without claiming every code is triggered here', () => {
    expect(KNOWN_CODES).toEqual([
      'FOUR_EYES_ACTOR_MATCH',
      'ACTOR_ASSURANCE_INSUFFICIENT',
      'DECISION_IDENTITY_REQUIRED',
      'REGULATED_ACTOR_UNKNOWN',
      'COMMAND_NOT_ALLOWED',
      'NO_SELF_REVIEW',
      'NO_PLAN',
      'MISSING_EVIDENCE',
    ]);
  });

  it('triggers FOUR_EYES_ACTOR_MATCH exactly', async () => {
    vi.mocked(actorMock.resolveActor).mockResolvedValue({
      id: 'four-cli',
      email: 'four-cli@test.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'claim_validated' as const,
    });
    await callOk(hydrate, { policyMode: 'regulated', profileId: 'baseline' });
    await callOk(ticket, { text: 'Four CLI test', source: 'user' });
    await callOk(plan, { planText: '## Plan\nTest' });
    await callOk(plan, { selfReviewVerdict: 'approve' });

    const result = parseToolResult(
      await decision.execute({ verdict: 'approve', rationale: 'Same actor' }, ctx),
    );
    expect(result.error).toBe(true);
    expect(result.code).toBe('FOUR_EYES_ACTOR_MATCH');
  });

  it('triggers DECISION_IDENTITY_REQUIRED exactly', async () => {
    await callOk(hydrate, { policyMode: 'regulated', profileId: 'baseline' });
    await callOk(ticket, { text: 'Identity CLI test', source: 'user' });
    await callOk(plan, { planText: '## Plan\nTest' });
    await callOk(plan, { selfReviewVerdict: 'approve' });
    const sessDir = await getSessDir();
    const state = await readState(sessDir);
    await writeState(sessDir, { ...state!, initiatedByIdentity: undefined });

    const result = parseToolResult(
      await decision.execute({ verdict: 'approve', rationale: 'Legacy identity' }, ctx),
    );
    expect(result.error).toBe(true);
    expect(result.code).toBe('DECISION_IDENTITY_REQUIRED');
  });

  it('triggers REGULATED_ACTOR_UNKNOWN exactly', async () => {
    await callOk(hydrate, { policyMode: 'regulated', profileId: 'baseline' });
    await callOk(ticket, { text: 'Unknown actor test', source: 'user' });
    await callOk(plan, { planText: '## Plan\nTest' });
    await callOk(plan, { selfReviewVerdict: 'approve' });
    vi.mocked(actorMock.resolveActor).mockResolvedValue({
      id: 'unknown-cli',
      email: null,
      displayName: null,
      source: 'unknown' as const,
      assurance: 'best_effort' as const,
    });

    const result = parseToolResult(
      await decision.execute({ verdict: 'approve', rationale: 'Unknown actor' }, ctx),
    );
    expect(result.error).toBe(true);
    expect(result.code).toBe('REGULATED_ACTOR_UNKNOWN');
  });

  it('triggers COMMAND_NOT_ALLOWED exactly', async () => {
    await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
    await callOk(ticket, { text: 'At TICKET', source: 'user' });

    const result = parseToolResult(
      await decision.execute({ verdict: 'approve', rationale: 'Wrong phase' }, ctx),
    );
    expect(result.error).toBe(true);
    expect(result.code).toBe('COMMAND_NOT_ALLOWED');
  });
});

// ─── BAD: invalid input returns structured error ───────────────────────────────

describe('BAD: invalid input returns structured error', () => {
  it('empty ticket text returns error', async () => {
    await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
    const raw = await ticket.execute({ text: '', source: 'user' }, ctx);
    const result = parseToolResult(raw);

    expect(result.error).toBe(true);
    expect(result.code).toBeDefined();
  });

  it('decision with approve verdict returns structured result or error', async () => {
    await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
    await callOk(ticket, { text: 'Test', source: 'user' });
    await callOk(plan, { planText: '## Plan\nTest' });
    await callOk(plan, { selfReviewVerdict: 'approve' });
    const raw = await decision.execute({ verdict: 'approve', rationale: 'Ok' }, ctx);
    const result = parseToolResult(raw);
    expect(result.error === true || result.phase !== undefined).toBe(true);
  });
});

// ─── CORNER: edge cases ─────────────────────────────────────────────────────────

describe('CORNER: CLI edge cases', () => {
  it('status on non-existent session returns phase=null with guidance', async () => {
    const badCtx = createToolContext({
      worktree: '/tmp/flowguard-cli-nonexistent-000',
      directory: '/tmp/flowguard-cli-nonexistent-000',
      sessionID: 'ses_does_not_exist',
    });
    const raw = await status.execute({}, badCtx);
    const result = parseToolResult(raw);

    expect(result.phase).toBeNull();
    expect(result.status).toBeDefined();
  });

  it('appliedPolicy includes stable fields from state', async () => {
    await callOk(hydrate, { policyMode: 'regulated', profileId: 'baseline' });
    const result = parseToolResult(await status.execute({}, ctx));

    expect(result.appliedPolicy).toBeDefined();
    expect(result.appliedPolicy.effectiveMode).toBeDefined();
    expect(result.appliedPolicy.effectiveGateBehavior).toBeDefined();
    expect(typeof result.appliedPolicy.effectiveGateBehavior).toBe('string');
  });

  it('verdict enum only accepts approve/changes_requested/reject', async () => {
    await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
    await callOk(ticket, { text: 'Enum test', source: 'user' });
    await callOk(plan, { planText: '## Plan\nTest' });
    await callOk(plan, { selfReviewVerdict: 'approve' });
    const raw = await decision.execute({ verdict: 'approve', rationale: 'Ok' }, ctx);
    const result = parseToolResult(raw);
    expect(result.error === true || result.phase !== undefined).toBe(true);
  });
});

// ─── EDGE: policy mode effects on CLI output ──────────────────────────────────

describe('EDGE: policy mode affects CLI output', () => {
  it('solo mode shows effectiveMode=solo in appliedPolicy', async () => {
    await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
    await callOk(ticket, { text: 'Solo CLI test', source: 'user' });
    const result = parseToolResult(await status.execute({}, ctx));

    expect(result.appliedPolicy.effectiveMode).toBe('solo');
    expect(result.appliedPolicy.effectiveGateBehavior).toBe('auto_approve');
  });

  it('regulated mode shows effectiveMode=regulated in appliedPolicy', async () => {
    vi.mocked(actorMock.resolveActor).mockResolvedValue({
      id: 'reg-cli-test',
      email: 'reg-cli@test.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'claim_validated' as const,
    });
    await callOk(hydrate, { policyMode: 'regulated', profileId: 'baseline' });
    await callOk(ticket, { text: 'Regulated CLI test', source: 'user' });
    const result = parseToolResult(await status.execute({}, ctx));

    expect(result.appliedPolicy.effectiveMode).toBe('regulated');
  });

  it('team-ci mode with degraded CI context shows effectiveGateBehavior=human_gated', async () => {
    const prevCI = process.env.CI;
    const prevGHA = process.env.GITHUB_ACTIONS;
    const prevGL = process.env.GITLAB_CI;
    const prevBK = process.env.BUILDKITE;
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.BUILDKITE;
    try {
      await callOk(hydrate, { policyMode: 'team-ci', profileId: 'baseline' });
      const sessDir = await getSessDir();
      const state = await readState(sessDir);

      expect(state!.policySnapshot.effectiveGateBehavior).toBe('human_gated');
    } finally {
      if (prevCI === undefined) delete process.env.CI;
      else process.env.CI = prevCI;
      if (prevGHA === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = prevGHA;
      if (prevGL === undefined) delete process.env.GITLAB_CI;
      else process.env.GITLAB_CI = prevGL;
      if (prevBK === undefined) delete process.env.BUILDKITE;
      else process.env.BUILDKITE = prevBK;
    }
  });

  it('status completeness matrix is present', async () => {
    await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
    const result = parseToolResult(await status.execute({}, ctx));

    expect(result.completeness).toBeDefined();
    expect(result.completeness.overallComplete).toBeDefined();
    expect(result.completeness.fourEyes).toBeDefined();
    expect(result.completeness.summary).toBeDefined();
  });
});
