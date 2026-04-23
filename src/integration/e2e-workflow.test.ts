/**
 * @module integration/e2e-workflow.test
 * @description End-to-end workflow tests exercising full FlowGuard session lifecycles.
 *
 * Each test runs a complete or partial sequence of tool calls via the real
 * tool execute() functions against real filesystem persistence. Git adapter
 * functions are selectively mocked.
 *
 * Scope: Multi-step workflows, cross-tool state consistency, full lifecycle integrity.
 * NOT in scope: Individual tool edge cases (see tools-execute.test.ts).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import {
  createToolContext,
  createTestWorkspace,
  isTarAvailable,
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
  implement,
  validate,
  review,
  abort_session,
  archive,
  architecture,
} from './tools/index.js';
import { readState } from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence.js';
import { verifyChain } from '../audit/integrity.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
  workspaceDir as resolveWorkspaceDir,
} from '../adapters/workspace/index.js';

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
      source: 'env',
    }),
  };
});

const gitMock = await import('../adapters/git.js');
const actorMock = await import('../adapters/actor.js');

// ─── Capability Gates ────────────────────────────────────────────────────────

const tarOk = await isTarAvailable();

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
  vi.mocked(actorMock.resolveActor).mockReset().mockResolvedValue({
    id: 'test-operator',
    email: 'test@flowguard.dev',
    source: 'env',
  });
  vi.clearAllMocks();
  await ws.cleanup();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Call a tool and parse the result. Fails the test if the result is an error. */
async function callOk(
  tool: { execute: (args: unknown, ctx: TestToolContext) => Promise<string> },
  args: unknown,
  context: TestToolContext = ctx,
): Promise<Record<string, unknown>> {
  const raw = await tool.execute(args, context);
  const result = parseToolResult(raw);
  if (result.error) {
    throw new Error(`Tool returned error: ${result.code} — ${result.message}`);
  }
  return result;
}

/** Get current phase from status tool. */
async function getPhase(context: TestToolContext = ctx): Promise<string> {
  const result = parseToolResult(await status.execute({}, context));
  return result.phase as string;
}

/** Resolve session directory for current context. */
async function getSessDir(context: TestToolContext = ctx): Promise<string> {
  const fp = await computeFingerprint(context.worktree);
  return resolveSessionDir(fp.fingerprint, context.sessionID);
}

// =============================================================================
// E2E Workflows
// =============================================================================

