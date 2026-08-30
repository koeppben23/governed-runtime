/**
 * @module integration/implementation-review-no-observation-e2e.test
 * @description Decisive end-to-end scenario for the implementation subject
 *              model (#816 follow-up): a full /implement review WITHOUT any
 *              repository observation authority.
 *
 *   - the implementation review obligation mints an `implementation` subject
 *     scope bound to the implementation digest (repository authority absent:
 *     provenance unavailable, discovery not_applicable, no observation
 *     capability);
 *   - a genuine `changes_requested` reviewer verdict with an implementation
 *     subject anchor and `evidenceLocations: []` BINDS and routes back to
 *     IMPLEMENTATION;
 *   - re-recording the implementation mints a FRESH obligation (iteration 2);
 *   - a second reviewer accepts → EVIDENCE_REVIEW.
 *
 * This pins the orthogonality invariant end to end: reviewability is
 * digest-bound; repository evidence authority is optional.
 *
 * @test-policy HAPPY (the scenario itself is the negative-path proof)
 */

import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The scenario verifies the REVIEW subject model — check execution itself is
// not under test: the executor mock returns deterministic passing results.
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

vi.mock('./review/discovery-attempt-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./review/discovery-attempt-context.js')>();
  return {
    ...actual,
    resolveAttemptDiscoveryOrBlock: vi.fn(actual.resolveAttemptDiscoveryOrBlock),
  };
});

import { readState } from '../adapters/persistence.js';
import { hashWorktreeFiles } from '../adapters/git.js';
import { hashText } from '../shared/hashing.js';
import { sessionDir } from '../adapters/workspace/index.js';
import { computeFingerprint } from '../adapters/workspace/fingerprint.js';
import { writeStateWithArtifacts } from './tools/helpers.js';
import { hydrate } from './tools/hydrate.js';
import { ticket } from './tools/ticket-tool.js';
import { plan } from './tools/plan.js';
import { implement, review_implementation } from './tools/implement.js';
import { run_check } from './tools/run-check-tool.js';
import type { ToolContext } from './tools/helpers.js';
import { makeState, TICKET, FROZEN_IMPLEMENTATION_BASE } from '../fixtures.js';
import type { SessionState } from '../state/schema.js';
import type { ReviewFindings } from '../state/evidence.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  hashFindings,
} from './review/assurance.js';
import { resolveAttemptDiscoveryOrBlock } from './review/discovery-attempt-context.js';
import { resolveNextAction, ACTION_CODES } from '../machine/next-action.js';
import { executeCheck } from '../verification/executor.js';

const FIXED_TIME = '2026-08-15T14:00:00.000Z';

interface SE {
  rootDir: string;
  worktree: string;
  configDir: string;
  sId: string;
  sDir: string;
  tc: ToolContext;
}

let s: SE | undefined;
let pc: string | undefined;
let pr: string | undefined;
let pp: string | undefined;

beforeEach(() => {
  pc = process.env.OPENCODE_CONFIG_DIR;
  pr = process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
  pp = process.env.FLOWGUARD_HOST_PLATFORM;
  vi.mocked(resolveAttemptDiscoveryOrBlock).mockClear();
});

