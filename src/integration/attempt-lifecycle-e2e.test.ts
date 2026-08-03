/**
 * @module integration/attempt-lifecycle-e2e.test
 * @description Contract: the reviewer attempt state machine, driven through the
 * real plugin hooks.
 *
 * These assertions exercise `bindAttemptSession` via `tool.execute.after`, not a
 * selector in isolation. `findBindableAttempt` only decides which attempt is
 * ADVERTISED as bindable; it does not guard the state-mutating bind path, so a
 * test of that selector cannot prove that a settled attempt is refused.
 *
 * The invariant under test: one obligation carries at most one evidence record.
 * A `bound` attempt that is re-armed keeps its evidence AND opens a second
 * attempt, which breaks exactly that.
 *
 * @test-policy HAPPY, EDGE - one case per attempt status plus obligation status.
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
import type { ReviewAttempt, ReviewAttemptStatus } from '../state/evidence-review.js';
import type { ReviewObligationStatus } from '../state/evidence-primitives.js';

const execFileAsync = promisify(execFile);

const OBLIGATION_ID = '33333333-1111-4111-8111-111111111111';
const ATTEMPT_ID = '33333333-2222-4111-8111-111111111111';
const SUBJECT_DIGEST = 'lifecycle-plan-subject-digest';
const CHILD_FIRST = 'ses_child_lifecycle_first';
const CHILD_RETRY = 'ses_child_lifecycle_retry';

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

interface SeedOptions {
  readonly attemptStatus?: ReviewAttemptStatus;
  readonly attemptChildSessionId?: string;
  readonly obligationStatus?: ReviewObligationStatus;
}

/** Seed a PLAN session whose single attempt is in a chosen lifecycle state. */
async function seedSession(
  worktree: string,
  sessionID: string,
  options: SeedOptions = {},
): Promise<string> {
  const now = new Date().toISOString();
  const fp = await computeFingerprint(worktree);
  const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
  await fs.mkdir(sessDir, { recursive: true });

  const obligationStatus = options.obligationStatus ?? 'pending';
  const attempt: ReviewAttempt = {
    attemptId: ATTEMPT_ID,
    obligationId: OBLIGATION_ID,
    obligationType: 'plan',
    subjectDigest: SUBJECT_DIGEST,
    ordinal: 0,
    status: options.attemptStatus ?? 'created',
    createdAt: now,
    ...(options.attemptChildSessionId ? { childSessionId: options.attemptChildSessionId } : {}),
  };

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
            status: obligationStatus,
            invocationId: null,
            blockedCode: null,
            fulfilledAt: obligationStatus === 'pending' ? null : now,
            consumedAt: obligationStatus === 'consumed' ? now : null,
            subjectDigest: SUBJECT_DIGEST,
          },
        ],
        invocations: [],
        attempts: [attempt],
      },
    }),
  );
  return sessDir;
}

function planReviewRequiredOutput(): string {
  return JSON.stringify({
    phase: 'PLAN',
    selfReviewIteration: 0,
    reviewMode: 'subagent',
    reviewObligationId: OBLIGATION_ID,
    reviewAttemptId: ATTEMPT_ID,
    reviewCriteriaVersion: REVIEW_CRITERIA_VERSION,
    reviewMandateDigest: REVIEW_MANDATE_DIGEST,
    next: 'INDEPENDENT_REVIEW_REQUIRED: iteration=0, planVersion=1',
  });
}

