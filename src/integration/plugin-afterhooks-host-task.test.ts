/**
 * @module integration/plugin-afterhooks-host-task.test
 * @description E2E coverage of the reviewer host-task after-hook recovery path.
 *
 * Drives the real `tool.execute.after` hook exposed by FlowGuardAuditPlugin for
 * a flowguard-reviewer Task. Locks the live-runtime symptom observed in the
 * demo implement-run: a reviewer Task whose captured findings are not
 * bindable emits a fail-closed `HOST_SUBAGENT_TASK_REQUIRED` block with
 * `bindOutcome: no_matched_record`; a SEQUENTIAL re-invocation with valid
 * findings then binds and persists the invocation evidence (`bindOutcome: bound`).
 *
 * @test-policy STANDARD — host-task binding recovery (after-hook E2E)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FlowGuardAuditPlugin } from './plugin.js';
import { makeState } from '../fixtures.js';
import { createTestWorkspace, withTestEnv } from './test-helpers.js';
import { readState, writeState } from '../adapters/persistence.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import {
  freezeReviewMaterial,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './review/assurance.js';
import { REVIEWER_SUBAGENT_TYPE } from './review/enforcement/types.js';
import { renderReviewerTaskPrompt } from './review/prompt-builders.js';
import { executeReviewDecision } from '../rails/review-decision.js';
import { computeRecordDigest } from '../state/evidence-plan.js';
import { createTestContext } from '../testing.js';
import { FIXED_TIME } from '../fixtures.js';
import { hashText } from '../shared/hashing.js';

const execFileAsync = promisify(execFile);

const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '11111111-2222-4111-8111-111111111111';
const SUBJECT_DIGEST = 'host-task-plan-subject-digest';
const CHILD_VALID = 'ses_child_valid_e2e';

function createMockInput(overrides: Record<string, unknown> = {}) {
  return {
    project: {} as unknown,
    client: { app: { log: async () => {} } } as unknown,
    $: {} as unknown,
    directory: '/tmp/mock-dir',
    worktree: '/tmp/mock-worktree',
    serverUrl: new URL('http://localhost:3000'),
    ...overrides,
  } as Parameters<typeof FlowGuardAuditPlugin>[0];
}

/** Seed a PLAN session in host_task_required mode with one pending review obligation. */
async function seedHostTaskPlanSession(worktree: string, sessionID: string): Promise<string> {
  const now = new Date().toISOString();
  const fp = await computeFingerprint(worktree);
  const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
  const reviewMaterial = freezeReviewMaterial('## Plan\n1. Fix the auth feature.', SUBJECT_DIGEST);
  await fs.mkdir(sessDir, { recursive: true });

  const base = makeState('PLAN');
  await writeState(
    sessDir,
    makeState('PLAN', {
      policySnapshot: {
        ...base.policySnapshot,
        reviewInvocationPolicy: 'host_task_required',
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: true },
      },
      reviewAssurance: {
        assuranceSchemaVersion: 'review-assurance.v5' as const,
        obligations: [
          {
            obligationId: OBLIGATION_ID,
            obligationType: 'plan',
            iteration: 0,
            planVersion: 1,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            maxReviewerOutputRepairAttempts: 1,
            createdAt: now,
            pluginHandshakeAt: null,
            status: 'pending',
            invocationId: null,
            blockedCode: null,
            fulfilledAt: null,
            consumedAt: null,
            subjectDigest: SUBJECT_DIGEST,
            reviewSubjectScope: {
              kind: 'repository_change',
              paths: ['src/plan.ts'],
              revisions: ['base', 'head'],
            },
            reviewMaterial,
          },
        ],
        invocations: [],
        // The attempt exists before the reviewer runs and is still unbound: the
        // host correlates the child session at Task time.
        attempts: [
          {
            attemptId: ATTEMPT_ID,
            obligationId: OBLIGATION_ID,
            obligationType: 'plan' as const,
            subjectDigest: SUBJECT_DIGEST,
            reviewMaterial,
            ordinal: 0,
            status: 'created' as const,
            origin: { kind: 'initial' } as const,
            repositoryDiscovery: { kind: 'not_applicable' } as const,
            createdAt: now,
          },
        ],
      },
    }),
  );
  return sessDir;
}

/** Reviewer Task output with no string overallVerdict → not yet bindable. */
function noVerdictReviewerOutput(): string {
  return JSON.stringify({
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    attestation: {
      toolObligationId: OBLIGATION_ID,
    },
  });
}

/** Reviewer Task output with a valid, bindable verdict. */
function validReviewerOutput(): string {
  return JSON.stringify({
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    attestation: {
      toolObligationId: OBLIGATION_ID,
    },
  });
}