describe('e2e-workflow', () => {
  // ─── HAPPY ─────────────────────────────────────────────────

  describe('HAPPY', () => {
    it('complete solo workflow: hydrate → ticket → plan → validate → implement → complete', async () => {
      // 1. Hydrate
      const h = await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
      expect(h.phase).toBe('READY');
      expect(h.discoveryComplete).toBe(true);
      expect(h.discoverySummary).not.toBeNull();

      const sessDirAfterHydrate = await getSessDir();
      const fp = await computeFingerprint(ctx.worktree);
      const wsDir = resolveWorkspaceDir(fp.fingerprint);
      await expect(fs.access(`${wsDir}/config.json`)).resolves.toBeUndefined();
      await expect(fs.access(`${wsDir}/discovery/discovery.json`)).resolves.toBeUndefined();
      await expect(
        fs.access(`${wsDir}/discovery/profile-resolution.json`),
      ).resolves.toBeUndefined();
      await expect(
        fs.access(`${sessDirAfterHydrate}/discovery-snapshot.json`),
      ).resolves.toBeUndefined();
      await expect(
        fs.access(`${sessDirAfterHydrate}/profile-resolution-snapshot.json`),
      ).resolves.toBeUndefined();

      // 2. Ticket
      await callOk(ticket, { text: 'Fix the auth bug', source: 'user' });
      expect(await getPhase()).toBe('TICKET');
      const sessDirAfterTicket = await getSessDir();
      await expect(
        fs.access(`${sessDirAfterTicket}/artifacts/ticket.v1.md`),
      ).resolves.toBeUndefined();
      await expect(
        fs.access(`${sessDirAfterTicket}/artifacts/ticket.v1.json`),
      ).resolves.toBeUndefined();

      // 3. Plan (Mode A: submit)
      await callOk(plan, { planText: '## Plan\n1. Fix auth\n2. Add tests' });
      const sessDirAfterPlan = await getSessDir();
      await expect(fs.access(`${sessDirAfterPlan}/artifacts/plan.v1.md`)).resolves.toBeUndefined();
      await expect(
        fs.access(`${sessDirAfterPlan}/artifacts/plan.v1.json`),
      ).resolves.toBeUndefined();
      const planMetaRaw = await fs.readFile(`${sessDirAfterPlan}/artifacts/plan.v1.json`, 'utf-8');
      const planMeta = JSON.parse(planMetaRaw) as {
        sessionId: string;
        sourceStateHash: string;
        contentHash: string;
      };
      expect(planMeta.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(planMeta.sourceStateHash).toMatch(/^[0-9a-f]{64}$/);
      expect(planMeta.contentHash).toMatch(/^[0-9a-f]{64}$/);

      // 4. Plan (Mode B: approve self-review)
      // Solo: maxSelfReviewIterations=1, so first approve should converge
      await callOk(plan, { selfReviewVerdict: 'approve' });
      // Solo: auto-approves PLAN_REVIEW → advances to VALIDATION
      const afterPlan = await getPhase();
      expect(afterPlan).toBe('VALIDATION');

      // 5. Validate (all pass)
      await callOk(validate, {
        results: [
          { checkId: 'test_quality', passed: true, detail: 'All tests pass' },
          { checkId: 'rollback_safety', passed: true, detail: 'Safe' },
        ],
      });
      expect(await getPhase()).toBe('IMPLEMENTATION');

      // 6. Implement (Mode A: record changes)
      await callOk(implement, {});

      // 7. Implement (Mode B: approve review)
      await callOk(implement, { reviewVerdict: 'approve' });
      // Solo: auto-approves EVIDENCE_REVIEW → COMPLETE
      const finalPhase = await getPhase();
      expect(finalPhase).toBe('COMPLETE');

      // Verify all evidence slots are filled
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.ticket).not.toBeNull();
      expect(state!.plan).not.toBeNull();
      expect(state!.selfReview).not.toBeNull();
      expect(state!.validation.length).toBe(2);
      expect(state!.implementation).not.toBeNull();
      expect(state!.implReview).not.toBeNull();
    });

    it('complete team workflow with explicit decisions', async () => {
      // 1. Hydrate (team mode)
      await callOk(hydrate, { policyMode: 'team', profileId: 'baseline' });
      expect(await getPhase()).toBe('READY');

      // 2. Ticket
      await callOk(ticket, { text: 'Team task', source: 'user' });

      // 3. Plan + self-review (team: max 3 iterations)
      await callOk(plan, { planText: '## Plan\n1. Do things' });
      // Approve self-review until convergence
      for (let i = 0; i < 5; i++) {
        const phase = await getPhase();
        if (phase === 'PLAN_REVIEW') break;
        await callOk(plan, { selfReviewVerdict: 'approve' });
      }
      expect(await getPhase()).toBe('PLAN_REVIEW');

      // 4. Decision: approve plan
      await callOk(decision, { verdict: 'approve', rationale: 'Good plan' });
      expect(await getPhase()).toBe('VALIDATION');

      // 5. Validate
      await callOk(validate, {
        results: [
          { checkId: 'test_quality', passed: true, detail: 'OK' },
          { checkId: 'rollback_safety', passed: true, detail: 'OK' },
        ],
      });
      expect(await getPhase()).toBe('IMPLEMENTATION');

      // 6. Implement + review
      await callOk(implement, {});
      for (let i = 0; i < 5; i++) {
        const phase = await getPhase();
        if (phase === 'EVIDENCE_REVIEW') break;
        await callOk(implement, { reviewVerdict: 'approve' });
      }
      expect(await getPhase()).toBe('EVIDENCE_REVIEW');

      // 7. Decision: approve evidence
      await callOk(decision, { verdict: 'approve', rationale: 'Ship it' });
      expect(await getPhase()).toBe('COMPLETE');
    });
  });

  // ─── BAD ───────────────────────────────────────────────────

  describe('BAD', () => {
    it('reject at PLAN_REVIEW restarts from TICKET', async () => {
      await callOk(hydrate, { policyMode: 'team', profileId: 'baseline' });
      await callOk(ticket, { text: 'Task', source: 'user' });
      await callOk(plan, { planText: '## Plan' });
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'PLAN_REVIEW') break;
        await callOk(plan, { selfReviewVerdict: 'approve' });
      }
      expect(await getPhase()).toBe('PLAN_REVIEW');

      // Reject
      await callOk(decision, { verdict: 'reject', rationale: 'Bad approach' });
      expect(await getPhase()).toBe('TICKET');

      // Verify plan was cleared
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state!.plan).toBeNull();
    });

    it('changes_requested at PLAN_REVIEW returns to PLAN for revision', async () => {
      await callOk(hydrate, { policyMode: 'team', profileId: 'baseline' });
      await callOk(ticket, { text: 'Task', source: 'user' });
      await callOk(plan, { planText: '## Original Plan' });
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'PLAN_REVIEW') break;
        await callOk(plan, { selfReviewVerdict: 'approve' });
      }

      await callOk(decision, { verdict: 'changes_requested', rationale: 'More detail' });
      expect(await getPhase()).toBe('PLAN');

      // Can submit revised plan
      await callOk(plan, { planText: '## Revised Plan with more detail' });
    });

    it('validation failure sends back to PLAN', async () => {
      // Solo workflow up to VALIDATION
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
      await callOk(ticket, { text: 'Task', source: 'user' });
      await callOk(plan, { planText: '## Plan' });
      await callOk(plan, { selfReviewVerdict: 'approve' });
      expect(await getPhase()).toBe('VALIDATION');

      // Fail validation
      await callOk(validate, {
        results: [
          { checkId: 'test_quality', passed: false, detail: 'Missing tests' },
          { checkId: 'rollback_safety', passed: true, detail: 'OK' },
        ],
      });
      expect(await getPhase()).toBe('PLAN');

      // Can re-plan and re-validate
      await callOk(plan, { planText: '## Better Plan with tests' });
      await callOk(plan, { selfReviewVerdict: 'approve' });
      // In solo, may stop at PLAN_REVIEW (user gate) — need to advance
      const phaseAfterReplan = await getPhase();
      if (phaseAfterReplan === 'PLAN_REVIEW') {
        // Solo auto-approves conceptually, but decision tool still needed
        await callOk(decision, { verdict: 'approve', rationale: 'auto' });
      }
      expect(await getPhase()).toBe('VALIDATION');
    });

    it('changes_requested at EVIDENCE_REVIEW sends back to IMPLEMENTATION', async () => {
      // Team workflow to EVIDENCE_REVIEW
      await callOk(hydrate, { policyMode: 'team', profileId: 'baseline' });
      await callOk(ticket, { text: 'Rework task', source: 'user' });
      await callOk(plan, { planText: '## Plan' });
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'PLAN_REVIEW') break;
        await callOk(plan, { selfReviewVerdict: 'approve' });
      }
      await callOk(decision, { verdict: 'approve', rationale: 'OK' });
      await callOk(validate, {
        results: [
          { checkId: 'test_quality', passed: true, detail: 'OK' },
          { checkId: 'rollback_safety', passed: true, detail: 'OK' },
        ],
      });
      await callOk(implement, {});
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'EVIDENCE_REVIEW') break;
        await callOk(implement, { reviewVerdict: 'approve' });
      }
      expect(await getPhase()).toBe('EVIDENCE_REVIEW');

      // Request changes — sends back to IMPLEMENTATION
      await callOk(decision, { verdict: 'changes_requested', rationale: 'Need more tests' });
      expect(await getPhase()).toBe('IMPLEMENTATION');

      // Verify impl + implReview cleared, but plan preserved
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state!.implementation).toBeNull();
      expect(state!.implReview).toBeNull();
      expect(state!.plan).not.toBeNull();

      // Re-implement and complete
      await callOk(implement, {});
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'EVIDENCE_REVIEW') break;
        await callOk(implement, { reviewVerdict: 'approve' });
      }
      await callOk(decision, { verdict: 'approve', rationale: 'Good now' });
      expect(await getPhase()).toBe('COMPLETE');
    });

    it('reject at EVIDENCE_REVIEW restarts from TICKET with full clearing', async () => {
      // Team workflow to EVIDENCE_REVIEW
      await callOk(hydrate, { policyMode: 'team', profileId: 'baseline' });
      await callOk(ticket, { text: 'Rejected task', source: 'user' });
      await callOk(plan, { planText: '## Original Plan' });
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'PLAN_REVIEW') break;
        await callOk(plan, { selfReviewVerdict: 'approve' });
      }
      await callOk(decision, { verdict: 'approve', rationale: 'OK' });
      await callOk(validate, {
        results: [
          { checkId: 'test_quality', passed: true, detail: 'OK' },
          { checkId: 'rollback_safety', passed: true, detail: 'OK' },
        ],
      });
      await callOk(implement, {});
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'EVIDENCE_REVIEW') break;
        await callOk(implement, { reviewVerdict: 'approve' });
      }
      expect(await getPhase()).toBe('EVIDENCE_REVIEW');

      // Reject — sends back to TICKET, clears everything
      await callOk(decision, { verdict: 'reject', rationale: 'Wrong approach entirely' });
      expect(await getPhase()).toBe('TICKET');

      // Verify all downstream evidence is cleared
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state!.plan).toBeNull();
      expect(state!.selfReview).toBeNull();
      expect(state!.validation).toHaveLength(0);
      expect(state!.implementation).toBeNull();
      expect(state!.implReview).toBeNull();
      // Ticket is preserved (reject goes TO ticket, doesn't clear it)
      expect(state!.ticket).not.toBeNull();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────

  describe('CORNER', () => {
    it('abort mid-workflow terminates session', async () => {
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
      await callOk(ticket, { text: 'Task', source: 'user' });
      await callOk(plan, { planText: '## Plan' });

      await callOk(abort_session, { reason: 'Cancel everything' });
      expect(await getPhase()).toBe('COMPLETE');

      // Verify abort marker in state
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state!.error).not.toBeNull();
      expect(state!.error!.code).toBe('ABORTED');
    });

    it.skipIf(!tarOk)('archive after complete creates tar.gz', async () => {
      // Full solo workflow to COMPLETE
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
      await callOk(ticket, { text: 'Task', source: 'user' });
      await callOk(plan, { planText: '## Plan' });
      await callOk(plan, { selfReviewVerdict: 'approve' });
      await callOk(validate, {
        results: [
          { checkId: 'test_quality', passed: true, detail: 'OK' },
          { checkId: 'rollback_safety', passed: true, detail: 'OK' },
        ],
      });
      await callOk(implement, {});
      await callOk(implement, { reviewVerdict: 'approve' });
      expect(await getPhase()).toBe('COMPLETE');

      // Archive
      const archiveResult = await callOk(archive, {});
      expect(archiveResult.status).toContain('archived');
      expect(typeof archiveResult.archivePath).toBe('string');
      await expect(fs.access(archiveResult.archivePath as string)).resolves.toBeUndefined();
    });

    it('status at every phase returns correct phase', async () => {
      // Track phases through a solo workflow
      const phases: string[] = [];

      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
      phases.push(await getPhase());

      await callOk(ticket, { text: 'Task', source: 'user' });
      phases.push(await getPhase());

      await callOk(plan, { planText: '## Plan' });
      phases.push(await getPhase()); // After plan submit

      await callOk(plan, { selfReviewVerdict: 'approve' });
      phases.push(await getPhase()); // After self-review converge (solo auto-approve → VALIDATION)

      await callOk(validate, {
        results: [
          { checkId: 'test_quality', passed: true, detail: 'OK' },
          { checkId: 'rollback_safety', passed: true, detail: 'OK' },
        ],
      });
      phases.push(await getPhase()); // IMPLEMENTATION

      await callOk(implement, {});
      phases.push(await getPhase()); // After impl record

      await callOk(implement, { reviewVerdict: 'approve' });
      phases.push(await getPhase()); // COMPLETE

      // Verify progression
      expect(phases[0]).toBe('READY');
      expect(phases[1]).toBe('TICKET'); // Ticket transitions READY → TICKET
      expect(phases[phases.length - 1]).toBe('COMPLETE');

      // All phases should be valid phase names
      const validPhases = new Set([
        'READY',
        'TICKET',
        'PLAN',
        'PLAN_REVIEW',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_REVIEW',
        'EVIDENCE_REVIEW',
        'COMPLETE',
      ]);
      for (const p of phases) {
        expect(validPhases.has(p)).toBe(true);
      }
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────

  describe('EDGE', () => {
    it('team-ci without CI context degrades to team (human-gated)', async () => {
      const ciVars = [
        'CI',
        'GITHUB_ACTIONS',
        'GITLAB_CI',
        'BUILDKITE',
        'JENKINS_URL',
        'TF_BUILD',
        'TEAMCITY_VERSION',
        'CIRCLECI',
        'DRONE',
        'BITBUCKET_BUILD_NUMBER',
        'BUILDKITE_BUILD_ID',
      ];
      const previous = Object.fromEntries(ciVars.map((v) => [v, process.env[v]]));
      ciVars.forEach((v) => delete process.env[v]);
      try {
        const hydrateResult = await callOk(hydrate, {
          policyMode: 'team-ci',
          profileId: 'baseline',
        });
        const resolution = hydrateResult.policyResolution as Record<string, unknown>;
        expect(resolution.requestedMode).toBe('team-ci');
        expect(resolution.effectiveMode).toBe('team');
        expect(resolution.reason).toBe('ci_context_missing');

        await callOk(ticket, { text: 'CI-degrade task', source: 'user' });
        await callOk(plan, { planText: '## Plan\nHuman gate expected' });
        await callOk(plan, { selfReviewVerdict: 'approve' });
        expect(await getPhase()).toBe('PLAN_REVIEW');
      } finally {
        ciVars.forEach((v) => {
          if (previous[v] === undefined) delete process.env[v];
          else process.env[v] = previous[v];
        });
      }
    });

    it('team-ci with CI context auto-approves PLAN_REVIEW gate', async () => {
      const previousCi = process.env.CI;
      process.env.CI = 'true';
      try {
        const hydrateResult = await callOk(hydrate, {
          policyMode: 'team-ci',
          profileId: 'baseline',
        });
        const resolution = hydrateResult.policyResolution as Record<string, unknown>;
        expect(resolution.effectiveMode).toBe('team-ci');
        expect(resolution.effectiveGateBehavior).toBe('auto_approve');

        await callOk(ticket, { text: 'CI auto gate', source: 'user' });
        await callOk(plan, { planText: '## Plan\nAuto gate expected' });
        await callOk(plan, { selfReviewVerdict: 'approve' });
        expect(await getPhase()).toBe('VALIDATION');
      } finally {
        if (previousCi === undefined) delete process.env.CI;
        else process.env.CI = previousCi;
      }
    });

    it('concurrent sessions in same workspace have independent state', async () => {
      // Session 1
      const ctx1 = ctx;
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' }, ctx1);
      await callOk(ticket, { text: 'Session 1 task', source: 'user' }, ctx1);

      // Session 2 (same worktree, different sessionID)
      const ctx2 = createToolContext({
        worktree: ws.tmpDir,
        directory: ws.tmpDir,
        sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
      });
      await callOk(hydrate, { policyMode: 'team', profileId: 'baseline' }, ctx2);
      await callOk(ticket, { text: 'Session 2 task', source: 'user' }, ctx2);

      // Verify independence
      const sessDir1 = await getSessDir(ctx1);
      const sessDir2 = await getSessDir(ctx2);
      expect(sessDir1).not.toBe(sessDir2);

      const state1 = await readState(sessDir1);
      const state2 = await readState(sessDir2);
      expect(state1!.ticket!.text).toBe('Session 1 task');
      expect(state2!.ticket!.text).toBe('Session 2 task');
      expect(state1!.policySnapshot.mode).toBe('solo');
      expect(state2!.policySnapshot.mode).toBe('team');
    });

    it('idempotent hydrate preserves existing session', async () => {
      // First hydrate + ticket
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
      await callOk(ticket, { text: 'My task', source: 'user' });

      // Second hydrate (same sessionID)
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });

      // Ticket should still be there
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state!.ticket).not.toBeNull();
      expect(state!.ticket!.text).toBe('My task');
    });

    it('repo without remote uses path-based fingerprint and full workflow works', async () => {
      // Override: no remote
      vi.mocked(gitMock.remoteOriginUrl).mockResolvedValue(null);

      // Full solo workflow
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
      await callOk(ticket, { text: 'Local repo task', source: 'user' });
      await callOk(plan, { planText: '## Local Plan' });
      await callOk(plan, { selfReviewVerdict: 'approve' });
      await callOk(validate, {
        results: [
          { checkId: 'test_quality', passed: true, detail: 'OK' },
          { checkId: 'rollback_safety', passed: true, detail: 'OK' },
        ],
      });
      await callOk(implement, {});
      await callOk(implement, { reviewVerdict: 'approve' });
      expect(await getPhase()).toBe('COMPLETE');

      // Verify fingerprint is path-based
      const fp = await computeFingerprint(ws.tmpDir);
      expect(fp.materialClass).toBe('local_path');
    });

    it('audit trail integrity after full solo workflow', async () => {
      // Run through complete solo workflow
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
      await callOk(ticket, { text: 'Audit test', source: 'user' });
      await callOk(plan, { planText: '## Plan' });
      await callOk(plan, { selfReviewVerdict: 'approve' });
      await callOk(validate, {
        results: [
          { checkId: 'test_quality', passed: true, detail: 'OK' },
          { checkId: 'rollback_safety', passed: true, detail: 'OK' },
        ],
      });
      await callOk(implement, {});
      await callOk(implement, { reviewVerdict: 'approve' });
      expect(await getPhase()).toBe('COMPLETE');

      // Read and verify audit trail
      // Note: Audit trail is written by the plugin, not by tools directly.
      // This test verifies that the session state is consistent and the
      // trail file can be read (may be empty if plugin is not active).
      const sessDir = await getSessDir();
      const trail = await readAuditTrail(sessDir);
      // Trail may be empty (tools don't write audit events — plugin does).
      // But readAuditTrail should not throw.
      expect(trail).toBeDefined();
      expect(Array.isArray(trail.events)).toBe(true);
    });

    it('self-review changes_requested loop: revise plan then complete', async () => {
      // Team workflow: self-review loop exercises changes_requested path
      await callOk(hydrate, { policyMode: 'team', profileId: 'baseline' });
      await callOk(ticket, { text: 'Iterative planning task', source: 'user' });

      // Submit initial plan
      await callOk(plan, { planText: '## Initial Plan\nToo vague' });
      expect(await getPhase()).toBe('PLAN');

      // Self-review: request changes with revised plan
      await callOk(plan, {
        selfReviewVerdict: 'changes_requested',
        planText: '## Revised Plan\n1. Concrete step A\n2. Concrete step B',
      });

      // Now approve the revised plan
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'PLAN_REVIEW') break;
        await callOk(plan, { selfReviewVerdict: 'approve' });
      }
      expect(await getPhase()).toBe('PLAN_REVIEW');

      // Verify the revised plan is in state
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state!.plan!.current.body).toContain('Revised Plan');

      // Complete the workflow
      await callOk(decision, { verdict: 'approve', rationale: 'OK' });
      await callOk(validate, {
        results: [
          { checkId: 'test_quality', passed: true, detail: 'OK' },
          { checkId: 'rollback_safety', passed: true, detail: 'OK' },
        ],
      });
      await callOk(implement, {});
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'EVIDENCE_REVIEW') break;
        await callOk(implement, { reviewVerdict: 'approve' });
      }
      await callOk(decision, { verdict: 'approve', rationale: 'Ship it' });
      expect(await getPhase()).toBe('COMPLETE');
    });

    it('review flow transitions from READY to REVIEW_COMPLETE with report', async () => {
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });

      // Review right after hydrate — standalone flow from READY
      const reviewResult = await callOk(review, {});
      expect(reviewResult.phase).toBe('REVIEW_COMPLETE');
      expect(reviewResult.overallStatus).toBeDefined();
      const completeness = reviewResult.completeness as Record<string, unknown>;
      // Review flow has no evidence slots, so overallComplete is true
      expect(completeness.overallComplete).toBe(true);
      expect(completeness.slots).toBeDefined();
    });

    it('architecture solo flow: hydrate → architecture → ARCH_COMPLETE', async () => {
      // 1. Hydrate (solo — auto-approves at gates)
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
      expect(await getPhase()).toBe('READY');

      // 2. Submit ADR (Mode A: initial submission)
      const adrText =
        '## Context\nWe need a database.\n\n## Decision\nUse PostgreSQL.\n\n## Consequences\nMust maintain DB infra.';
      await callOk(architecture, { title: 'Use PostgreSQL', adrText });
      expect(await getPhase()).toBe('ARCHITECTURE');

      // 3. Self-review: approve (solo: maxSelfReviewIterations=1, so converges immediately)
      await callOk(architecture, { selfReviewVerdict: 'approve' });
      // Solo auto-approves ARCH_REVIEW → ARCH_COMPLETE
      expect(await getPhase()).toBe('ARCH_COMPLETE');

      // 4. Verify architecture evidence
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state!.architecture).not.toBeNull();
      expect(state!.architecture!.id).toBe('ADR-001');
      expect(state!.architecture!.title).toBe('Use PostgreSQL');
      expect(state!.architecture!.status).toBe('accepted');
      expect(state!.selfReview).not.toBeNull();
    });

    it('architecture team flow with explicit decisions', async () => {
      // 1. Hydrate (team mode — requires explicit gate decisions)
      await callOk(hydrate, { policyMode: 'team', profileId: 'baseline' });
      expect(await getPhase()).toBe('READY');

      // 2. Submit ADR
      const adrText =
        '## Context\nMicroservices comm.\n\n## Decision\nUse gRPC.\n\n## Consequences\nNeed proto files.';
      await callOk(architecture, { title: 'gRPC for services', adrText });

      // 3. Self-review loop to ARCH_REVIEW
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'ARCH_REVIEW') break;
        await callOk(architecture, { selfReviewVerdict: 'approve' });
      }
      expect(await getPhase()).toBe('ARCH_REVIEW');

      // 4. Approve at ARCH_REVIEW
      await callOk(decision, { verdict: 'approve', rationale: 'ADR looks good' });
      expect(await getPhase()).toBe('ARCH_COMPLETE');

      // 5. Verify MADR artifact was written
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state!.architecture!.status).toBe('accepted');
    });

    it('architecture reject at ARCH_REVIEW returns to READY', async () => {
      await callOk(hydrate, { policyMode: 'team', profileId: 'baseline' });
      const adrText =
        '## Context\nLogging.\n\n## Decision\nUse ELK.\n\n## Consequences\nComplex setup.';
      await callOk(architecture, { title: 'ELK for logging', adrText });
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'ARCH_REVIEW') break;
        await callOk(architecture, { selfReviewVerdict: 'approve' });
      }
      expect(await getPhase()).toBe('ARCH_REVIEW');

      // Reject → back to READY (architecture flow reject clears architecture evidence)
      await callOk(decision, { verdict: 'reject', rationale: 'Wrong approach' });
      expect(await getPhase()).toBe('READY');

      // Verify architecture was cleared
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state!.architecture).toBeNull();
      expect(state!.selfReview).toBeNull();
    });

    it('architecture changes_requested at ARCH_REVIEW returns to ARCHITECTURE', async () => {
      await callOk(hydrate, { policyMode: 'team', profileId: 'baseline' });
      const adrText =
        '## Context\nAPI.\n\n## Decision\nUse REST.\n\n## Consequences\nNeed OpenAPI specs.';
      await callOk(architecture, { title: 'REST APIs', adrText });
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'ARCH_REVIEW') break;
        await callOk(architecture, { selfReviewVerdict: 'approve' });
      }
      expect(await getPhase()).toBe('ARCH_REVIEW');

      // Changes requested → back to ARCHITECTURE for revision
      await callOk(decision, { verdict: 'changes_requested', rationale: 'Add more consequences' });
      expect(await getPhase()).toBe('ARCHITECTURE');

      // Re-submit revised ADR (Mode A — selfReview was cleared, must re-initialize)
      const revisedAdr =
        '## Context\nAPI.\n\n## Decision\nUse REST.\n\n## Consequences\nNeed OpenAPI specs. Must version endpoints.';
      await callOk(architecture, { title: 'REST APIs', adrText: revisedAdr });
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'ARCH_REVIEW') break;
        await callOk(architecture, { selfReviewVerdict: 'approve' });
      }
      await callOk(decision, { verdict: 'approve', rationale: 'Better now' });
      expect(await getPhase()).toBe('ARCH_COMPLETE');
    });

    it('regulated mode blocks self-approval approve at PLAN_REVIEW', async () => {
      // Regulated mode: allowSelfApproval === false.
      // In this E2E test, the same session actor attempts approval,
      // so four-eyes must block self-approval.

      await callOk(hydrate, { policyMode: 'regulated', profileId: 'baseline' });
      await callOk(ticket, { text: 'Regulated four-eyes test', source: 'user' });
      await callOk(plan, { planText: '## Regulated Plan\n\nThis plan requires external review.' });

      // Drive self-review to convergence
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'PLAN_REVIEW') break;
        await callOk(plan, { selfReviewVerdict: 'approve' });
      }
      expect(await getPhase()).toBe('PLAN_REVIEW');

      // Attempt self-approval — MUST be blocked
      const raw = await decision.execute(
        { verdict: 'approve', rationale: 'I approve my own work' },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('FOUR_EYES_ACTOR_MATCH');
      expect(result.recovery).toBeDefined();

      // Phase must not have changed — still at PLAN_REVIEW
      expect(await getPhase()).toBe('PLAN_REVIEW');

      // Verify state was NOT mutated (no reviewDecision recorded)
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state!.reviewDecision).toBeNull();
    });

    it('regulated mode allows changes_requested by same actor at PLAN_REVIEW', async () => {
      await callOk(hydrate, { policyMode: 'regulated', profileId: 'baseline' });
      await callOk(ticket, { text: 'Regulated changes test', source: 'user' });
      await callOk(plan, { planText: '## Plan needing changes' });

      // Drive to PLAN_REVIEW
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'PLAN_REVIEW') break;
        await callOk(plan, { selfReviewVerdict: 'approve' });
      }
      expect(await getPhase()).toBe('PLAN_REVIEW');

      // changes_requested by same actor is allowed for safe intervention
      const crRaw = await decision.execute(
        { verdict: 'changes_requested', rationale: 'Needs more detail' },
        ctx,
      );
      const crResult = parseToolResult(crRaw);
      expect(crResult.error).toBeUndefined();
      expect(crResult.phase).toBe('PLAN');
    });

    it('regulated mode allows reject by same actor at PLAN_REVIEW', async () => {
      await callOk(hydrate, { policyMode: 'regulated', profileId: 'baseline' });
      await callOk(ticket, { text: 'Regulated reject test', source: 'user' });
      await callOk(plan, { planText: '## Plan that should be rejected' });

      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'PLAN_REVIEW') break;
        await callOk(plan, { selfReviewVerdict: 'approve' });
      }
      expect(await getPhase()).toBe('PLAN_REVIEW');

      const rejRaw = await decision.execute({ verdict: 'reject', rationale: 'Start over' }, ctx);
      const rejResult = parseToolResult(rejRaw);
      expect(rejResult.error).toBeUndefined();
      expect(rejResult.phase).toBe('TICKET');
    });

    it('regulated mode blocks approve when actor identity is unknown', async () => {
      vi.mocked(actorMock.resolveActor).mockResolvedValueOnce({
        id: 'unknown',
        email: null,
        source: 'unknown',
      });

      await callOk(hydrate, { policyMode: 'regulated', profileId: 'baseline' });
      await callOk(ticket, { text: 'Unknown actor test', source: 'user' });
      await callOk(plan, { planText: '## Plan' });

      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'PLAN_REVIEW') break;
        await callOk(plan, { selfReviewVerdict: 'approve' });
      }

      vi.mocked(actorMock.resolveActor).mockResolvedValueOnce({
        id: 'unknown',
        email: null,
        source: 'unknown',
      });
      const raw = await decision.execute({ verdict: 'approve', rationale: 'LGTM' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REGULATED_ACTOR_UNKNOWN');
    });

    it('full re-traversal after EVIDENCE_REVIEW reject completes successfully', async () => {
      // Team workflow to EVIDENCE_REVIEW, then reject, then complete from scratch
      await callOk(hydrate, { policyMode: 'team', profileId: 'baseline' });
      await callOk(ticket, { text: 'First attempt', source: 'user' });
      await callOk(plan, { planText: '## Bad Plan' });
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'PLAN_REVIEW') break;
        await callOk(plan, { selfReviewVerdict: 'approve' });
      }
      await callOk(decision, { verdict: 'approve', rationale: 'OK' });
      await callOk(validate, {
        results: [
          { checkId: 'test_quality', passed: true, detail: 'OK' },
          { checkId: 'rollback_safety', passed: true, detail: 'OK' },
        ],
      });
      await callOk(implement, {});
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'EVIDENCE_REVIEW') break;
        await callOk(implement, { reviewVerdict: 'approve' });
      }

      // Reject at EVIDENCE_REVIEW — back to TICKET
      await callOk(decision, { verdict: 'reject', rationale: 'Start over' });
      expect(await getPhase()).toBe('TICKET');

      // Full re-traversal with new ticket
      await callOk(ticket, { text: 'Second attempt — better approach', source: 'user' });
      await callOk(plan, { planText: '## Better Plan' });
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'PLAN_REVIEW') break;
        await callOk(plan, { selfReviewVerdict: 'approve' });
      }
      await callOk(decision, { verdict: 'approve', rationale: 'Good' });
      await callOk(validate, {
        results: [
          { checkId: 'test_quality', passed: true, detail: 'OK' },
          { checkId: 'rollback_safety', passed: true, detail: 'OK' },
        ],
      });
      await callOk(implement, {});
      for (let i = 0; i < 5; i++) {
        if ((await getPhase()) === 'EVIDENCE_REVIEW') break;
        await callOk(implement, { reviewVerdict: 'approve' });
      }
      await callOk(decision, { verdict: 'approve', rationale: 'Ship it' });
      expect(await getPhase()).toBe('COMPLETE');

      // Verify final state has second attempt's data
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state!.ticket!.text).toBe('Second attempt — better approach');
      expect(state!.plan!.current.body).toContain('Better Plan');
    });
  });

  // ─── PERF ──────────────────────────────────────────────────

  describe('PERF', () => {
    it('complete solo workflow through COMPLETE < 5s', async () => {
      const start = Date.now();
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
      await callOk(ticket, { text: 'Perf test', source: 'user' });
      await callOk(plan, { planText: '## Plan\nSimple implementation' });
      await callOk(plan, { selfReviewVerdict: 'approve' });
      await callOk(validate, {
        results: [
          { checkId: 'test_quality', passed: true, detail: 'OK' },
          { checkId: 'rollback_safety', passed: true, detail: 'OK' },
        ],
      });
      await callOk(implement, {});
      await callOk(implement, { reviewVerdict: 'approve' });
      expect(await getPhase()).toBe('COMPLETE');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(5000);
    });

    it('5x complete solo workflows < 8s (no O(n^2) leaks)', async () => {
      const start = Date.now();
      for (let i = 0; i < 5; i++) {
        const ic = createToolContext({ worktree: ws.tmpDir, directory: ws.tmpDir });
        await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' }, ic);
        await callOk(ticket, { text: `Task ${i}`, source: 'user' }, ic);
        await callOk(plan, { planText: '## Plan' }, ic);
        await callOk(plan, { selfReviewVerdict: 'approve' }, ic);
        await callOk(
          validate,
          {
            results: [
              { checkId: 'test_quality', passed: true, detail: 'OK' },
              { checkId: 'rollback_safety', passed: true, detail: 'OK' },
            ],
          },
          ic,
        );
        await callOk(implement, {}, ic);
        await callOk(implement, { reviewVerdict: 'approve' }, ic);
        expect(await getPhase(ic)).toBe('COMPLETE');
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(8000);
    });
  });
});
