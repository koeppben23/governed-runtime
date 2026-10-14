/**
 * Two-session recovery through real git, hydration, mutation hooks, recording,
 * execution, materialization and approval persistence. Only reviewer observations
 * use the deterministic host-evidence test helper; this is NOT a live host proof.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readState, statePath } from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { computeFingerprint, sessionDir } from '../adapters/workspace/index.js';
import { deriveVerificationCandidateId } from '../state/candidate-identity.js';
import type { SessionState } from '../state/schema.js';
import type { PlanClaimDeclarationInput } from '../state/proofgraph-approval.js';
import { authorizedCriticalPlanClaimIds } from '../state/proofgraph-approval-context.js';
import { hashText } from '../shared/hashing.js';
import { evaluateProofGraphGateFromState } from '../audit/proofgraph/gate.js';
import { applyEvidenceApprovalTransition } from '../rails/types.js';
import { computeImplementationDigest } from '../verification/implementation-subject.js';
import { assessMinimumTaskClass } from './phase-tool-gate.js';
import { FlowGuardAuditPlugin } from './plugin.js';
import {
  abort_session,
  hydrate,
  ticket,
  plan,
  implement,
  review_implementation,
  run_check,
  status,
  help,
} from './tools/index.js';
import { writeStateWithArtifacts, withMutableSessionTransaction } from './tools/helpers.js';
import { buildImplementRuntime } from './tools/implementation/implement-shared.js';
import { handleImplRecord } from './tools/implementation/implement-record.js';
import type { ToolContext, ToolDefinition } from './tools/helpers.js';
import {
  createBootableHostClient,
  createToolContext,
  fulfillStrictReviewObligation,
  parseToolResult,
  withTestEnv,
} from './test-helpers.js';

const SUBJECT = 'src/state/value.cjs';
const ORIGINAL = 'exports.reject = value => value === null;\n';
const REPAIRED = 'exports.reject = value => value == null;\n';
const REPORT_SCRIPT = `const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
assert.equal(require('../src/state/value.cjs').reject(null), true);
const target = process.argv[2];
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, '<testsuite tests="1" failures="0"><testcase classname="com.example.SessionTest" name="rejectInvalidState"/></testsuite>');
`;

const definitions = [
  {
    kind: 'build' as const,
    command: 'node --check src/state/value.cjs',
    source: 'repo:package.json:scripts.build',
    confidence: 'high' as const,
    reason: 'syntax check',
    assertionCapability: 'unsupported' as const,
  },
  {
    kind: 'test' as const,
    command: 'node scripts/check.cjs',
    source: 'repo:package.json:scripts.test',
    confidence: 'high' as const,
    reason: 'executed null-rejection assertion',
    assertionCapability: 'structured' as const,
    assertionReport: {
      collection: 'run_specific' as const,
      transport: 'file' as const,
      format: 'junit_xml' as const,
      providerId: 'junit' as const,
      outputArgumentTemplate: '.flowguard/reports/{attemptId}/junit.xml',
      resultPatternTemplate: '.flowguard/reports/{attemptId}/junit.xml',
    },
  },
];
const candidates = definitions.map((definition) => ({
  ...definition,
  candidateId: deriveVerificationCandidateId(definition),
}));
const CLAIM: PlanClaimDeclarationInput = {
  statement: 'Null session state is rejected.',
  critical: true,
  claimScope: 'specific_behavior',
  authoritySectionId: 'implementation-step-1',
  expectedCheckId: 'build',
  counterexampleRequirement: {
    kind: 'assertion',
    checkId: 'test',
    assertion: { providerId: 'junit', localId: 'com.example.SessionTest#rejectInvalidState' },
  },
};
const PLAN =
  '# Implementation Plan\n\n## Implementation\n### 1. Preserve null rejection\nKeep null state rejected in src/state/value.cjs.\n';
const CHALLENGE_SCENARIOS = [
  'Try a null session state at the persistence boundary.',
  'Try restoring a prior session certificate under the new host binding.',
  'Try approving after scope drift adds an uncovered risk trigger.',
];

type Session = { context: ToolContext; dir: string; worktree: string };
let root: string;
let restoreEnv: () => void;

function git(worktree: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: worktree,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function stateOf(session: Session): Promise<SessionState> {
  const state = await readState(session.dir);
  if (!state) throw new Error('test session missing');
  return state;
}

async function call(tool: ToolDefinition, session: Session, args: Record<string, unknown> = {}) {
  return parseToolResult(await tool.execute(args, session.context));
}

async function ok(tool: ToolDefinition, session: Session, args: Record<string, unknown> = {}) {
  const result = await call(tool, session, args);
  expect(result, JSON.stringify(result)).not.toHaveProperty('error', true);
  return result;
}

async function boot(worktree: string): Promise<Session> {
  const context = createToolContext({
    sessionID: `ses_${randomUUID()}`,
    worktree,
    directory: worktree,
  });
  const fp = await computeFingerprint(worktree);
  const session = { context, worktree, dir: sessionDir(fp.fingerprint, context.sessionID) };
  await ok(hydrate, session, { policyMode: 'solo', profileId: 'baseline' });
  // Supply deterministic verification discovery, never execution or approval evidence.
  const state = await stateOf(session);
  await writeStateWithArtifacts(session.dir, {
    ...state,
    activeChecks: ['build', 'test'],
    verificationCandidates: candidates,
    executionSubjectInputsByCandidateId: Object.fromEntries(
      candidates.map((candidate) => [candidate.candidateId, [{ kind: 'implementation' }]]),
    ),
  });
  return session;
}

async function approvePlan(session: Session, covered: boolean) {
  const triggers = assessMinimumTaskClass([SUBJECT]).riskTriggers.filter(
    (t) => t !== 'ceremony_only',
  );
  await ok(ticket, session, { text: 'Preserve null rejection in session state.\nRisk: HIGH-RISK' });
  await ok(plan, session, {
    planText: PLAN,
    targetPaths: [SUBJECT],
    claims: [{ ...CLAIM, ...(covered ? { coversRiskTriggers: triggers } : {}) }],
  });
  await fulfillStrictReviewObligation(session.dir, {
    obligationType: 'plan',
    iteration: 0,
    planVersion: 1,
    challengeScenarios: CHALLENGE_SCENARIOS,
  });
  await ok(plan, session, { reviewVerdict: 'accept' });
  const state = await stateOf(session);
  expect(state.phase).toBe('IMPLEMENTATION');
  expect(authorizedCriticalPlanClaimIds(state).kind).toBe('authorized');
  return state;
}

async function hooksFor(session: Session) {
  return FlowGuardAuditPlugin({
    client: createBootableHostClient(),
    directory: session.worktree,
    worktree: session.worktree,
    serverUrl: new URL('http://localhost:3000'),
  } as unknown as Parameters<typeof FlowGuardAuditPlugin>[0]);
}

async function governedReapply(session: Session) {
  const hooks = await hooksFor(session);
  const before = hooks['tool.execute.before'];
  const after = hooks['tool.execute.after'];
  if (!before || !after) throw new Error('mutation hooks missing');
  const filePath = join(session.worktree, SUBJECT);
  const args = { filePath, content: REPAIRED };
  const input = { tool: 'write', sessionID: session.context.sessionID, callID: randomUUID() };
  await before(input, { args });
  const dispatched = await stateOf(session);
  expect(dispatched.mutationEpisodes.at(-1)?.status).toBe('dispatch_authorized');
  await writeFile(filePath, REPAIRED);
  await after(
    { ...input, args },
    {
      title: 'write',
      output: 'Wrote file successfully.',
      metadata: { filepath: filePath, exists: true, diagnostics: {} },
    },
  );
  expect((await stateOf(session)).mutationEpisodes.at(-1)?.status).toBe('completed');
}

async function verifyAndReview(session: Session) {
  await ok(implement, session);
  const recorded = await stateOf(session);
  expect(recorded.phase).toBe('IMPL_REVIEW');
  expect(recorded.implementation?.changedFiles).toEqual([SUBJECT]);
  const ready = await stateOf(session);
  expect(ready.phase).toBe('IMPL_REVIEW');
  const obligation = [...(ready.reviewAssurance?.obligations ?? [])]
    .reverse()
    .find((o) => o.obligationType === 'implement');
  if (!obligation) throw new Error('implementation review missing');
  await fulfillStrictReviewObligation(session.dir, {
    obligationType: 'implement',
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
    challengeScenarios: CHALLENGE_SCENARIOS,
  });
  return call(review_implementation, session, { reviewVerdict: 'accept' });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'flowguard-replan-recovery-'));
  restoreEnv = withTestEnv({
    OPENCODE_CONFIG_DIR: join(root, 'config'),
    FLOWGUARD_REQUIRE_TEST_CONFIG_DIR: '1',
    FLOWGUARD_HOST_PLATFORM: 'opencode',
    FLOWGUARD_POLICY_PATH: undefined,
  });
});
afterEach(async () => {
  restoreEnv();
  await rm(root, { recursive: true, force: true });
});

async function repository() {
  const worktree = join(root, 'original');
  await mkdir(join(worktree, dirname(SUBJECT)), { recursive: true });
  await mkdir(join(worktree, 'scripts'), { recursive: true });
  await writeFile(join(worktree, SUBJECT), ORIGINAL);
  await writeFile(join(worktree, 'scripts/check.cjs'), REPORT_SCRIPT);
  await writeFile(join(worktree, '.gitignore'), '.flowguard/\n');
  await writeFile(
    join(worktree, 'package.json'),
    JSON.stringify({
      name: 'recovery-fixture',
      scripts: { build: definitions[0]?.command, test: definitions[1]?.command },
    }),
  );
  git(worktree, 'init');
  // Keep fixture bytes byte-exact across platforms: the test compares the
  // reapplied file to the literal LF content.
  git(worktree, 'config', 'core.autocrlf', 'false');
  git(worktree, 'config', 'user.name', 'Test');
  git(worktree, 'config', 'user.email', 'test@example.test');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-m', 'trusted baseline');
  git(worktree, 'remote', 'add', 'origin', 'https://example.test/recovery.git');
  return realpath(worktree);
}

describe('governed new-session authority recovery', () => {
  it('rejects a same-check declaration before plan/version/review creation with a reachable correction', async () => {
    const session = await boot(await repository());
    await ok(ticket, session, { text: 'Preserve null state rejection.\nRisk: HIGH-RISK' });
    const previous = await stateOf(session);
    const rejected = await call(plan, session, {
      planText: PLAN,
      claims: [{ ...CLAIM, expectedCheckId: 'test' }],
      targetPaths: [SUBJECT],
    });
    expect(rejected.error).toBe(true);
    expect(JSON.stringify(rejected)).toContain(
      'different check identities AND different validation attempts',
    );
    expect(JSON.stringify(rejected)).toContain('TICKET or PLAN');
    expect(await stateOf(session)).toEqual(previous);
    expect(previous.phase).toBe('TICKET');
    expect(previous.plan).toBeNull();
  });

  it('preserves an aborted old session and obtains a new certificate and fresh evidence for identical bytes', async () => {
    const original = await repository();
    const base = git(original, 'rev-parse', 'HEAD');
    const a = await boot(original);
    await approvePlan(a, false);
    await governedReapply(a);
    const denial = await verifyAndReview(a);
    expect(denial.code).toBe('PROOFGRAPH_RISK_TRIGGER_UNCOVERED');
    const blocked = await stateOf(a);
    expect(blocked.phase).toBe('EVIDENCE_REVIEW');
    expect(blocked.proofGraph.claims[0]?.verificationState).toBe('PROVEN');
    const oldAttempts = blocked.validationAttempts.map((attempt) => attempt.attemptId);
    const oldCertificate = blocked.plan?.approvalCertificate;
    expect(oldCertificate).toBeDefined();

    // A legal implementation repair is not a path to changing the plan authority.
    const refusedPlan = await call(plan, a, { planText: PLAN, claims: [CLAIM] });
    expect(refusedPlan.code).toBe('COMMAND_NOT_ALLOWED');
    expect(await stateOf(a)).toEqual(blocked);
    const statusResult = await ok(status, a);
    expect(JSON.stringify(statusResult)).toContain('PROOFGRAPH_RISK_TRIGGER_UNCOVERED');
    const helpResult = await ok(help, a, { view: 'commands', scope: 'all', verbose: true });
    expect(JSON.stringify(helpResult)).not.toContain(
      '"invocation":"/plan","description":"Create or revise the implementation plan.","visibility":"recommended"',
    );

    const abortHooks = await hooksFor(a);
    const abortInput = {
      tool: 'flowguard_abort_session',
      sessionID: a.context.sessionID,
      callID: randomUUID(),
    };
    const abortArgs = {
      reason: 'Explicit user recovery: replace missing approved state coverage.',
    };
    await abortHooks['tool.execute.before']!(abortInput, { args: abortArgs });
    const abortResult = await abort_session.execute(abortArgs, a.context);
    expect(parseToolResult(abortResult)).not.toHaveProperty('error', true);
    await abortHooks['tool.execute.after']!(
      { ...abortInput, args: abortArgs },
      {
        title: 'abort',
        output: typeof abortResult === 'string' ? abortResult : abortResult.output,
        metadata: {},
      },
    );
    const aborted = await stateOf(a);
    expect(aborted.phase).toBe('ABORTED');
    expect(aborted.plan).toEqual(blocked.plan);
    expect(aborted.validationAttempts).toEqual(blocked.validationAttempts);
    expect(aborted.proofContract).toEqual(blocked.proofContract);
    // Abort's normal commit re-evaluates the derived projection, not its authority/evidence.
    expect(aborted.proofGraph).toEqual({
      ...blocked.proofGraph,
      evaluatedAt: expect.any(String),
      claims: blocked.proofGraph.claims.map((claim) => ({
        ...claim,
        freshness: { ...claim.freshness, evaluatedAt: expect.any(String) },
      })),
    });
    const audit = await readAuditTrail(a.dir);
    expect(JSON.stringify(audit)).toContain('ABORT');
    const bytes = await readFile(statePath(a.dir), 'utf8');
    await ok(hydrate, a);
    expect(await readFile(statePath(a.dir), 'utf8')).toBe(bytes);
    expect(await readAuditTrail(a.dir)).toEqual(audit);

    const freshRoot = join(root, 'fresh');
    git(original, 'worktree', 'add', '--detach', freshRoot, base);
    const b = await boot(await realpath(freshRoot));
    const initial = await stateOf(b);
    expect(b.context.sessionID).not.toBe(a.context.sessionID);
    expect(initial.flowguardSessionId).not.toBe(aborted.flowguardSessionId);
    expect(initial.phase).toBe('READY');
    expect(initial.implementationBaseline.dirtyFiles).toEqual([]);
    expect(git(b.worktree, 'rev-parse', 'HEAD')).toBe(base);
    expect(await readFile(join(b.worktree, SUBJECT), 'utf8')).toBe(ORIGINAL);
    expect(initial.validationAttempts).toEqual([]);
    expect(initial.proofGraph.claims).toEqual([]);

    const approved = await approvePlan(b, true);
    expect(approved.plan?.current.planVersion).toBe(1);
    expect(approved.plan?.approvalCertificate?.certificateId).not.toBe(
      oldCertificate?.certificateId,
    );
    expect(approved.plan?.claimDeclarations?.claims[0]?.claimId).toBe(
      blocked.plan?.claimDeclarations?.claims[0]?.claimId,
    );
    expect(
      authorizedCriticalPlanClaimIds({
        ...approved,
        plan: { ...approved.plan!, approvalCertificate: oldCertificate },
      }).kind,
    ).toBe('certificate_invalid');

    // Code identity does not transport the prior authority, projection, or attempts.
    await governedReapply(b);
    // Observe the canonical recording boundary before the facade starts automatic checks.
    const recordResponse = await withMutableSessionTransaction(b.context, async (mutable) =>
      handleImplRecord(buildImplementRuntime({ ...mutable, args: {}, context: b.context })),
    );
    expect(parseToolResult(recordResponse)).not.toHaveProperty('error', true);
    const recorded = await stateOf(b);
    expect(recorded.implementation?.digest).toBe(blocked.implementation?.digest);
    expect(recorded.implementation?.implementationId).not.toBe(
      blocked.implementation?.implementationId,
    );
    expect(recorded.validationAttempts.some((attempt) => attempt.scope === 'implementation')).toBe(
      false,
    );
    expect(recorded.proofGraph.claims.some((claim) => claim.verificationState === 'PROVEN')).toBe(
      false,
    );
    expect(evaluateProofGraphGateFromState(recorded).gated).toBe(true);
    expect(recorded.mutationEpisodes.at(-1)).toMatchObject({
      evidenceStatus: 'eligible',
      implementationDigest: recorded.implementation?.digest,
    });
    expect(
      evaluateProofGraphGateFromState({
        ...recorded,
        phase: 'EVIDENCE_REVIEW',
        proofGraph: blocked.proofGraph,
        proofContract: blocked.proofContract,
      }).gated,
    ).toBe(true);

    await ok(run_check, b, { kind: 'build' });
    await ok(run_check, b, { kind: 'test' });
    const verified = await stateOf(b);
    const obligation = [...(verified.reviewAssurance?.obligations ?? [])]
      .reverse()
      .find((o) => o.obligationType === 'implement');
    if (!obligation) throw new Error('review missing');
    await fulfillStrictReviewObligation(b.dir, {
      obligationType: 'implement',
      iteration: obligation.iteration,
      planVersion: obligation.planVersion,
      challengeScenarios: CHALLENGE_SCENARIOS,
    });
    await ok(review_implementation, b, { reviewVerdict: 'accept' });
    const final = await stateOf(b);
    expect(final.phase).toBe('EXPORT_READY');
    expect(final.proofGraph.claims[0]?.verificationState).toBe('PROVEN');
    expect(
      final.validationAttempts.every((attempt) => !oldAttempts.includes(attempt.attemptId)),
    ).toBe(true);
    expect(await stateOf(a)).toEqual(aborted);
    expect(await readAuditTrail(a.dir)).toEqual(audit);

    const drifted: SessionState = {
      ...final,
      phase: 'EVIDENCE_REVIEW',
      implementationRiskAssessment: {
        ...final.implementationRiskAssessment!,
        riskTriggers: ['state_integrity', 'identity_boundary'],
      },
    };
    expect(evaluateProofGraphGateFromState(drifted).kind).toBe('risk_trigger_uncovered');

    // Even a proven projection cannot widen the current approved declaration set.
    const widened: SessionState = {
      ...final,
      phase: 'EVIDENCE_REVIEW',
      plan: {
        ...final.plan!,
        claimDeclarations: {
          ...final.plan!.claimDeclarations!,
          claims: final.plan!.claimDeclarations!.claims.map((claim) => ({
            ...claim,
            coversRiskTriggers: [...(claim.coversRiskTriggers ?? []), 'identity_boundary'],
          })),
        },
      },
    };
    expect(evaluateProofGraphGateFromState(widened).gated).toBe(true);
    const application = applyEvidenceApprovalTransition(widened, new Date().toISOString());
    expect(application.kind).toBe('blocked');
    expect(await stateOf(b)).toEqual(final);
  });

  it('rejects the naive dirty-worktree restart without manufacturing implementation evidence', async () => {
    const worktree = await repository();
    await writeFile(join(worktree, SUBJECT), REPAIRED);
    const b = await boot(worktree);
    expect(
      (await stateOf(b)).implementationBaseline.dirtyFiles?.map((file) => file.path),
    ).toContain(SUBJECT);
    await approvePlan(b, true);
    const previous = await stateOf(b);
    const digest = await computeImplementationDigest({
      worktree,
      files: [SUBJECT],
      digest: hashText,
    });
    expect(digest).toBeTruthy();
    const result = await call(implement, b);
    expect(result.code).toBe('IMPLEMENTATION_EVIDENCE_EMPTY');
    expect(await stateOf(b)).toEqual(previous);
  });

  it('refuses reapplication before the new plan is approved without a mutation dispatch or partial write', async () => {
    const b = await boot(await repository());
    const hooks = await hooksFor(b);
    const before = hooks['tool.execute.before'];
    if (!before) throw new Error('before hook missing');
    const previous = await stateOf(b);
    await expect(
      before(
        { tool: 'write', sessionID: b.context.sessionID, callID: randomUUID() },
        {
          args: { filePath: join(b.worktree, SUBJECT), content: REPAIRED },
        },
      ),
    ).rejects.toThrow();
    expect((await stateOf(b)).mutationEpisodes).toEqual(previous.mutationEpisodes);
    expect(await readFile(join(b.worktree, SUBJECT), 'utf8')).toBe(ORIGINAL);
  });
});
