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
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review/assurance.js';
import { REVIEWER_SUBAGENT_TYPE } from './review/enforcement/types.js';

const execFileAsync = promisify(execFile);

const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
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
        obligations: [
          {
            obligationId: OBLIGATION_ID,
            obligationType: 'plan',
            iteration: 0,
            planVersion: 1,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            createdAt: now,
            pluginHandshakeAt: null,
            status: 'pending',
            invocationId: null,
            blockedCode: null,
            fulfilledAt: null,
            consumedAt: null,
          },
        ],
        invocations: [],
        attempts: [],
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
    reviewedBy: { sessionId: 'ses_child_corrupt_e2e' },
    reviewedAt: '2026-05-10T12:00:00.000Z',
    attestation: {
      toolObligationId: OBLIGATION_ID,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      iteration: 0,
      planVersion: 1,
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
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
    reviewedBy: { sessionId: CHILD_VALID },
    reviewedAt: '2026-05-10T12:00:00.000Z',
    attestation: {
      toolObligationId: OBLIGATION_ID,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      iteration: 0,
      planVersion: 1,
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
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
    reviewCriteriaVersion: REVIEW_CRITERIA_VERSION,
    reviewMandateDigest: REVIEW_MANDATE_DIGEST,
    next: 'INDEPENDENT_REVIEW_REQUIRED: iteration=0, planVersion=1',
  });
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
      const afterHook = hooks['tool.execute.after']!;
      const reviewerArgs = {
        subagent_type: REVIEWER_SUBAGENT_TYPE,
        prompt: 'iteration=0, planVersion=1 — review this plan critically for the auth feature.',
      };

      // ── Mode A: flowguard_plan signals INDEPENDENT_REVIEW_REQUIRED ───────────
      // Registers the in-memory pending review the reviewer Task will match.
      await afterHook(
        { tool: 'flowguard_plan', sessionID, callID: 'call-plan', args: {} },
        { title: 'flowguard_plan', output: planReviewRequiredOutput(), metadata: {} },
      );

      // ── Reviewer Task #1: not-yet-bindable findings (no overallVerdict) ──────
      const firstOutput: { title: string; output: string; metadata: Record<string, unknown> } = {
        title: 'task',
        output: noVerdictReviewerOutput(),
        metadata: {},
      };
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
      const secondOutput: { title: string; output: string; metadata: Record<string, unknown> } = {
        title: 'task',
        output: validReviewerOutput(),
        metadata: {},
      };
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
});