/**
 * Mode A plan-tool output that signals INDEPENDENT_REVIEW_REQUIRED. The
 * flowguard_plan after-hook consumes this to register the in-memory pending
 * review (enforcement state), which the subsequent reviewer Task calls match
 * and re-arm. Without this prior signal there is no pendingReview to bind.
 */
function planReviewRequiredOutput(): string {
  return JSON.stringify({
    phase: 'PLAN',
    selfReviewIteration: 0,
    reviewMode: 'subagent',
    reviewObligationId: OBLIGATION_ID,
    reviewAttemptId: ATTEMPT_ID,
    reviewCriteriaVersion: REVIEW_CRITERIA_VERSION,
    reviewMandateDigest: REVIEW_MANDATE_DIGEST,
    reviewerTaskPrompt:
      renderReviewerTaskPrompt({
        iteration: 0,
        planVersion: 1,
        obligationId: OBLIGATION_ID,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        subjectLabel: 'the plan',
      }) + '\n## Plan\n1. Fix the auth feature.',
    next: 'INDEPENDENT_REVIEW_REQUIRED: iteration=0, planVersion=1',
  });
}

function reviewerArgsFromReviewRequiredOutput(output: string) {
  const reviewerTaskPrompt = (JSON.parse(output) as Record<string, unknown>).reviewerTaskPrompt;
  if (typeof reviewerTaskPrompt !== 'string') {
    throw new TypeError('Expected canonical reviewerTaskPrompt in review-required output');
  }
  return { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: reviewerTaskPrompt };
}