afterEach(() => {
  if (pc === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = pc;
  if (pr === undefined) delete process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
  else process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = pr;
  if (pp === undefined) delete process.env.FLOWGUARD_HOST_PLATFORM;
  else process.env.FLOWGUARD_HOST_PLATFORM = pp;
  if (s) {
    rmSync(s.rootDir, { recursive: true, force: true });
    s = undefined;
  }
});

async function boot(): Promise<SE> {
  const r = mkdtempSync(join(tmpdir(), 'fg-impl-no-obs-'));
  const w = join(r, 'worktree'),
    c = join(r, 'config'),
    id = randomUUID();
  mkdirSync(w, { recursive: true });
  mkdirSync(c, { recursive: true });
  execSync('git init && git config user.email t@t && git config user.name T', {
    cwd: w,
    stdio: 'pipe',
  });
  writeFileSync(join(w, 'README.md'), '# E2E');
  execSync(
    'git add README.md && git commit -m init && git remote add origin https://github.com/fg/e2e.git',
    { cwd: w, stdio: 'pipe' },
  );
  process.env.OPENCODE_CONFIG_DIR = c;
  process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';
  process.env.FLOWGUARD_HOST_PLATFORM = 'opencode';
  const tc: ToolContext = {
    sessionID: id,
    messageID: randomUUID(),
    agent: 'test',
    directory: w,
    worktree: w,
    abort: new AbortController().signal,
    metadata: () => {},
  };
  const hydrated = await hydrate.execute({ policyMode: 'solo', profileId: 'baseline' }, tc);
  if (typeof hydrated !== 'string' || hydrated.includes('"error":true')) {
    throw new Error(`boot hydrate failed: ${String(hydrated).slice(0, 400)}`);
  }
  const fp = await computeFingerprint(w);
  return {
    rootDir: r,
    worktree: w,
    configDir: c,
    sId: id,
    sDir: sessionDir(fp.fingerprint, id),
    tc,
  };
}

/** Host-orchestrated reviewer evidence with an implementation subject anchor. */
function implFindings(
  oblId: string,
  iter: number,
  pv: number,
  digest: string,
  verdict: 'accept' | 'changes_requested' | 'unable_to_review',
): ReviewFindings {
  return {
    iteration: iter,
    planVersion: pv,
    reviewMode: 'subagent' as const,
    overallVerdict: verdict,
    blockingIssues:
      verdict === 'changes_requested'
        ? [
            {
              severity: 'major' as const,
              category: 'correctness' as const,
              message: 'updateTask must preserve the updatedAt field ordering',
              relation: {
                subjectAnchors: [{ kind: 'implementation' as const, implementationDigest: digest }],
                evidenceLocations: [],
              },
            },
          ]
        : [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_r' },
    reviewedAt: FIXED_TIME,
    attestation: {
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      toolObligationId: oblId,
      iteration: iter,
      planVersion: pv,
      reviewedBy: 'flowguard-reviewer',
    },
  };
}

/** Inject host-orchestrated evidence for the pending obligation (scope-preserving). */
async function inject(
  oblType: string,
  verdict: 'accept' | 'changes_requested' | 'unable_to_review',
  digest: string,
): Promise<{ state: SessionState; oblId: string }> {
  const se = s!;
  const state = await readState(se.sDir);
  const obl = state!.reviewAssurance!.obligations.find(
    (o) => o.obligationType === oblType && o.status === 'pending',
  );
  if (!obl) throw new Error(`No pending ${oblType} obligation`);
  const ff = implFindings(obl.obligationId, obl.iteration, obl.planVersion, digest, verdict);
  const fh = hashFindings(ff);
  const newObl = {
    ...obl,
    status: 'fulfilled' as const,
    fulfilledAt: FIXED_TIME,
    pluginHandshakeAt: FIXED_TIME,
  };
  const inv = {
    invocationId: randomUUID(),
    obligationId: obl.obligationId,
    obligationType: obl.obligationType,
    parentSessionId: se.sId,
    childSessionId: 'ses_r',
    agentType: 'flowguard-reviewer' as const,
    invocationMode: 'host_subagent_task' as const,
    hostVisible: true,
    source: 'host-orchestrated' as const,
    promptHash: 'abc',
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    findingsHash: fh,
    invokedAt: FIXED_TIME,
    fulfilledAt: FIXED_TIME,
    consumedByObligationId: null,
    capturedVerdict: verdict,
    capturedRawFindings: ff,
    attemptId: state!.reviewAssurance!.attempts.find((a) => a.obligationId === obl.obligationId)
      ?.attemptId,
    reviewOutputMode: 'structured_output' as const,
    structuredOutputUsed: true,
    reviewAssuranceLevel: 'structured_high' as const,
  };
  const aug: SessionState = {
    ...state!,
    reviewAssurance: {
      assuranceSchemaVersion: state!.reviewAssurance!.assuranceSchemaVersion,
      obligations: state!.reviewAssurance!.obligations.map((o) =>
        o.obligationId === obl.obligationId ? newObl : o,
      ),
      invocations: [...state!.reviewAssurance!.invocations, inv],
      attempts: state!.reviewAssurance!.attempts.map((attempt) =>
        attempt.obligationId === obl.obligationId
          ? {
              ...attempt,
              status: 'bound' as const,
              childSessionId: 'ses_r',
              completedAt: FIXED_TIME,
            }
          : attempt,
      ),
      dispatches: state!.reviewAssurance!.dispatches,
    },
    reviewDecision: {
      verdict: 'approve',
      rationale: 'E2E',
      decidedAt: FIXED_TIME,
      decidedBy: 'reviewer-1',
    },
  };
  await writeStateWithArtifacts(se.sDir, aug);
  return { state: aug, oblId: obl.obligationId };
}

function expectNoRepositoryAuthority(obligation: {
  reviewSubjectScope?: unknown;
  repositoryRevisionProvenance?: unknown;
}): void {
  expect(obligation).toMatchObject({
    reviewSubjectScope: { kind: 'implementation' },
    repositoryRevisionProvenance: { kind: 'unavailable' },
  });
}

async function prepareBoundUnableReview(se: SE, implementationDigest: string) {
  const base = makeState('IMPL_REVIEW', {
    binding: { ...makeState('IMPL_REVIEW').binding, worktree: se.worktree },
    ticket: TICKET,
    plan: {
      current: {
        body: '## Plan\n1. Verify implementation',
        digest: 'plan-digest',
        sections: [],
        createdAt: FIXED_TIME,
        recordDigest: 'a'.repeat(64),
        planVersion: 1,
        supersedesRecordDigest: null,
        originatingReviewObligationId: null,
        revisionReason: null,
        lineageStatus: 'verified',
      },
      history: [],
      reviewFindings: [],
    },
    implementation: {
      changedFiles: ['src/auth.ts'],
      domainFiles: ['src/auth.ts'],
      digest: implementationDigest,
      executedAt: FIXED_TIME,
    },
    policySnapshot: {
      ...makeState('IMPL_REVIEW').policySnapshot,
      reviewInvocationPolicy: 'host_task_required',
      selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
    },
  });
  await writeStateWithArtifacts(se.sDir, base);
  const firstState = await readState(se.sDir);
  const activated = await (
    await import('./tools/implement-shared.js')
  ).activateImplementationReviewObligation(firstState!, {
    subagentEnabled: true,
    iteration: 1,
    planVersion: 1,
    now: FIXED_TIME,
    worktree: se.worktree,
  });
  await writeStateWithArtifacts(se.sDir, activated.state);
  await inject('implement', 'unable_to_review', implementationDigest);
  return activated.obligation!;
}

describe('implementation review without repository observation authority', () => {
  it('unable_to_review consumes bound evidence and mints a fresh unbound attempt', async () => {
    s = await boot();
    const se = s;
    const implementationDigest = 'impl-unable-digest';
    const first = await prepareBoundUnableReview(se, implementationDigest);

    const boundState = await readState(se.sDir);
    expect(resolveNextAction('IMPL_REVIEW', boundState!).code).toBe(
      ACTION_CODES.SUBMIT_REVIEWER_VERDICT,
    );

    const result = await review_implementation.execute(
      { reviewVerdict: 'unable_to_review' },
      se.tc,
    );
    expect(String(result)).toContain('SUBAGENT_UNABLE_TO_REVIEW');

    const finalState = await readState(se.sDir);
    const obligations = finalState!.reviewAssurance!.obligations.filter(
      (item) => item.obligationType === 'implement',
    );
    expect(obligations).toHaveLength(2);
    expect(obligations[0]).toMatchObject({ obligationId: first.obligationId, status: 'consumed' });
    expect(obligations[1]).toMatchObject({
      status: 'pending',
      subjectDigest: implementationDigest,
    });
    expect(obligations[1]!.obligationId).not.toBe(first.obligationId);
    expect(finalState!.reviewAssurance!.invocations.at(-1)!.consumedByObligationId).toBe(
      first.obligationId,
    );
    expect(finalState!.implReviewFindings?.at(-1)?.overallVerdict).toBe('unable_to_review');
    const freshAttempt = finalState!.reviewAssurance!.attempts.find(
      (attempt) => attempt.obligationId === obligations[1]!.obligationId,
    );
    expect(freshAttempt?.status).toBe('created');
    expect(freshAttempt?.childSessionId).toBeUndefined();
  });

  it('keeps bound unable_to_review evidence unconsumed when successor minting is blocked', async () => {
    s = await boot();
    const se = s;
    const first = await prepareBoundUnableReview(se, 'impl-unable-retry-failure');
    vi.mocked(resolveAttemptDiscoveryOrBlock).mockResolvedValueOnce({
      kind: 'blocked',
      reason: 'persisted Discovery basis is unavailable for this repository review',
    });

    const result = await review_implementation.execute(
      { reviewVerdict: 'unable_to_review' },
      se.tc,
    );
    expect(String(result)).toContain('REVIEWER_CONTEXT_UNAVAILABLE');

    const finalState = await readState(se.sDir);
    const obligations = finalState!.reviewAssurance!.obligations.filter(
      (item) => item.obligationType === 'implement',
    );
    expect(obligations).toHaveLength(1);
    expect(obligations[0]).toMatchObject({ obligationId: first.obligationId, status: 'fulfilled' });
    expect(finalState!.reviewAssurance!.invocations.at(-1)!.consumedByObligationId).toBeNull();
    expect(resolveNextAction('IMPL_REVIEW', finalState!).code).toBe(
      ACTION_CODES.SUBMIT_REVIEWER_VERDICT,
    );
  });

  it('changes_requested binds via implementation anchor, re-record mints a fresh obligation, second review accepts', async () => {
    s = await boot();

    // Phase 1: ticket → plan Mode A → approved plan evidence.
    await ticket.execute({ text: 'Fix update path', source: 'user' }, s.tc);
    const r1 = await plan.execute(
      { planText: '## Plan\n1. Fix update', targetPaths: ['src/auth.ts'] },
      s.tc,
    );
    expect(r1).not.toContain('INTERNAL_ERROR');
    const planInjected = await inject('plan', 'accept', 'plan-digest');
    const r2 = await plan.execute(
      {
        reviewVerdict: 'accept',
        reviewFindings: implFindings(planInjected.oblId, 0, 1, 'plan-digest', 'accept'),
      },
      s.tc,
    );
    expect(r2).not.toContain('INTERNAL_ERROR');

    // Phase 2: implementation evidence WITHOUT any frozen base authority.
    const se2 = s!;
    const st = await readState(se2.sDir);
    mkdirSync(join(s.worktree, 'src'), { recursive: true });
    writeFileSync(join(s.worktree, 'src', 'auth.ts'), 'export const auth = () => true;\n');
    execSync('git add src', { cwd: s.worktree, stdio: 'pipe' });
    const implHashes = await hashWorktreeFiles(se2.worktree, ['src/auth.ts']);
    const implDigest1 = hashText(`src/auth.ts:${implHashes['src/auth.ts'] ?? 'deleted'}`);
    await writeStateWithArtifacts(
      se2.sDir,
      makeState('IMPL_VALIDATION', {
        binding: { ...makeState('IMPL_VALIDATION').binding, worktree: se2.worktree },
        implementationBaseAuthority: undefined,
        ticket: TICKET,
        plan: st!.plan,
        reviewDecision: st!.reviewDecision,
        implementation: {
          changedFiles: ['src/auth.ts'],
          domainFiles: ['src/auth.ts'],
          digest: implDigest1,
          executedAt: FIXED_TIME,
        },
        activeChecks: ['typecheck'],
        verificationCandidates: [
          {
            assertionCapability: 'unsupported' as const,
            kind: 'typecheck',
            command: 'npx tsc --noEmit',
            source: 'test',
            confidence: 'high',
            reason: 'E2E test candidate',
          },
        ],
        executionSubjectInputsByKind: { typecheck: [{ kind: 'implementation' as const }] },
      }),
    );

    // run_check: IMPL_VALIDATION → IMPL_REVIEW; the mint must succeed WITHOUT
    // repository authority (implementation subject is digest-bound).
    const rc1 = await run_check.execute({ kind: 'typecheck' }, se2.tc);
    expect(String(rc1)).not.toContain('"error":true');
    let state = await readState(se2.sDir);
    expect(state!.phase).toBe('IMPL_REVIEW');
    const implObligations1 = state!.reviewAssurance!.obligations.filter(
      (o) => o.obligationType === 'implement',
    );
    expect(implObligations1).toHaveLength(1);
    const first = implObligations1[0]!;
    expectNoRepositoryAuthority(first);
    expect(first.subjectDigest).toBe(implDigest1);
    expect(first.reviewSubjectScope).toEqual({
      kind: 'implementation',
      implementationDigest: implDigest1,
    });
    const firstAttempt = state!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === first.obligationId,
    );
    expect(firstAttempt?.repositoryDiscovery.kind).toBe('not_applicable');
    expect(firstAttempt?.observationCapability ?? null).toBeNull();

    // Phase 3: genuine changes_requested with an implementation subject anchor
    // and empty evidenceLocations — the bind must pass (orthogonality proof).
    const { oblId } = await inject('implement', 'changes_requested', implDigest1);
    const r3 = await review_implementation.execute(
      {
        reviewVerdict: 'changes_requested',
        reviewFindings: implFindings(oblId, 1, 1, implDigest1, 'changes_requested'),
      },
      s.tc,
    );
    expect(r3).not.toContain('INTERNAL_ERROR');
    state = await readState(se2.sDir);
    expect(state!.phase).toBe('IMPLEMENTATION');
    expect(state!.implementation).toBeNull();

    // Phase 4: change the rejected implementation before re-recording, then mint
    // a fresh obligation (iteration 2) for the second review.
    writeFileSync(join(s.worktree, 'src', 'auth.ts'), 'export const auth = () => false;\n');
    execSync('git add src/auth.ts', { cwd: s.worktree, stdio: 'pipe' });
    const r4 = await implement.execute({}, se2.tc);
    expect(r4).not.toContain('INTERNAL_ERROR');
    await run_check.execute({ kind: 'typecheck' }, s.tc);
    state = await readState(se2.sDir);
    expect(state!.phase).toBe('IMPL_REVIEW');
    const implObligations2 = state!.reviewAssurance!.obligations.filter(
      (o) => o.obligationType === 'implement',
    );
    expect(implObligations2).toHaveLength(2);
    const second = implObligations2.at(-1)!;
    expect(second.obligationId).not.toBe(first.obligationId);
    expect(second.iteration).toBe(2);
    // P1a re-froze the base when CHANGES_REQUESTED re-entered IMPLEMENTATION,
    // so the fresh obligation is repository-governed again — the subject
    // identity remains digest-bound either way.
    expect(second.reviewSubjectScope).toEqual({
      kind: 'implementation',
      implementationDigest: state!.implementation!.digest,
    });

    const secondScope = second.reviewSubjectScope;
    if (secondScope.kind !== 'implementation') throw new Error('expected implementation scope');
    const { oblId: oblId2 } = await inject('implement', 'accept', secondScope.implementationDigest);
    const r5 = await review_implementation.execute(
      {
        reviewVerdict: 'accept',
        reviewFindings: implFindings(
          oblId2,
          second.iteration,
          second.planVersion,
          secondScope.implementationDigest,
          'accept',
        ),
      },
      s.tc,
    );
    expect(r5).not.toContain('INTERNAL_ERROR');
    state = await readState(se2.sDir);
    expect(state!.phase).toBe('EVIDENCE_REVIEW');
  });

  it('a failing FRESH check after re-record keeps the repair loop autonomous (D3) and converges on the second repair', async () => {
    s = await boot();

    // Phase 1: ticket → plan Mode A → approved plan evidence.
    await ticket.execute({ text: 'Fix update path', source: 'user' }, s.tc);
    const r1 = await plan.execute(
      { planText: '## Plan\n1. Fix update', targetPaths: ['src/auth.ts'] },
      s.tc,
    );
    expect(r1).not.toContain('INTERNAL_ERROR');
    const planInjected = await inject('plan', 'accept', 'plan-digest');
    const r2 = await plan.execute(
      {
        reviewVerdict: 'accept',
        reviewFindings: implFindings(planInjected.oblId, 0, 1, 'plan-digest', 'accept'),
      },
      s.tc,
    );
    expect(r2).not.toContain('INTERNAL_ERROR');

    // Phase 2: implementation evidence.
    const se2 = s!;
    const st = await readState(se2.sDir);
    mkdirSync(join(s.worktree, 'src'), { recursive: true });
    writeFileSync(join(s.worktree, 'src', 'auth.ts'), 'export const auth = () => true;\n');
    execSync('git add src', { cwd: s.worktree, stdio: 'pipe' });
    const implHashes = await hashWorktreeFiles(se2.worktree, ['src/auth.ts']);
    const implDigest1 = hashText(`src/auth.ts:${implHashes['src/auth.ts'] ?? 'deleted'}`);
    await writeStateWithArtifacts(
      se2.sDir,
      makeState('IMPL_VALIDATION', {
        binding: { ...makeState('IMPL_VALIDATION').binding, worktree: se2.worktree },
        implementationBaseAuthority: undefined,
        ticket: TICKET,
        plan: st!.plan,
        reviewDecision: st!.reviewDecision,
        implementation: {
          changedFiles: ['src/auth.ts'],
          domainFiles: ['src/auth.ts'],
          digest: implDigest1,
          executedAt: FIXED_TIME,
        },
        activeChecks: ['typecheck'],
        verificationCandidates: [
          {
            assertionCapability: 'unsupported' as const,
            kind: 'typecheck',
            command: 'npx tsc --noEmit',
            source: 'test',
            confidence: 'high',
            reason: 'E2E test candidate',
          },
        ],
        executionSubjectInputsByKind: { typecheck: [{ kind: 'implementation' as const }] },
      }),
    );
    const rc1 = await run_check.execute({ kind: 'typecheck' }, se2.tc);
    expect(String(rc1)).not.toContain('"error":true');
    let state = await readState(se2.sDir);
    expect(state!.phase).toBe('IMPL_REVIEW');

    // Phase 3: reviewer changes_requested → IMPLEMENTATION + rework(D1).
    const { oblId } = await inject('implement', 'changes_requested', implDigest1);
    const r3 = await review_implementation.execute(
      {
        reviewVerdict: 'changes_requested',
        reviewFindings: implFindings(oblId, 1, 1, implDigest1, 'changes_requested'),
      },
      s.tc,
    );
    expect(r3).not.toContain('INTERNAL_ERROR');
    state = await readState(se2.sDir);
    expect(state!.phase).toBe('IMPLEMENTATION');
    expect(state!.implementationRework).toMatchObject({ exhausted: false });

    // Phase 4: repair D2, re-record (marker RETAINED), then a FRESH check FAILS:
    // the machine routes IMPL_VALIDATION → IMPLEMENTATION with the rejected-D1
    // marker still present — restoring D1 must now be blocked again.
    writeFileSync(join(s.worktree, 'src', 'auth.ts'), 'export const auth = () => false;\n');
    execSync('git add src/auth.ts', { cwd: s.worktree, stdio: 'pipe' });
    const r4 = await implement.execute({}, se2.tc);
    expect(r4).not.toContain('INTERNAL_ERROR');
    state = await readState(se2.sDir);
    expect(state!.phase).toBe('IMPL_VALIDATION');
    expect(state!.implementationRework).toMatchObject({ rejectedDigest: implDigest1 });
    vi.mocked(executeCheck).mockResolvedValueOnce({
      kind: 'typecheck',
      command: 'npx tsc --noEmit',
      exitCode: 1,
      passed: false,
      executionMs: 100,
      outputDigest: 'c'.repeat(64),
      stdout: 'src/auth.ts: error TS2322',
      stderr: '',
      timedOut: false,
      startedAt: new Date().toISOString(),
    });
    await run_check.execute({ kind: 'typecheck' }, se2.tc);
    state = await readState(se2.sDir);
    expect(state!.phase).toBe('IMPLEMENTATION');
    expect(state!.implementation).toBeNull();
    expect(state!.implementationRework).toMatchObject({ rejectedDigest: implDigest1 });
    expect(state!.implValidation.some((v) => !v.passed)).toBe(true);

    // Phase 4b (mandatory regression): restoring the EXACT rejected D1 after the
    // failing fresh D2 revalidation is blocked — no validation, no obligation,
    // no fresh reviewer can ever re-review D1.
    const implObligationsBeforeBlock = state!.reviewAssurance!.obligations.filter(
      (o) => o.obligationType === 'implement',
    ).length;
    writeFileSync(join(s.worktree, 'src', 'auth.ts'), 'export const auth = () => true;\n');
    execSync('git add src/auth.ts', { cwd: s.worktree, stdio: 'pipe' });
    const blockedRaw = await implement.execute({}, se2.tc);
    expect(blockedRaw).toContain('IMPLEMENTATION_REWORK_REQUIRED');
    state = await readState(se2.sDir);
    expect(state!.phase).toBe('IMPLEMENTATION');
    expect(state!.implementation).toBeNull();
    expect(state!.implValidation.some((v) => !v.passed)).toBe(true);
    expect(
      state!.reviewAssurance!.obligations.filter((o) => o.obligationType === 'implement'),
    ).toHaveLength(implObligationsBeforeBlock);

    // Phase 5: repair D3 (no new command needed — gate regression covers the
    // /check scope), re-record, green revalidation (marker closes at IMPL_REVIEW),
    // fresh reviewer accepts.
    writeFileSync(join(s.worktree, 'src', 'auth.ts'), 'export const auth = () => 42;\n');
    execSync('git add src/auth.ts', { cwd: s.worktree, stdio: 'pipe' });
    const r5 = await implement.execute({}, se2.tc);
    expect(r5).not.toContain('INTERNAL_ERROR');
    await run_check.execute({ kind: 'typecheck' }, s.tc);
    state = await readState(se2.sDir);
    expect(state!.phase).toBe('IMPL_REVIEW');
    expect(state!.implementationRework).toBeNull();
    const implObligations = state!.reviewAssurance!.obligations.filter(
      (o) => o.obligationType === 'implement',
    );
    const obligation = implObligations.at(-1)!;
    const scope = obligation.reviewSubjectScope;
    if (scope.kind !== 'implementation') throw new Error('expected implementation scope');
    const { oblId: oblIdAccept } = await inject('implement', 'accept', scope.implementationDigest);
    const r6 = await review_implementation.execute(
      {
        reviewVerdict: 'accept',
        reviewFindings: implFindings(
          oblIdAccept,
          obligation.iteration,
          obligation.planVersion,
          scope.implementationDigest,
          'accept',
        ),
      },
      s.tc,
    );
    expect(r6).not.toContain('INTERNAL_ERROR');
    state = await readState(se2.sDir);
    expect(state!.phase).toBe('EVIDENCE_REVIEW');
  });

  it('a digest rejected in an EARLIER round stays blocked after a later round closes the marker and rejects a different digest (multi-round reuse)', async () => {
    s = await boot();

    // Phase 1: ticket → plan Mode A → approved plan evidence.
    await ticket.execute({ text: 'Fix update path', source: 'user' }, s.tc);
    const r1 = await plan.execute(
      { planText: '## Plan\n1. Fix update', targetPaths: ['src/auth.ts'] },
      s.tc,
    );
    expect(r1).not.toContain('INTERNAL_ERROR');
    const planInjected = await inject('plan', 'accept', 'plan-digest');
    const r2 = await plan.execute(
      {
        reviewVerdict: 'accept',
        reviewFindings: implFindings(planInjected.oblId, 0, 1, 'plan-digest', 'accept'),
      },
      s.tc,
    );
    expect(r2).not.toContain('INTERNAL_ERROR');

    // Phase 2: implementation evidence for D1 (no repository authority).
    const se2 = s!;
    const st = await readState(se2.sDir);
    mkdirSync(join(s.worktree, 'src'), { recursive: true });
    writeFileSync(join(s.worktree, 'src', 'auth.ts'), 'export const auth = () => true;\n');
    execSync('git add src', { cwd: s.worktree, stdio: 'pipe' });
    const implHashes = await hashWorktreeFiles(se2.worktree, ['src/auth.ts']);
    const implDigest1 = hashText(`src/auth.ts:${implHashes['src/auth.ts'] ?? 'deleted'}`);
    await writeStateWithArtifacts(
      se2.sDir,
      makeState('IMPL_VALIDATION', {
        binding: { ...makeState('IMPL_VALIDATION').binding, worktree: se2.worktree },
        implementationBaseAuthority: undefined,
        ticket: TICKET,
        plan: st!.plan,
        reviewDecision: st!.reviewDecision,
        implementation: {
          changedFiles: ['src/auth.ts'],
          domainFiles: ['src/auth.ts'],
          digest: implDigest1,
          executedAt: FIXED_TIME,
        },
        activeChecks: ['typecheck'],
        verificationCandidates: [
          {
            assertionCapability: 'unsupported' as const,
            kind: 'typecheck',
            command: 'npx tsc --noEmit',
            source: 'test',
            confidence: 'high',
            reason: 'E2E test candidate',
          },
        ],
        executionSubjectInputsByKind: { typecheck: [{ kind: 'implementation' as const }] },
      }),
    );
    const rc1 = await run_check.execute({ kind: 'typecheck' }, se2.tc);
    expect(String(rc1)).not.toContain('"error":true');
    let state = await readState(se2.sDir);
    expect(state!.phase).toBe('IMPL_REVIEW');

    // Phase 3: Reviewer A changes_requested(D1) → IMPLEMENTATION + rework(D1).
    const { oblId } = await inject('implement', 'changes_requested', implDigest1);
    const r3 = await review_implementation.execute(
      {
        reviewVerdict: 'changes_requested',
        reviewFindings: implFindings(oblId, 1, 1, implDigest1, 'changes_requested'),
      },
      s.tc,
    );
    expect(r3).not.toContain('INTERNAL_ERROR');
    state = await readState(se2.sDir);
    expect(state!.phase).toBe('IMPLEMENTATION');
    expect(state!.implementationRework).toMatchObject({ rejectedDigest: implDigest1 });

    // Phase 4: repair D2, re-record, GREEN revalidation → IMPL_REVIEW. The marker
    // is CLOSED on the ALL_PASSED edge — only the historical projection can still
    // remember that D1 was rejected.
    writeFileSync(join(s.worktree, 'src', 'auth.ts'), 'export const auth = () => false;\n');
    execSync('git add src/auth.ts', { cwd: s.worktree, stdio: 'pipe' });
    const r4 = await implement.execute({}, se2.tc);
    expect(r4).not.toContain('INTERNAL_ERROR');
    await run_check.execute({ kind: 'typecheck' }, s.tc);
    state = await readState(se2.sDir);
    expect(state!.phase).toBe('IMPL_REVIEW');
    expect(state!.implementationRework).toBeNull();
    const implObligations2 = state!.reviewAssurance!.obligations.filter(
      (o) => o.obligationType === 'implement',
    );
    expect(implObligations2).toHaveLength(2);
    const second = implObligations2.at(-1)!;
    expect(second.iteration).toBe(2);
    const secondScope = second.reviewSubjectScope;
    if (secondScope.kind !== 'implementation') throw new Error('expected implementation scope');
    const implDigest2 = secondScope.implementationDigest;
    expect(implDigest2).not.toBe(implDigest1);

    // Phase 5: Reviewer B changes_requested(D2) → IMPLEMENTATION; the single-slot
    // marker moves on to D2.
    const { oblId: oblId2 } = await inject('implement', 'changes_requested', implDigest2);
    const r5 = await review_implementation.execute(
      {
        reviewVerdict: 'changes_requested',
        reviewFindings: implFindings(
          oblId2,
          second.iteration,
          second.planVersion,
          implDigest2,
          'changes_requested',
        ),
      },
      s.tc,
    );
    expect(r5).not.toContain('INTERNAL_ERROR');
    state = await readState(se2.sDir);
    expect(state!.phase).toBe('IMPLEMENTATION');
    expect(state!.implementation).toBeNull();
    expect(state!.implementationRework).toMatchObject({
      rejectedDigest: implDigest2,
      exhausted: false,
    });

    // Phase 6 (mandatory regression): restoring the EXACT rejected D1 after the
    // marker has moved to D2 is still blocked — no validation, no obligation, no
    // fresh reviewer can ever re-review D1.
    const obligationsBeforeBlock = state!.reviewAssurance!.obligations.filter(
      (o) => o.obligationType === 'implement',
    ).length;
    const validationsBeforeBlock = state!.implValidation.length;
    writeFileSync(join(s.worktree, 'src', 'auth.ts'), 'export const auth = () => true;\n');
    execSync('git add src/auth.ts', { cwd: s.worktree, stdio: 'pipe' });
    const blockedRaw = await implement.execute({}, se2.tc);
    expect(blockedRaw).toContain('IMPLEMENTATION_REWORK_REQUIRED');
    state = await readState(se2.sDir);
    expect(state!.phase).toBe('IMPLEMENTATION');
    expect(state!.implementation).toBeNull();
    expect(state!.implValidation).toHaveLength(validationsBeforeBlock);
    expect(
      state!.reviewAssurance!.obligations.filter((o) => o.obligationType === 'implement'),
    ).toHaveLength(obligationsBeforeBlock);

    // Phase 7: a repair D3 (≠ D1, ≠ D2) is still recordable — the guard blocks
    // only digests that were EVER rejected.
    writeFileSync(join(s.worktree, 'src', 'auth.ts'), 'export const auth = () => 42;\n');
    execSync('git add src/auth.ts', { cwd: s.worktree, stdio: 'pipe' });
    const r6 = await implement.execute({}, se2.tc);
    expect(r6).not.toContain('INTERNAL_ERROR');
    await run_check.execute({ kind: 'typecheck' }, s.tc);
    state = await readState(se2.sDir);
    expect(state!.phase).toBe('IMPL_REVIEW');
    const implObligations3 = state!.reviewAssurance!.obligations.filter(
      (o) => o.obligationType === 'implement',
    );
    const third = implObligations3.at(-1)!;
    expect(implObligations3).toHaveLength(obligationsBeforeBlock + 1);
    expect(third.iteration).toBe(3);
    const thirdScope = third.reviewSubjectScope;
    if (thirdScope.kind !== 'implementation') throw new Error('expected implementation scope');
    expect(thirdScope.implementationDigest).not.toBe(implDigest1);
    expect(thirdScope.implementationDigest).not.toBe(implDigest2);
    const { oblId: oblIdAccept } = await inject(
      'implement',
      'accept',
      thirdScope.implementationDigest,
    );
    const r7 = await review_implementation.execute(
      {
        reviewVerdict: 'accept',
        reviewFindings: implFindings(
          oblIdAccept,
          third.iteration,
          third.planVersion,
          thirdScope.implementationDigest,
          'accept',
        ),
      },
      s.tc,
    );
    expect(r7).not.toContain('INTERNAL_ERROR');
    state = await readState(se2.sDir);
    expect(state!.phase).toBe('EVIDENCE_REVIEW');
  });
});
