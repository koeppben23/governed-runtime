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

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

vi.mock('../adapters/gh-cli', () => ({
  resolvePullRequestReviewSource: vi.fn().mockImplementation((pullRequestNumber: number) => ({
    pullRequestNumber,
    baseRepository: { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' },
    headRepository: { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' },
    baseSha: 'b'.repeat(40),
    headSha: 'a'.repeat(40),
  })),
  loadResolvedPullRequestDiff: vi
    .fn()
    .mockReturnValue('diff --git a/docs/test.md b/docs/test.md\n+pr line'),
  resolveBranchReviewSource: vi.fn().mockImplementation((branch: string) => ({
    branch,
    baseBranch: 'main',
    resolvedBranchSha: 'a'.repeat(40),
    resolvedBaseSha: 'b'.repeat(40),
    repository: { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' },
  })),
  loadResolvedBranchDiff: vi
    .fn()
    .mockReturnValue('diff --git a/docs/test.md b/docs/test.md\n+resolved line'),
  loadBranchChangedFiles: vi.fn().mockReturnValue(['docs/test.md']),
}));
import { FlowGuardAuditPlugin } from './plugin.js';
import { review } from './tools/index.js';
import { makeState } from '../fixtures.js';
import { createTestWorkspace } from './test-helpers.js';
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
import { renderReviewerTaskPrompt } from './review/prompt-builders.js';
import type { SessionState } from '../state/schema.js';
import { computeRecordDigest } from '../state/evidence-plan.js';
import { CHALLENGE_POLICY_V1 } from '../config/policy-types.js';

const execFileAsync = promisify(execFile);

const PARENT_SESSION = 'ses_parent_e2e';
const CHILD_SESSION = 'ses_child_real_e2e';
const RETRY_CHILD_SESSION = 'ses_child_retry_e2e';
const OBLIGATION_ID = '2a8f1c40-1111-4aaa-8bbb-cccccccccccc';
const ATTEMPT_ID = '3b9f1c40-2222-4aaa-8bbb-cccccccccccc';
const SUBJECT_DIGEST = 'e2e-plan-subject-digest';

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
      // The real flowguard_plan emits the attempt id alongside the obligation
      // id (assurance.ts buildReviewRequiredPayload). Enforcement tracking
      // parses it into the pending review, and the Task after-hook binds the
      // reviewer child session to exactly this attempt.
      reviewAttemptId: ATTEMPT_ID,
      reviewCriteriaVersion: REVIEW_CRITERIA_VERSION,
      reviewMandateDigest: REVIEW_MANDATE_DIGEST,
      reviewerTaskPrompt: renderReviewerTaskPrompt({
        iteration: 0,
        planVersion: 1,
        obligationId: OBLIGATION_ID,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        subjectLabel: 'the plan',
      }),
      next: 'INDEPENDENT_REVIEW_REQUIRED: iteration=0, planVersion=1',
    }),
    metadata: {},
  };
}

function reviewerTaskOutput(
  opts: {
    childSessionId?: string;
    verdict?: string;
  } = {},
): { output: string; metadata: Record<string, unknown> } {
  const { childSessionId = CHILD_SESSION, verdict = 'accept' } = opts;
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
      attestation: {
        toolObligationId: OBLIGATION_ID,
      },
    }),
    // Tier 1 host metadata: the authoritative child session id the host observed.
    metadata: { sessionID: childSessionId },
  };
}

function reviewerArgsFromReviewRequiredOutput(output: string) {
  const reviewerTaskPrompt = (JSON.parse(output) as Record<string, unknown>).reviewerTaskPrompt;
  if (typeof reviewerTaskPrompt !== 'string') {
    throw new TypeError('Expected canonical reviewerTaskPrompt in review-required output');
  }
  return { subagent_type: 'flowguard-reviewer', prompt: reviewerTaskPrompt };
}