describe('reviewer host-task after-hook: no_matched_record → sequential re-invocation → bound', () => {
  let configDir: string;
  let cleanupEnv: () => void;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-host-task-afterhook-'));
    cleanupEnv = withTestEnv({
      OPENCODE_CONFIG_DIR: configDir,
      FLOWGUARD_REQUIRE_TEST_CONFIG_DIR: '1',
    });
  });

  afterEach(async () => {
    cleanupEnv();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('first reviewer Task blocks fail-closed, sequential re-invocation binds and persists evidence', async () => {
    const ws = await createTestWorkspace();
    try {
      await execFileAsync('git', ['init'], { cwd: ws.tmpDir });
      const sessionID = crypto.randomUUID();
      const sessDir = await seedHostTaskPlanSession(ws.tmpDir, sessionID);

      const hooks = await FlowGuardAuditPlugin(
        createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
      );
      const beforeHook = hooks['tool.execute.before']!;
      const afterHook = hooks['tool.execute.after']!;
      const planOutput = {
        title: 'flowguard_plan',
        output: planReviewRequiredOutput(),
        metadata: {},
      };

      // ── Mode A: flowguard_plan signals INDEPENDENT_REVIEW_REQUIRED ───────────
      // Registers the in-memory pending review the reviewer Task will match.
      await afterHook(
        { tool: 'flowguard_plan', sessionID, callID: 'call-plan', args: {} },
        planOutput,
      );
      const reviewerArgs = reviewerArgsFromReviewRequiredOutput(planOutput.output);

      // ── Reviewer Task #1: not-yet-bindable findings (no overallVerdict) ──────
      const firstOutput: { title: string; output: string; metadata: Record<string, unknown> } = {
        title: 'task',
        output: noVerdictReviewerOutput(),
        metadata: { sessionID: 'ses_child_corrupt_e2e' },
      };
      await beforeHook({ tool: 'task', sessionID, callID: 'call-1' }, { args: reviewerArgs });
      await afterHook(
        { tool: 'task', sessionID, callID: 'call-1', args: reviewerArgs },
        firstOutput,
      );

      // Fail-closed: host_task_required blocks with no bindable evidence.
      expect(firstOutput.output).toContain('HOST_SUBAGENT_TASK_REQUIRED');
      expect(firstOutput.output).toContain('no_matched_record');

      // No invocation evidence persisted yet.
      const afterFirst = await readState(sessDir);
      expect(afterFirst?.reviewAssurance?.invocations ?? []).toHaveLength(0);

      // ── Reviewer Task #2: sequential re-invocation with valid findings ───────
      await afterHook(
        { tool: 'flowguard_plan', sessionID, callID: 'call-plan-retry', args: {} },
        planOutput,
      );
      const secondOutput: { title: string; output: string; metadata: Record<string, unknown> } = {
        title: 'task',
        output: validReviewerOutput(),
        metadata: { sessionID: CHILD_VALID },
      };
      await beforeHook({ tool: 'task', sessionID, callID: 'call-2' }, { args: reviewerArgs });
      await afterHook(
        { tool: 'task', sessionID, callID: 'call-2', args: reviewerArgs },
        secondOutput,
      );

      // Not blocked this time; evidence bound and persisted.
      expect(secondOutput.output).not.toContain('HOST_SUBAGENT_TASK_REQUIRED');
      const afterSecond = await readState(sessDir);
      const invocations = afterSecond?.reviewAssurance?.invocations ?? [];
      expect(invocations).toHaveLength(1);
      expect(invocations[0]!.obligationId).toBe(OBLIGATION_ID);
      expect(invocations[0]!.childSessionId).toBe(CHILD_VALID);
      expect(invocations[0]!.hostVisible).toBe(true);
      expect(invocations[0]!.invocationMode).toBe('host_subagent_task');
    } finally {
      await ws.cleanup();
    }
  });

  it('refuses to re-arm a consumed obligation: a late reviewer Task cannot reopen a settled review', async () => {
    const ws = await createTestWorkspace();
    try {
      await execFileAsync('git', ['init'], { cwd: ws.tmpDir });
      const sessionID = crypto.randomUUID();
      const sessDir = await seedHostTaskPlanSession(ws.tmpDir, sessionID);

      const hooks = await FlowGuardAuditPlugin(
        createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
      );
      const beforeHook = hooks['tool.execute.before']!;
      const afterHook = hooks['tool.execute.after']!;
      const planOutput = {
        title: 'flowguard_plan',
        output: planReviewRequiredOutput(),
        metadata: {},
      };

      await afterHook(
        { tool: 'flowguard_plan', sessionID, callID: 'call-plan', args: {} },
        planOutput,
      );
      const reviewerArgs = reviewerArgsFromReviewRequiredOutput(planOutput.output);

      // A first reviewer Task returns an unusable capture, so the attempt is
      // spent but the obligation is still awaiting review.
      await beforeHook({ tool: 'task', sessionID, callID: 'call-first' }, { args: reviewerArgs });
      await afterHook(
        { tool: 'task', sessionID, callID: 'call-first', args: reviewerArgs },
        { title: 'task', output: noVerdictReviewerOutput(), metadata: {} },
      );
      const spent = await readState(sessDir);
      expect(spent?.reviewAssurance?.invocations ?? []).toHaveLength(0);

      // The obligation is then settled through another route.
      await writeState(sessDir, {
        ...spent!,
        reviewAssurance: {
          ...spent!.reviewAssurance!,
          obligations: spent!.reviewAssurance!.obligations.map((o) => ({
            ...o,
            status: 'consumed' as const,
            consumedAt: new Date().toISOString(),
          })),
        },
      });

      // The retry would have to re-arm the spent attempt. A settled obligation
      // must refuse that, otherwise a late reviewer reopens a closed decision.
      await expect(
        beforeHook({ tool: 'task', sessionID, callID: 'call-late' }, { args: reviewerArgs }),
      ).rejects.toThrow('REVIEWER_TASK_REQUIRES_PENDING_OBLIGATION');

      // Fail closed: no invocation, and no fresh attempt minted to carry one.
      const after = await readState(sessDir);
      expect(after?.reviewAssurance?.invocations ?? []).toHaveLength(0);
      expect(
        after?.reviewAssurance?.attempts ?? [],
        'a settled obligation must not be re-armed',
      ).toHaveLength(1);
    } finally {
      await ws.cleanup();
    }
  });

  it('refuses to bind the same reviewer child session twice', async () => {
    const ws = await createTestWorkspace();
    try {
      await execFileAsync('git', ['init'], { cwd: ws.tmpDir });
      const sessionID = crypto.randomUUID();
      const sessDir = await seedHostTaskPlanSession(ws.tmpDir, sessionID);

      const hooks = await FlowGuardAuditPlugin(
        createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
      );
      const beforeHook = hooks['tool.execute.before']!;
      const afterHook = hooks['tool.execute.after']!;
      const planOutput = {
        title: 'flowguard_plan',
        output: planReviewRequiredOutput(),
        metadata: {},
      };

      await afterHook(
        { tool: 'flowguard_plan', sessionID, callID: 'call-plan', args: {} },
        planOutput,
      );
      const reviewerArgs = reviewerArgsFromReviewRequiredOutput(planOutput.output);

      // Both Task callbacks report the SAME reviewer session id.
      for (const callID of ['call-a', 'call-b']) {
        const dispatched = await beforeHook(
          { tool: 'task', sessionID, callID },
          { args: reviewerArgs },
        ).then(
          () => true,
          () => false,
        );
        if (dispatched) {
          await afterHook(
            { tool: 'task', sessionID, callID, args: reviewerArgs },
            { title: 'task', output: validReviewerOutput(), metadata: { sessionID: CHILD_VALID } },
          );
        }
      }

      // One reviewer session satisfies at most one attempt.
      const after = await readState(sessDir);
      expect(after?.reviewAssurance?.invocations ?? []).toHaveLength(1);
      expect(
        (after?.reviewAssurance?.attempts ?? []).filter((a) => a.childSessionId === CHILD_VALID),
      ).toHaveLength(1);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('host-task evidence → plan certificate lineage', () => {
  let configDir: string;
  let cleanupEnv: () => void;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-host-task-cert-'));
    cleanupEnv = withTestEnv({
      OPENCODE_CONFIG_DIR: configDir,
      FLOWGUARD_REQUIRE_TEST_CONFIG_DIR: '1',
    });
  });

  afterEach(async () => {
    cleanupEnv();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('fulfills the obligation and produces a certificate with reviewEvidenceDigest', async () => {
    const ws = await createTestWorkspace();
    try {
      await execFileAsync('git', ['init'], { cwd: ws.tmpDir });
      const sessionID = crypto.randomUUID();
      const sessDir = await seedHostTaskPlanSession(ws.tmpDir, sessionID);

      const hooks = await FlowGuardAuditPlugin(
        createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
      );
      const beforeHook = hooks['tool.execute.before']!;
      const afterHook = hooks['tool.execute.after']!;
      const planOutput = {
        title: 'flowguard_plan',
        output: planReviewRequiredOutput(),
        metadata: {},
      };

      // Register the pending review (same pattern as the recovery test).
      await afterHook(
        { tool: 'flowguard_plan', sessionID, callID: 'call-plan', args: {} },
        planOutput,
      );
      const reviewerArgs = reviewerArgsFromReviewRequiredOutput(planOutput.output);

      // Simulate reviewer Task completion — exercises plugin-task-evidence.ts.
      const taskOutput: { title: string; output: string; metadata: Record<string, unknown> } = {
        title: 'task',
        output: validReviewerOutput(),
        metadata: {},
      };
      await beforeHook({ tool: 'task', sessionID, callID: 'call-task' }, { args: reviewerArgs });
      await afterHook(
        { tool: 'task', sessionID, callID: 'call-task', args: reviewerArgs },
        taskOutput,
      );

      expect(taskOutput.output).not.toContain('HOST_SUBAGENT_TASK_REQUIRED');

      const state = await readState(sessDir);
      expect(state).toBeDefined();

      const obligation = state!.reviewAssurance?.obligations.find(
        (o) => o.obligationId === OBLIGATION_ID,
      );
      expect(obligation).toBeDefined();
      // Critical: the plugin hook must have fulfilled the obligation.
      // Removing fulfillObligation from plugin-task-evidence.ts makes this fail.
      expect(obligation?.status).toBe('fulfilled');
      expect(obligation?.invocationId).toBeTruthy();

      const invocation = state!.reviewAssurance?.invocations.find(
        (inv) => inv.invocationId === obligation?.invocationId,
      );
      expect(invocation).toBeDefined();
      expect(invocation?.obligationId).toBe(OBLIGATION_ID);

      const attempt = state!.reviewAssurance?.attempts.find((a) => a.attemptId === ATTEMPT_ID);
      expect(attempt?.status).toBe('bound');

      // Write plan content and advance to PLAN_REVIEW for certificate creation.
      const now = new Date().toISOString();
      const planRecord = computeRecordDigest({
        contentDigest: 'plan-cert-digest',
        planVersion: 1,
        supersedesRecordDigest: null,
        originatingReviewObligationId: null,
        revisionReason: null,
      });
      await writeState(sessDir, {
        ...state!,
        phase: 'PLAN_REVIEW' as const,
        plan: {
          current: {
            body: '## Plan\n1. Fix the thing.',
            digest: 'plan-cert-digest',
            sections: [],
            createdAt: now,
            recordDigest: planRecord,
            planVersion: 1,
            supersedesRecordDigest: null,
            originatingReviewObligationId: null,
            revisionReason: null,
            lineageStatus: 'verified' as const,
          },
          history: [],
          reviewFindings: undefined,
          claimDeclarations: {
            flow: 'plan' as const,
            claims: [
              {
                claimId: 'a1b2c3d4-e5f6-7890-8abc-def123456789',
                statement: 'The change preserves the intended behavior.',
                critical: true,
                authoritySectionId: 's1',
                expectedCheckId: 'build',
              },
            ],
          },
        },
      });

      const reviewState = await readState(sessDir);
      expect(reviewState).toBeDefined();

      const approved = executeReviewDecision(
        reviewState!,
        { verdict: 'approve', rationale: 'ok', decidedBy: 'approver' },
        createTestContext(FIXED_TIME, hashText),
      );
      if (approved.kind !== 'ok') throw new Error('plan approval failed');

      const cert = approved.state.plan?.approvalCertificate;
      expect(cert).toBeDefined();
      expect(cert!.reviewObligationId).toBe(OBLIGATION_ID);
      expect(cert!.reviewEvidenceDigest).toBe(invocation?.findingsHash);
      expect(cert!.reviewEvidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await ws.cleanup();
    }
  });
});
