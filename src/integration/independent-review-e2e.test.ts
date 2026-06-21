/**
 * @module integration/independent-review-e2e.test
 * @description End-to-end coverage of the host_task_required independent-review
 * RUNTIME path through the REAL FlowGuard plugin hooks.
 *
 * Why this exists: the prior `independent-review-e2e` gate exercised only the
 * tool layer (which bypasses the plugin enforcement hooks) and a surface-only
 * runtime smoke. The plugin `tool.execute.before`/`after` enforcement path —
 * where two shipped host_task bugs lived (binding `field_mismatch` and the
 * verdict `SUBAGENT_SESSION_MISMATCH`) — was never driven end-to-end. This test
 * drives the real hook chain deterministically (no LLM, no SDK reviewer):
 *
 *   flowguard_plan(after, Mode A)  -> registers the pending review obligation
 *   task(after, flowguard-reviewer) -> captures + binds host-visible evidence
 *   flowguard_plan(before, verdict) -> enforceVerdictCheck / enforceBeforeVerdict
 *
 * The verdict step submits a reviewFindings payload whose reviewedBy.sessionId
 * does NOT match the captured child session — the exact shape that triggered the
 * shipped `SUBAGENT_SESSION_MISMATCH` block. host_task_required must tolerate it.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — covered by the suite + unit peers.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FlowGuardAuditPlugin } from './plugin.js';
import { makeState } from '../fixtures.js';
import { createTestWorkspace } from './test-helpers.js';
import { readState, writeState } from '../adapters/persistence.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review/assurance.js';
import type { SessionState } from '../state/schema.js';

const execFileAsync = promisify(execFile);

const PARENT_SESSION = 'ses_parent_e2e';
const CHILD_SESSION = 'ses_child_real_e2e';
const OBLIGATION_ID = '2a8f1c40-1111-4aaa-8bbb-cccccccccccc';

type Hooks = Awaited<ReturnType<typeof FlowGuardAuditPlugin>>;

async function initGitRepo(worktree: string): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: worktree });
}

/**
 * Client stub that fails loudly if the SDK reviewer path is ever taken. In
 * host_task_required mode the orchestrator must NOT call the SDK session API;
 * a throw here would surface that regression.
 */
function strictNoSdkClient() {
  const notCalled = (name: string) => async () => {
    throw new Error(`SDK client.${name} must not be called in host_task_required mode`);
  };
  return {
    app: { log: async () => {} },
    session: { create: notCalled('session.create'), prompt: notCalled('session.prompt') },
  } as unknown;
}

function planModeAOutput(): { output: string; metadata: Record<string, unknown> } {
  return {
    output: JSON.stringify({
      phase: 'PLAN',
      selfReviewIteration: 0,
      reviewMode: 'subagent',
      reviewObligationId: OBLIGATION_ID,
      reviewCriteriaVersion: REVIEW_CRITERIA_VERSION,
      reviewMandateDigest: REVIEW_MANDATE_DIGEST,
      next: 'INDEPENDENT_REVIEW_REQUIRED: iteration=0, planVersion=1',
    }),
    metadata: {},
  };
}

function reviewerTaskOutput(
  opts: {
    childSessionId?: string;
    reviewedBySessionId?: string;
    verdict?: string;
    mandateDigest?: string;
    criteriaVersion?: string;
  } = {},
): { output: string; metadata: Record<string, unknown> } {
  const {
    childSessionId = CHILD_SESSION,
    reviewedBySessionId = 'ses_reviewer_selfreported',
    verdict = 'accept',
    mandateDigest = REVIEW_MANDATE_DIGEST,
    criteriaVersion = REVIEW_CRITERIA_VERSION,
  } = opts;
  return {
    output: JSON.stringify({
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: verdict,
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: reviewedBySessionId },
      reviewedAt: '2026-06-18T00:00:00.000Z',
      attestation: {
        toolObligationId: OBLIGATION_ID,
        mandateDigest,
        criteriaVersion,
        iteration: 0,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer',
      },
    }),
    // Tier 1 host metadata: the authoritative child session id the host observed.
    metadata: { sessionID: childSessionId },
  };
}

async function seedHostTaskPlanSession(worktree: string, sessionID: string): Promise<string> {
  const now = new Date().toISOString();
  const fp = await computeFingerprint(worktree);
  const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
  await fs.mkdir(sessDir, { recursive: true });
  const base = makeState('PLAN');
  await writeState(
    sessDir,
    makeState('PLAN', {
      ticket: { text: 'Add feature X', digest: 'ticket-digest', source: 'user', createdAt: now },
      plan: {
        current: {
          body: '## Plan\n1. Implement X',
          digest: 'plan-digest',
          sections: ['Plan'],
          createdAt: now,
        },
        history: [],
        reviewFindings: [],
      },
      selfReview: {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'plan-digest',
        revisionDelta: 'major',
        verdict: 'changes_requested',
      },
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
      },
    }),
  );
  return sessDir;
}

/**
 * Drive the real plugin after-hooks for plan(Mode A) + reviewer Task, so the
 * plugin captures and binds host-visible evidence exactly as in production.
 */