function reviewerOutput(childSessionId: string): string {
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
    reviewedBy: { sessionId: childSessionId },
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

/** Reviewer output without a verdict: not bindable, so the attempt is spent. */
function unusableReviewerOutput(childSessionId: string): string {
  const parsed = JSON.parse(reviewerOutput(childSessionId)) as Record<string, unknown>;
  delete parsed.overallVerdict;
  return JSON.stringify(parsed);
}

const reviewerArgs = {
  subagent_type: REVIEWER_SUBAGENT_TYPE,
  prompt: 'iteration=0, planVersion=1 - review this plan critically for the auth feature.',
};

describe('reviewer attempt lifecycle through the real hooks', () => {
  let configDir: string;
  let cleanupEnv: () => void;
  let cleanupWs: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-attempt-lifecycle-'));
    cleanupEnv = withTestEnv({
      OPENCODE_CONFIG_DIR: configDir,
      FLOWGUARD_REQUIRE_TEST_CONFIG_DIR: '1',
    });
  });

  afterEach(async () => {
    if (cleanupWs) await cleanupWs();
    cleanupWs = null;
    cleanupEnv();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  /** Drive plan + one reviewer Task through the real after-hook. */
  async function driveReviewerTask(
    options: SeedOptions,
    childSessionId: string,
    callID = 'call-1',
  ): Promise<string> {
    const ws = await createTestWorkspace();
    cleanupWs = ws.cleanup;
    await execFileAsync('git', ['init'], { cwd: ws.tmpDir });
    const sessionID = crypto.randomUUID();
    const sessDir = await seedSession(ws.tmpDir, sessionID, options);

    const hooks = await FlowGuardAuditPlugin(
      createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
    );
    const afterHook = hooks['tool.execute.after']!;

    await afterHook(
      { tool: 'flowguard_plan', sessionID, callID: 'call-plan', args: {} },
      { title: 'flowguard_plan', output: planReviewRequiredOutput(), metadata: {} },
    );
    await afterHook(
      { tool: 'task', sessionID, callID, args: reviewerArgs },
      { title: 'task', output: reviewerOutput(childSessionId), metadata: {} },
    );
    return sessDir;
  }

  // ─── Settled attempts must never be re-armed ────────────────────────────────

  it.each([['bound'], ['captured']] as const)(
    'refuses a %s attempt instead of opening a second one',
    async (attemptStatus) => {
      const sessDir = await driveReviewerTask(
        { attemptStatus, attemptChildSessionId: CHILD_FIRST },
        CHILD_RETRY,
      );

      const state = await readState(sessDir);
      // No second attempt, and no evidence attached through one.
      expect(state?.reviewAssurance?.attempts ?? []).toHaveLength(1);
      expect(state?.reviewAssurance?.invocations ?? []).toHaveLength(0);
      expect((state?.reviewAssurance?.attempts ?? [])[0]?.status).toBe(attemptStatus);
    },
  );

  it('a bound attempt cannot produce a second evidence record for the same obligation', async () => {
    // The core invariant: one obligation, at most one evidence record.
    const sessDir = await driveReviewerTask(
      { attemptStatus: 'bound', attemptChildSessionId: CHILD_FIRST },
      CHILD_RETRY,
    );

    const state = await readState(sessDir);
    const forObligation = (state?.reviewAssurance?.invocations ?? []).filter(
      (inv) => inv.obligationId === OBLIGATION_ID,
    );
    expect(forObligation).toHaveLength(0);
  });

  // ─── Settled obligations must never be re-armed ─────────────────────────────

  it.each([['fulfilled'], ['consumed'], ['blocked']] as const)(
    'refuses to re-arm under a %s obligation',
    async (obligationStatus) => {
      // `fulfilled` matters most: accepted evidence already exists, and the window
      // before consumption must not stay open for a second record.
      const sessDir = await driveReviewerTask(
        { attemptStatus: 'rejected', attemptChildSessionId: CHILD_FIRST, obligationStatus },
        CHILD_RETRY,
      );

      const state = await readState(sessDir);
      expect(state?.reviewAssurance?.attempts ?? []).toHaveLength(1);
      expect(state?.reviewAssurance?.invocations ?? []).toHaveLength(0);
    },
  );

  // ─── Spent attempts may be retried ──────────────────────────────────────────

  it.each([['rejected'], ['stale'], ['expired']] as const)(
    'allows an explicit retry after a %s attempt',
    async (attemptStatus) => {
      const sessDir = await driveReviewerTask(
        { attemptStatus, attemptChildSessionId: CHILD_FIRST },
        CHILD_RETRY,
      );

      const state = await readState(sessDir);
      const attempts = state?.reviewAssurance?.attempts ?? [];
      // A NEW attempt with its own id, correlated to the NEW child session.
      expect(attempts.length).toBeGreaterThan(1);
      const retry = attempts.find((a) => a.attemptId !== ATTEMPT_ID);
      expect(retry).toBeDefined();
      expect(retry?.childSessionId).toBe(CHILD_RETRY);
      expect(retry?.attemptId).not.toBe(ATTEMPT_ID);
    },
  );

  // ─── Retry from the SAME reviewer session (host `task_id` reuse) ────────────

  it.each([['rejected'], ['stale'], ['expired']] as const)(
    'allows a %s attempt to be retried from the same reviewer session',
    async (attemptStatus) => {
      // An agent that continues the reviewer subagent via `task_id` reuses the
      // child session. Refusing that outright stranded the obligation: the spent
      // attempt is no longer bindable either, so no path could produce evidence.
      const sessDir = await driveReviewerTask(
        { attemptStatus, attemptChildSessionId: CHILD_FIRST },
        CHILD_FIRST,
      );

      const state = await readState(sessDir);
      const attempts = state?.reviewAssurance?.attempts ?? [];
      const retry = attempts.find((a) => a.attemptId !== ATTEMPT_ID);

      expect(attempts.length).toBeGreaterThan(1);
      expect(retry?.childSessionId).toBe(CHILD_FIRST);
    },
  );

  it.each([['bound'], ['captured']] as const)(
    'still refuses a %s attempt retried from the same reviewer session',
    async (attemptStatus) => {
      // Narrowing the guard must not reopen the hole it was built for: a session
      // that already holds evidence may never bind a second record.
      const sessDir = await driveReviewerTask(
        { attemptStatus, attemptChildSessionId: CHILD_FIRST },
        CHILD_FIRST,
      );

      const state = await readState(sessDir);
      expect(state?.reviewAssurance?.attempts ?? []).toHaveLength(1);
      expect(state?.reviewAssurance?.invocations ?? []).toHaveLength(0);
    },
  );

  it('stales an interrupted created attempt before the retry takes over', async () => {
    // Correlated with an earlier child session but never captured: the retry must
    // not reuse that slot, and a late callback from it must not still bind.
    const sessDir = await driveReviewerTask(
      { attemptStatus: 'created', attemptChildSessionId: CHILD_FIRST },
      CHILD_RETRY,
    );

    const state = await readState(sessDir);
    const attempts = state?.reviewAssurance?.attempts ?? [];
    const interrupted = attempts.find((a) => a.attemptId === ATTEMPT_ID);
    const retry = attempts.find((a) => a.attemptId !== ATTEMPT_ID);

    expect(interrupted?.status).toBe('stale');
    expect(retry?.childSessionId).toBe(CHILD_RETRY);
  });

  // ─── The open slot is still taken normally ──────────────────────────────────

  it('binds an unbound created attempt to the reviewer session', async () => {
    const sessDir = await driveReviewerTask({ attemptStatus: 'created' }, CHILD_FIRST);

    const state = await readState(sessDir);
    const attempts = state?.reviewAssurance?.attempts ?? [];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attemptId).toBe(ATTEMPT_ID);
    expect((state?.reviewAssurance?.invocations ?? []).length).toBeGreaterThan(0);
  });

  // ─── Organic sequence: invocation, rejection, retry, late callback ──────────

  it('a late callback from the superseded session adds no second evidence record', async () => {
    // Reaches the retry state organically instead of seeding it, then replays the
    // FIRST reviewer session after it was superseded. The obligation must still
    // carry exactly one evidence record.
    const ws = await createTestWorkspace();
    cleanupWs = ws.cleanup;
    await execFileAsync('git', ['init'], { cwd: ws.tmpDir });
    const sessionID = crypto.randomUUID();
    const sessDir = await seedSession(ws.tmpDir, sessionID);

    const hooks = await FlowGuardAuditPlugin(
      createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
    );
    const afterHook = hooks['tool.execute.after']!;

    await afterHook(
      { tool: 'flowguard_plan', sessionID, callID: 'call-plan', args: {} },
      { title: 'flowguard_plan', output: planReviewRequiredOutput(), metadata: {} },
    );

    // 1. First reviewer returns an unusable capture: the attempt is spent.
    await afterHook(
      { tool: 'task', sessionID, callID: 'call-1', args: reviewerArgs },
      { title: 'task', output: unusableReviewerOutput(CHILD_FIRST), metadata: {} },
    );
    const afterFirst = await readState(sessDir);
    expect(afterFirst?.reviewAssurance?.invocations ?? []).toHaveLength(0);

    // 2. Retry from a new session: re-arm, bind, evidence recorded.
    await afterHook(
      { tool: 'task', sessionID, callID: 'call-2', args: reviewerArgs },
      { title: 'task', output: reviewerOutput(CHILD_RETRY), metadata: {} },
    );
    const afterRetry = await readState(sessDir);
    expect(afterRetry?.reviewAssurance?.invocations ?? []).toHaveLength(1);

    // 3. The superseded first session calls back late.
    await afterHook(
      { tool: 'task', sessionID, callID: 'call-late', args: reviewerArgs },
      { title: 'task', output: reviewerOutput(CHILD_FIRST), metadata: {} },
    );

    const finalState = await readState(sessDir);
    const forObligation = (finalState?.reviewAssurance?.invocations ?? []).filter(
      (inv) => inv.obligationId === OBLIGATION_ID,
    );
    expect(forObligation, 'one obligation carries at most one evidence record').toHaveLength(1);
    expect(forObligation[0]?.childSessionId).toBe(CHILD_RETRY);
  });
});