async function seedHostTaskPlanSession(worktree: string, sessionID: string): Promise<string> {
  const now = new Date().toISOString();
  const fp = await computeFingerprint(worktree);
  const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
  const reviewMaterial = freezeReviewMaterial('## Plan\n1. Implement X', SUBJECT_DIGEST);
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
          recordDigest: computeRecordDigest({
            contentDigest: 'plan-digest',
            planVersion: 1,
            supersedesRecordDigest: null,
            originatingReviewObligationId: null,
            revisionReason: null,
          }),
          planVersion: 1,
          supersedesRecordDigest: null,
          originatingReviewObligationId: null,
          revisionReason: null,
          lineageStatus: 'verified' as const,
        },
        history: [],
        reviewCompletion: 'pending',
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
        assuranceSchemaVersion: 'review-assurance.v6' as const,
        obligations: [
          {
            obligationId: OBLIGATION_ID,
            obligationType: 'plan',
            repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
            iteration: 0,
            planVersion: 1,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            maxReviewerOutputRepairAttempts: 1,
            subjectDigest: SUBJECT_DIGEST,
            createdAt: now,
            pluginHandshakeAt: null,
            status: 'pending',
            invocationId: null,
            blockedCode: null,
            fulfilledAt: null,
            consumedAt: null,
            reviewSubjectScope: {
              kind: 'artifact',
              artifact: {
                kind: 'plan',
                digest: SUBJECT_DIGEST,
                sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'Plan' }]],
              },
            },
            reviewMaterial,
          },
        ],
        invocations: [],
        // Production records the attempt when the obligation is created, before
        // the reviewer subagent runs. The attempt is deliberately UNBOUND here:
        // the host binds the real child session id at Task time, and
        // bindAttemptSession rejects an already-bound attempt.
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
        dispatches: [],
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
  } = {},
): Promise<void> {
  const beforeHook = hooks['tool.execute.before']!;
  const afterHook = hooks['tool.execute.after']!;
  const planOutput = { title: 'Plan', ...planModeAOutput() };
  await afterHook(
    { tool: 'flowguard_plan', sessionID: PARENT_SESSION, callID: 'c-plan', args: {} },
    planOutput,
  );
  const reviewerArgs = reviewerArgsFromReviewRequiredOutput(planOutput.output);
  await beforeHook(
    { tool: 'task', sessionID: PARENT_SESSION, callID: 'c-task' },
    { args: reviewerArgs },
  );
  await afterHook(
    {
      tool: 'task',
      sessionID: PARENT_SESSION,
      callID: 'c-task',
      args: reviewerArgs,
    },
    { title: 'Reviewer task', ...reviewerTaskOutput(opts) },
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

  it('REGRESSION: host stamps canonical attestation after reviewer input binds', async () => {
    const { hooks, sessDir } = await setup();

    await driveCaptureThroughHooks(hooks);

    const state = await readState(sessDir);
    const bound = (state?.reviewAssurance?.invocations ?? []).find(
      (inv) => inv.obligationId === OBLIGATION_ID,
    );
    expect(bound, 'reviewer input produced host-stamped bound evidence').toBeDefined();
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

  it('standalone /review: real Call 1 + reviewer Task binds host-task evidence through the plugin hooks', async () => {
    // Closes the coverage gap: no test previously drove the standalone
    // flowguard_review (CONTENT_ANALYSIS) -> flowguard_review after-hook
    // (orchestrator handshake) -> reviewer Task after-hook -> buildHostTaskEvidence
    // path against real persisted state. The review obligation created by Call 1
    // must remain pending through the handshake so the reviewer Task binds a
    // host_subagent_task invocation (the field reported as pendingObligationCount).
    const ws = await createTestWorkspace();
    cleanup = ws.cleanup;
    await initGitRepo(ws.tmpDir);

    // Seed a READY-phase session (host_task_required) with NO pre-existing review
    // obligation — Call 1 must create it.
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, PARENT_SESSION);
    await fs.mkdir(sessDir, { recursive: true });
    const base = makeState('READY');
    await writeState(
      sessDir,
      makeState('READY', {
        policySnapshot: {
          ...base.policySnapshot,
          challengePolicy: CHALLENGE_POLICY_V1,
          reviewInvocationPolicy: 'host_task_required',
        },
        // The canonical persisted-Discovery identity the snapshot binds to.
        discoveryDigest: 'd'.repeat(64),
        // The real worktree — the attempt-bound Discovery resolution reads the
        // persisted basis via the workspace fingerprint of THIS worktree.
        binding: { ...base.binding, worktree: ws.tmpDir },
      }),
    );

    // Seed the persisted Discovery basis the way hydrate does: the attempt-bound
    // repository Discovery snapshot is resolved at mint time and requires a
    // host-owned persisted Discovery artifact.
    const { workspaceDir: resolveWorkspaceDir } = await import('../adapters/workspace/index.js');
    const { writeDiscovery } = await import('../adapters/persistence-discovery.js');
    const { runRequiredDiscovery } = await import('./tools/hydrate-discovery.js');
    const wsDir = resolveWorkspaceDir(fp.fingerprint);
    const discoveryResult = await runRequiredDiscovery(ws.tmpDir, fp.fingerprint, {
      files: [],
      packageFiles: [],
      configFiles: [],
      packageFilePaths: [],
      configFilePaths: [],
    });
    await writeDiscovery(wsDir, discoveryResult);

    const ctx = {
      sessionID: PARENT_SESSION,
      worktree: ws.tmpDir,
      directory: ws.tmpDir,
      messageID: 'm1',
      agent: 'build',
      abort: new AbortController().signal,
      metadata: () => {},
    } as unknown as Parameters<typeof review.execute>[1];

    // Call 1: content-aware /review with a BRANCH reference (the reported failing
    // invocation was `/review branch=feature/add-due-date`) -> CONTENT_ANALYSIS_REQUIRED.
    const call1Raw = await review.execute(
      {
        branch: 'feature-add-due-date',
        inputOrigin: 'branch',
        targetPaths: ['docs/test.md'],
      },
      ctx,
    );
    const call1 = JSON.parse(String(call1Raw)) as Record<string, unknown>;
    expect(call1.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    const att = call1.requiredReviewAttestation as Record<string, unknown>;
    const obligationId = att.toolObligationId as string;
    expect(typeof obligationId).toBe('string');

    // The obligation must be persisted and pending after Call 1.
    const afterCall1 = await readState(sessDir);
    // Call 1 must persist the obligation AND its attempt: the attempt is what the
    // host later binds the reviewer child session to.
    expect(
      (afterCall1?.reviewAssurance?.attempts ?? []).filter(
        (a) => a.obligationType === 'review' && a.status === 'created' && !a.childSessionId,
      ),
      'bindable attempt persisted by Call 1',
    ).toHaveLength(1);
    const initialAttempt = (afterCall1?.reviewAssurance?.attempts ?? [])[0];
    expect(initialAttempt?.reviewMaterial).toMatchObject({
      content: expect.any(String),
      materialDigest: expect.any(String),
      subjectDigest: expect.any(String),
    });
    const pendingAfterCall1 = (afterCall1?.reviewAssurance?.obligations ?? []).filter(
      (o) => o.obligationType === 'review' && o.status === 'pending',
    );
    expect(pendingAfterCall1.length, 'pending review obligation after Call 1').toBe(1);
    const pendingObligation = pendingAfterCall1[0];
    const reviewSubject = pendingObligation?.reviewSubject;
    expect(pendingObligation?.subjectDigest).toBe(reviewSubject?.subjectDigest);
    expect(reviewSubject?.kind).toBe('repository_change');
    if (reviewSubject?.kind === 'repository_change') {
      expect(pendingObligation?.reviewSubjectScope).toMatchObject({
        kind: 'repository_change',
        paths: reviewSubject.changedPaths,
      });
    }
    expect(initialAttempt?.reviewMaterial?.materialDigest).toBe(reviewSubject?.materialDigest);
    await writeState(sessDir, {
      ...afterCall1!,
      reviewAssurance: {
        ...afterCall1!.reviewAssurance!,
        obligations: afterCall1!.reviewAssurance!.obligations.map((obligation) =>
          obligation.obligationId === obligationId
            ? {
                ...obligation,
                reviewSubjectScope: {
                  kind: 'repository_change' as const,
                  paths: ['docs/test.md'],
                  revisions: ['base', 'head'],
                },
              }
            : obligation,
        ),
      },
    });

    const hooks = await FlowGuardAuditPlugin({
      project: {} as unknown,
      client: strictNoSdkClient(),
      $: {} as unknown,
      directory: ws.tmpDir,
      worktree: ws.tmpDir,
      serverUrl: new URL('http://localhost:3000'),
    } as Parameters<typeof FlowGuardAuditPlugin>[0]);
    const beforeHook = hooks['tool.execute.before']!;
    const afterHook = hooks['tool.execute.after']!;

    // flowguard_review after-hook: the orchestrator runs handleHostTaskPolicy
    // (host-task handshake) on the SAME output the tool returned.
    const reviewOut = { title: 'Review', output: String(call1Raw), metadata: {} };
    await afterHook(
      { tool: 'flowguard_review', sessionID: PARENT_SESSION, callID: 'c-review', args: {} },
      reviewOut,
    );
    {
      // The handshake rewrite is the emitter of INDEPENDENT_REVIEW_REQUIRED on
      // this path, so it must also surface the attempt the host binds to.
      const rewritten = JSON.parse(reviewOut.output) as Record<string, unknown>;
      expect(String(rewritten.next ?? '')).toContain('INDEPENDENT_REVIEW_REQUIRED');
      expect(rewritten.reviewAttemptId).toBe(
        (afterCall1?.reviewAssurance?.attempts ?? [])[0]?.attemptId,
      );
      // Presentation/code consistency: the orchestrator rewrote the canonical
      // code, so the operator-facing presentation must carry the SAME reason
      // code — never the stale pre-rewrite one.
      const presentationMarkdown = String(
        (rewritten.presentation as Record<string, unknown> | undefined)?.markdown ?? '',
      );
      expect(rewritten.code).toBe('HOST_SUBAGENT_TASK_REQUIRED');
      expect(presentationMarkdown).toContain('HOST_SUBAGENT_TASK_REQUIRED');
      expect(presentationMarkdown).not.toContain('CONTENT_ANALYSIS_REQUIRED');
      // Presentation recovery and canonical recovery share one authority: both
      // route through the host-visible Task invocation with the reviewer
      // subagent, never through a different code's recovery path.
      expect(presentationMarkdown).toContain(
        'Run the FlowGuard reviewer subagent via the OpenCode Task tool.',
      );
      expect(String(rewritten.recovery ?? '')).toContain('host-visible subagent invocation');
      expect(String(rewritten.recovery ?? '')).not.toContain('CONTENT_ANALYSIS_REQUIRED');
    }

    // The obligation must STILL be pending after the handshake (the log shows it
    // becomes 0 — that is the bug).
    const afterHandshake = await readState(sessDir);
    const pendingAfterHandshake = (afterHandshake?.reviewAssurance?.obligations ?? []).filter(
      (o) => o.obligationType === 'review' && o.status === 'pending',
    );
    expect(
      pendingAfterHandshake.length,
      'pending review obligation after flowguard_review after-hook (handshake)',
    ).toBe(1);

    const attemptA = (afterHandshake?.reviewAssurance?.attempts ?? []).find(
      (attempt) => attempt.obligationId === obligationId,
    );
    // The repository attempt is born with its host-owned Discovery snapshot:
    // resolved BEFORE the mint, never mutated afterwards.
    expect(attemptA?.repositoryDiscovery.kind).toBe('repository');
    if (attemptA?.repositoryDiscovery.kind === 'repository') {
      // The snapshot binds the CANONICAL persisted-Discovery digest — never the
      // workspace fingerprint (stored separately).
      expect(attemptA.repositoryDiscovery.snapshot.discoveryDigest).toBe('d'.repeat(64));
      expect(attemptA.repositoryDiscovery.snapshot.workspaceFingerprint).toEqual(
        expect.any(String),
      );
      expect(attemptA.repositoryDiscovery.snapshot.health.status).toBeTypeOf('string');
    }
    const initialHypothesisCount = afterHandshake?.proofGraph?.claims.length ?? 0;
    expect(initialHypothesisCount).toBeGreaterThan(0);
    const reviewerArgsA = reviewerArgsFromReviewRequiredOutput(reviewOut.output);

    // Attempt A returns no overallVerdict. The host must persist the exact
    // attempt as extraction_invalid so the normal /review repair authority can
    // mint a fresh canonical prompt instead of stranding a child-bound attempt.
    await beforeHook(
      { tool: 'task', sessionID: PARENT_SESSION, callID: 'c-task-a' },
      { args: reviewerArgsA },
    );
    await afterHook(
      {
        tool: 'task',
        sessionID: PARENT_SESSION,
        callID: 'c-task-a',
        args: reviewerArgsA,
      },
      {
        title: 'Reviewer task',
        output: JSON.stringify({
          iteration: 1,
          planVersion: 1,
          reviewMode: 'subagent',
          // overallVerdict intentionally omitted: extraction returns no payload.
          blockingIssues: [],
          majorRisks: [],
          missingVerification: [],
          scopeCreep: [],
          unknowns: [],
          attestation: {
            toolObligationId: obligationId,
          },
        }),
        metadata: { sessionID: CHILD_SESSION },
      },
    );

    const afterRejectedA = await readState(sessDir);
    expect(afterRejectedA?.reviewAssurance?.invocations ?? []).toHaveLength(0);
    expect(
      afterRejectedA?.reviewAssurance?.attempts.find(
        (attempt) => attempt.attemptId === attemptA?.attemptId,
      )?.status,
    ).toBe('rejected');
    expect(
      afterRejectedA?.reviewAssurance?.attempts.find(
        (attempt) => attempt.attemptId === attemptA?.attemptId,
      )?.rejectionReason,
    ).toBe('extraction_invalid');

    // The actual standalone continuation creates attempt B, emits the canonical
    // retry signal, and the review after-hook registers B for Task binding.
    const retryRaw = await review.execute(
      {
        branch: 'feature-add-due-date',
        inputOrigin: 'branch',
        reviewObligationId: obligationId,
      },
      ctx,
    );
    const retry = JSON.parse(String(retryRaw)) as Record<string, unknown>;
    expect(retry.code).toBe('CONTENT_ANALYSIS_REQUIRED');

    const retryOut = { title: 'Review retry', output: String(retryRaw), metadata: {} };
    await afterHook(
      {
        tool: 'flowguard_review',
        sessionID: PARENT_SESSION,
        callID: 'c-review-retry',
        args: {
          branch: 'feature-add-due-date',
          inputOrigin: 'branch',
          targetPaths: ['docs/test.md'],
          reviewObligationId: obligationId,
        },
      },
      retryOut,
    );
    const trackedRetry = JSON.parse(retryOut.output) as Record<string, unknown>;
    expect(trackedRetry.code).toBe('HOST_SUBAGENT_TASK_REQUIRED');
    const afterReissue = await readState(sessDir);
    const attemptB = (afterReissue?.reviewAssurance?.attempts ?? []).find(
      (attempt) => attempt.attemptId === trackedRetry.reviewAttemptId,
    );
    expect(attemptB).toMatchObject({ obligationId, status: 'created' });
    expect(afterReissue?.proofGraph?.claims).toHaveLength(initialHypothesisCount);
    expect(
      (afterReissue?.standaloneReviewEvidence ?? []).filter((entry) => entry.kind === 'prepared'),
    ).toHaveLength(1);
    expect(trackedRetry.reviewAttemptId).toBe(attemptB?.attemptId);
    expect(typeof trackedRetry.reviewerTaskPrompt).toBe('string');
    const retryPrompt = trackedRetry.reviewerTaskPrompt as string;

    // Attempt B binds through the real Task after-hook and supplies the evidence
    // consumed by the matching standalone review verdict.
    const taskBOut = {
      title: 'Reviewer task',
      output: JSON.stringify({
        iteration: 1,
        planVersion: 1,
        reviewMode: 'subagent',
        overallVerdict: 'changes_requested',
        blockingIssues: [],
        majorRisks: [],
        missingVerification: [],
        scopeCreep: [],
        unknowns: [],
        attestation: {
          toolObligationId: obligationId,
        },
      }),
      metadata: { sessionID: RETRY_CHILD_SESSION },
    };
    const reviewerArgsB = { subagent_type: 'flowguard-reviewer', prompt: retryPrompt };
    await beforeHook(
      { tool: 'task', sessionID: PARENT_SESSION, callID: 'c-task-b' },
      { args: reviewerArgsB },
    );
    await afterHook(
      {
        tool: 'task',
        sessionID: PARENT_SESSION,
        callID: 'c-task-b',
        args: reviewerArgsB,
      },
      taskBOut,
    );
    expect(taskBOut.output).not.toContain('HOST_SUBAGENT_TASK_REQUIRED');

    // The host-task evidence must be bound to the review obligation.
    const finalState = await readState(sessDir);
    const bound = (finalState?.reviewAssurance?.invocations ?? []).find(
      (inv) => inv.obligationId === obligationId,
    );
    expect(
      bound,
      'host_subagent_task invocation evidence bound for the /review obligation',
    ).toBeDefined();
    expect(bound?.invocationMode).toBe('host_subagent_task');
    expect(bound?.hostVisible).toBe(true);
    expect(bound?.attemptId).toBe(attemptB?.attemptId);
    expect(
      (finalState?.reviewAssurance?.obligations ?? []).filter(
        (item) => item.obligationType === 'review',
      ),
    ).toHaveLength(1);

    // An unrelated active review without captured lineage must not make this
    // continuation ambiguous. A no-ID verdict still never mutates state.
    const boundObligation = finalState?.reviewAssurance?.obligations.find(
      (item) => item.obligationId === obligationId,
    );
    if (!boundObligation) throw new TypeError('Expected bound standalone review obligation');
    await writeState(sessDir, {
      ...finalState!,
      reviewAssurance: {
        ...finalState!.reviewAssurance!,
        obligations: [
          ...finalState!.reviewAssurance!.obligations,
          {
            ...boundObligation,
            obligationId: '4c9f1c40-3333-4aaa-8bbb-cccccccccccc',
            invocationId: null,
            status: 'pending',
            fulfilledAt: null,
            consumedAt: null,
            reviewSubjectScope: {
              kind: 'repository_change',
              paths: ['docs/test.md'],
              revisions: ['base', 'head'],
            },
          },
        ],
      },
    });
    const beforeNoId = JSON.stringify(await readState(sessDir));
    const noId = JSON.parse(
      String(await review.execute({ reviewVerdict: 'changes_requested' }, ctx)),
    ) as Record<string, unknown>;
    expect(noId.code).toBe('REVIEW_OBLIGATION_ID_REQUIRED');
    expect(JSON.stringify(await readState(sessDir))).toBe(beforeNoId);

    // The exact A/A1 lineage and matching captured verdict complete once.
    const completion = JSON.parse(
      String(
        await review.execute(
          {
            branch: 'feature-add-due-date',
            inputOrigin: 'branch',
            targetPaths: ['docs/test.md'],
            reviewObligationId: obligationId,
            reviewVerdict: 'changes_requested',
          },
          ctx,
        ),
      ),
    ) as Record<string, unknown>;
    expect(completion.phase).toBe('REVIEW_COMPLETE');
    expect(completion.reviewCard).toContain('host_subagent_task');
    expect(completion.reviewCard).toContain(RETRY_CHILD_SESSION);
    const consumed = await readState(sessDir);
    const consumedInvocation = consumed?.reviewAssurance?.invocations.find(
      (item) => item.invocationId === bound?.invocationId,
    );
    const obligation = consumed?.reviewAssurance?.obligations.find(
      (item) => item.obligationId === obligationId,
    );
    expect(obligation?.status).toBe('consumed');
    expect(obligation?.reviewSubject).toMatchObject({
      kind: 'repository_change',
      baseRepository: { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' },
      headRepository: { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' },
      baseSha: 'b'.repeat(40),
      headSha: 'a'.repeat(40),
    });
    expect(obligation?.subjectDigest).toBe(obligation?.reviewSubject?.subjectDigest);
    // The lifecycle chain projects ONLY the authoritative review task: the
    // verdict continuation and the retry must not duplicate hypothesis claims.
    expect(consumed?.proofGraph?.claims).toHaveLength(3);
    expect(consumed?.proofGraph?.claims.every((c) => c.signalClass === 'hypothesis')).toBe(true);
    // Gate 3: the projected claimIds are exactly the authoritative (latest
    // prepared) incarnation's claimIds — no duplicate, no stale-predecessor set.
    const authoritativePrepared = (consumed?.standaloneReviewEvidence ?? [])
      .filter((entry) => entry.kind === 'prepared')
      .at(-1);
    if (authoritativePrepared?.kind !== 'prepared') {
      throw new TypeError('expected prepared review evidence');
    }
    expect((consumed?.proofGraph?.claims ?? []).map((claim) => claim.claimId).sort()).toEqual(
      authoritativePrepared.task.claims.map((claim) => claim.claimId).sort(),
    );
    // The rejected reviewer attempt and its retry belong to ONE logical review
    // task: when the continuation re-prepares with a diverged subject digest,
    // the stale incarnation is kept for audit and structurally superseded —
    // but the projection still resolves exactly the authoritative task.
    const prepared = (consumed?.standaloneReviewEvidence ?? []).filter(
      (entry) => entry.kind === 'prepared',
    );
    const superseded = (consumed?.standaloneReviewEvidence ?? []).filter(
      (entry) => entry.kind === 'superseded',
    );
    expect(prepared).toHaveLength(2);
    expect(superseded).toHaveLength(1);
    expect(superseded[0]).toMatchObject({
      supersededPreparedEvidenceId: prepared[0]?.evidenceId,
      replacementPreparedEvidenceId: prepared[1]?.evidenceId,
      reason: 'subject_frozen',
    });
    expect(consumedInvocation?.consumedByObligationId).toBe(obligationId);
    expect(consumed?.standaloneReviewEvidence.at(-1)).toMatchObject({
      kind: 'completed',
      preparedEvidenceId: prepared[1]?.evidenceId,
      findingsDigest: expect.any(String),
      attestationDigest: expect.any(String),
    });
  });
});