async function driveCaptureThroughHooks(
  hooks: Hooks,
  opts: {
    verdict?: string;
    reviewedBySessionId?: string;
    mandateDigest?: string;
    criteriaVersion?: string;
  } = {},
): Promise<void> {
  const afterHook = hooks['tool.execute.after']!;
  await afterHook(
    { tool: 'flowguard_plan', sessionID: PARENT_SESSION, callID: 'c-plan', args: {} },
    planModeAOutput(),
  );
  await afterHook(
    {
      tool: 'task',
      sessionID: PARENT_SESSION,
      callID: 'c-task',
      args: {
        subagent_type: 'flowguard-reviewer',
        prompt:
          'Review this plan critically against the ticket. iteration=0, planVersion=1. ' +
          'Return structured ReviewFindings JSON with your verdict.',
      },
    },
    reviewerTaskOutput(opts),
  );
}

describe('independent-review e2e: host_task_required runtime path (real plugin hooks)', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  async function setup(): Promise<{ hooks: Hooks; sessDir: string }> {
    const ws = await createTestWorkspace();
    cleanup = ws.cleanup;
    await initGitRepo(ws.tmpDir);
    const sessDir = await seedHostTaskPlanSession(ws.tmpDir, PARENT_SESSION);
    const hooks = await FlowGuardAuditPlugin({
      project: {} as unknown,
      client: strictNoSdkClient(),
      $: {} as unknown,
      directory: ws.tmpDir,
      worktree: ws.tmpDir,
      serverUrl: new URL('http://localhost:3000'),
    } as Parameters<typeof FlowGuardAuditPlugin>[0]);
    return { hooks, sessDir };
  }

  it('captures + binds reviewer evidence through the real Task after-hook', async () => {
    const { hooks, sessDir } = await setup();

    await driveCaptureThroughHooks(hooks);

    const state = await readState(sessDir);
    const invocations = state?.reviewAssurance?.invocations ?? [];
    const bound = invocations.find((inv) => inv.obligationId === OBLIGATION_ID);
    expect(bound, 'host-visible invocation evidence was persisted by the plugin').toBeDefined();
    expect(bound?.invocationMode).toBe('host_subagent_task');
    expect(bound?.hostVisible).toBe(true);
    // The persisted child session id is the host-observed Tier-1 metadata id,
    // NOT the reviewer's self-reported value.
    expect(bound?.childSessionId).toBe(CHILD_SESSION);
  });

  it('REGRESSION: confabulated reviewer attestation still binds host-authoritatively', async () => {
    // The other shipped bug: the reviewer self-attested host constants
    // (mandateDigest/criteriaVersion) it was never given and confabulated them;
    // binding hard-failed with field_mismatch. Through the real Task after-hook,
    // a confabulated attestation must still bind, and the persisted evidence must
    // carry the host-authoritative constants — not the reviewer's invented ones.
    const { hooks, sessDir } = await setup();

    await driveCaptureThroughHooks(hooks, {
      mandateDigest: OBLIGATION_ID, // reviewer copied the UUID into the digest slot
      criteriaVersion: 'plan-review-v1', // invented
    });

    const state = await readState(sessDir);
    const bound = (state?.reviewAssurance?.invocations ?? []).find(
      (inv) => inv.obligationId === OBLIGATION_ID,
    );
    expect(bound, 'confabulated attestation still produced bound evidence').toBeDefined();
    expect(bound?.invocationMode).toBe('host_subagent_task');
    const att = bound?.capturedRawFindings?.attestation as Record<string, unknown> | undefined;
    expect(att?.mandateDigest).toBe(REVIEW_MANDATE_DIGEST);
    expect(att?.criteriaVersion).toBe(REVIEW_CRITERIA_VERSION);
  });

  it('REGRESSION: verdict with a mismatched submitted-findings session is NOT blocked', async () => {
    // This is the exact runtime shape that shipped as SUBAGENT_SESSION_MISMATCH.
    const { hooks } = await setup();
    await driveCaptureThroughHooks(hooks);

    const beforeHook = hooks['tool.execute.before']!;
    const verdictCall = beforeHook(
      { tool: 'flowguard_plan', sessionID: PARENT_SESSION, callID: 'c-verdict' },
      {
        args: {
          reviewVerdict: 'accept',
          // Agent (disobediently) includes the reviewer findings; the host cannot
          // have given it the real child session id, so this never matches.
          reviewFindings: {
            overallVerdict: 'accept',
            blockingIssues: [],
            reviewedBy: { sessionId: 'ses_agent_cannot_know_this' },
          },
        },
      },
    );

    // host_task_required must NOT hard-block the verdict on the ignored payload.
    await expect(verdictCall).resolves.toBeUndefined();
  });

  it('verdict-only (no findings) is allowed through the real before-hook', async () => {
    const { hooks } = await setup();
    await driveCaptureThroughHooks(hooks);

    const beforeHook = hooks['tool.execute.before']!;
    await expect(
      beforeHook(
        { tool: 'flowguard_plan', sessionID: PARENT_SESSION, callID: 'c-verdict' },
        { args: { reviewVerdict: 'accept' } },
      ),
    ).resolves.toBeUndefined();
  });

  it('changes_requested verdict with submitted findings is NOT blocked at enforcement', async () => {
    const { hooks } = await setup();
    await driveCaptureThroughHooks(hooks, { verdict: 'changes_requested' });

    const beforeHook = hooks['tool.execute.before']!;
    await expect(
      beforeHook(
        { tool: 'flowguard_plan', sessionID: PARENT_SESSION, callID: 'c-verdict' },
        {
          args: {
            reviewVerdict: 'changes_requested',
            planText: '## Plan\n1. Implement X (revised)',
            reviewFindings: {
              overallVerdict: 'changes_requested',
              blockingIssues: [],
              reviewedBy: { sessionId: 'ses_agent_cannot_know_this' },
            },
          },
        },
      ),
    ).resolves.toBeUndefined();
  });
});
