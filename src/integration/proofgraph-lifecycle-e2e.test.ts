/**
 * @module integration/proofgraph-lifecycle-e2e.test
 * @description End-to-end ProofGraph claim lifecycle through real code paths (#762).
 *
 * The prior demo failure was not a missing model — it was an unreachable one:
 * the tool schema accepted claims, but no product path produced them and no
 * reviewer prompt carried them. Text- and template-level tests could not detect
 * that. These tests therefore exercise the actual runtime chain:
 *
 *   /plan tool payload
 *     -> persisted declarations
 *     -> reviewer prompt content
 *     -> approval certificate digests (real rail)
 *     -> materialized fact claims (real materializer)
 *     -> evaluated verification state (real evaluator)
 *     -> gate decision (real gate)
 *
 * and the standalone review hypothesis count across its full lifecycle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { readState } from '../adapters/persistence.js';
import { sessionDir } from '../adapters/workspace/index.js';
import { computeFingerprint } from '../adapters/workspace/fingerprint.js';
import { writeStateWithArtifacts, type ToolContext } from './tools/helpers.js';
import { plan } from './tools/plan.js';
import { review } from './tools/review-tool/index.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review/assurance.js';
import type { ReviewFindings } from '../state/evidence.js';
import { executeReviewDecision } from '../rails/review-decision.js';
import { createTestContext } from '../testing.js';
import { hashText } from '../shared/hashing.js';
import { computeRecordDigest } from '../state/evidence-plan.js';
import { materializeApprovedPlanContractResult } from './proofgraph/materialize-contract.js';
import { summarizeProofGraph, summarizePersistedProofGraph } from '../audit/proofgraph/summary.js';
import { evaluateProofGraphGate } from '../audit/proofgraph/gate.js';
import { buildProofApprovalProjection } from './proofgraph/approval-projection.js';
import { buildReviewerProofContext } from './review/proof-context.js';
import { isRiskAssessmentCurrent } from '../audit/proofgraph/gate.js';
import { makeState, TICKET, IMPL_EVIDENCE, FIXED_TIME } from '../fixtures.js';
import type { SessionState } from '../state/schema.js';
import type {
  PlanClaimDeclaration,
  PlanClaimDeclarationInput,
} from '../state/proofgraph-approval.js';

type V2PlanClaimDeclaration = Extract<
  PlanClaimDeclaration,
  { claimScope: 'suite' | 'specific_behavior' }
>;

vi.mock('../verification/executor', () => ({
  executeCheck: vi.fn().mockResolvedValue({
    kind: 'build',
    command: './mvnw verify',
    exitCode: 0,
    passed: true,
    executionMs: 100,
    outputDigest: 'a'.repeat(64),
    stdout: 'OK',
    stderr: '',
    timedOut: false,
    startedAt: FIXED_TIME,
  }),
}));

const CRITICAL_CLAIM_ID = '784c0696-adae-5789-9fe5-1e86e365ec1e';
const ATTEMPT_ID = '20000000-0000-4000-8000-000000000002';

const COUNTEREXAMPLE_ATTEMPT_ID = '30000000-0000-4000-8000-000000000003';

/** Checks the declared claims reference; they must be active to be declarable. */
const ACTIVE_CHECKS = ['build', 'security'];

const STRUCTURED_CANDIDATES = [
  {
    assertionCapability: 'unsupported' as const,
    kind: 'build' as const,
    command: './mvnw verify',
    source: 'repo:mvnw',
    confidence: 'high' as const,
    reason: 'Maven build',
  },
  {
    assertionCapability: 'structured' as const,
    kind: 'security' as const,
    command: './mvnw test',
    source: 'repo:mvnw',
    confidence: 'high' as const,
    reason: 'JUnit via Maven wrapper (test)',
    assertionReport: {
      collection: 'snapshot_diff' as const,
      transport: 'file' as const,
      format: 'junit_xml' as const,
      providerId: 'junit' as const,
      standardPatterns: ['target/surefire-reports/TEST-*.xml'],
    },
  },
];

const CRITICAL_CLAIM = {
  claimId: CRITICAL_CLAIM_ID,
  statement: 'updateTask returns 404 for an unknown id instead of 500.',
  critical: true,
  claimScope: 'specific_behavior' as const,
  authoritySectionId: 'implementation-step-1',
  expectedCheckId: 'build',
  // A critical claim is only PROVEN with executed adversarial evidence.
  counterexampleRequirement: {
    checkId: 'security',
    kind: 'assertion' as const,
    assertion: { providerId: 'junit', localId: 'com.example.CounterTest#counterexample' },
  },
};

/** Public input shape — claimId is host-minted. */
const CRITICAL_CLAIM_INPUT: PlanClaimDeclarationInput = {
  statement: 'updateTask returns 404 for an unknown id instead of 500.',
  critical: true,
  claimScope: 'specific_behavior',
  authoritySectionId: 'implementation-step-1',
  expectedCheckId: 'build',
  counterexampleRequirement: {
    checkId: 'security',
    kind: 'assertion',
    assertion: { providerId: 'junit', localId: 'com.example.CounterTest#counterexample' },
  },
};

const AGGREGATE_CLAIM: V2PlanClaimDeclaration = {
  claimId: '884c0696-adae-5789-9fe5-1e86e365ec1e',
  statement: 'the complete pytest suite remains green after the implementation.',
  critical: true,
  claimScope: 'suite',
  authoritySectionId: 'implementation-step-1',
  expectedCheckId: 'build',
  counterexampleRequirement: { kind: 'aggregate_check', checkId: 'security' },
};

const AGGREGATE_CANDIDATES = [
  STRUCTURED_CANDIDATES[0]!,
  {
    assertionCapability: 'structured' as const,
    kind: 'security' as const,
    command: 'pytest --junitxml=reports.xml',
    source: 'provider:pytest',
    confidence: 'high' as const,
    reason: 'pytest JUnit XML complete suite report',
    fullCheckScopeAttestation: 'full_check' as const,
    assertionReport: {
      collection: 'snapshot_diff' as const,
      transport: 'file' as const,
      format: 'junit_xml' as const,
      providerId: 'pytest' as const,
      standardPatterns: ['reports.xml'],
    },
  },
];

const PLAN_TEXT = [
  '# Implementation Plan',
  '',
  '## Approach',
  '- Reuse the existing null-check pattern.',
  '',
  '## Implementation',
  '### 1. Guard updateTask',
  '- **Files:** src/service.ts',
  '- **Changes:** null-check before mutation.',
  '- **Edge cases:** unknown id.',
  '- **Validation:** build passes.',
  '',
  '## Verification',
  '1. `./mvnw verify` — Source: repo:mvnw',
].join('\n');

/**
 * Rail context using the REAL digest function. Certificate validation in the
 * materializer hashes with `hashText`; a stub digest would make every authentic
 * certificate look invalid and hide real binding failures.
 */
function realDigestContext() {
  return createTestContext(FIXED_TIME, hashText);
}

interface Env {
  rootDir: string;
  worktree: string;
  sDir: string;
  tc: ToolContext;
}

async function boot(label: string): Promise<Env> {
  const rootDir = mkdtempSync(path.join(tmpdir(), `fg-pg-${label}-`));
  const worktree = path.join(rootDir, 'worktree');
  const configDir = path.join(rootDir, 'config');
  const id = randomUUID();
  mkdirSync(worktree, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  execSync('git init && git config user.email t@t && git config user.name T', {
    cwd: worktree,
    stdio: 'pipe',
  });
  writeFileSync(path.join(worktree, 'README.md'), '# ProofGraph E2E');
  execSync('git add README.md && git commit -m init', { cwd: worktree, stdio: 'pipe' });
  process.env.OPENCODE_CONFIG_DIR = configDir;
  process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';
  process.env.FLOWGUARD_HOST_PLATFORM = 'opencode';
  const fp = await computeFingerprint(worktree);
  const sDir = sessionDir(fp.fingerprint, id);
  mkdirSync(sDir, { recursive: true });
  return {
    rootDir,
    worktree,
    sDir,
    tc: {
      sessionID: id,
      messageID: randomUUID(),
      agent: 'test',
      directory: worktree,
      worktree,
      abort: new AbortController().signal,
      metadata: () => {},
    },
  };
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Implementation-scoped attempt bound to the current revision. */
function attempt(
  attemptId: string,
  checkId: string,
  passed: boolean,
  kind: 'build' | 'test' = 'build',
): SessionState['validationAttempts'][number] {
  return {
    attemptId,
    scope: 'implementation',
    implementationDigest: IMPL_EVIDENCE.digest,
    result: {
      checkId,
      passed,
      detail: `${checkId} ${passed ? 'ok' : 'failed'}`,
      executedAt: FIXED_TIME,
      kind,
      command: `./mvnw ${checkId}`,
      exitCode: passed ? 0 : 1,
      executionMs: 100,
      outputDigest: 'a'.repeat(64),
      timedOut: false,
      outcome: 'supported' as const,
    },
  };
}

/** Positive check plus the executed falsification attempt the claim declares. */
function fullEvidence(): SessionState['validationAttempts'] {
  const cx = attempt(COUNTEREXAMPLE_ATTEMPT_ID, 'security', true, 'test');
  return [
    {
      ...attempt(ATTEMPT_ID, 'build', true),
      result: {
        ...attempt(ATTEMPT_ID, 'build', true).result,
        fullCheckScopeAttestation: 'full_check',
      },
    },
    {
      ...cx,
      result: {
        ...cx.result,
        assertionExtraction: {
          status: 'extracted' as const,
          attemptId: COUNTEREXAMPLE_ATTEMPT_ID,
          providerId: 'junit' as const,
          format: 'junit_xml' as const,
          bindingCapability: 'assertion' as const,
          reportDigests: ['a'.repeat(64)],
          assertions: [
            {
              assertion: { providerId: 'junit', localId: 'com.example.CounterTest#counterexample' },
              providerId: 'junit',
              status: 'passed' as const,
              testName: 'counterexample',
              suiteName: 'counterexample',
            },
          ],
          summary: {
            assertionCount: 1,
            passedCount: 1,
            failedCount: 0,
            erroredCount: 0,
            skippedCount: 0,
            suiteInfrastructureError: false,
          },
        },
      },
    },
  ];
}

function aggregateEvidence(): SessionState['validationAttempts'] {
  const cx = attempt(COUNTEREXAMPLE_ATTEMPT_ID, 'security', true, 'test');
  return [
    {
      ...attempt(ATTEMPT_ID, 'build', true),
      // Suite claims require complete-suite positive evidence, not merely a passing check.
      result: {
        ...attempt(ATTEMPT_ID, 'build', true).result,
        fullCheckScopeAttestation: 'full_check' as const,
      },
    },
    {
      ...cx,
      result: {
        ...cx.result,
        fullCheckScopeAttestation: 'full_check' as const,
        assertionExtraction: {
          status: 'extracted' as const,
          attemptId: COUNTEREXAMPLE_ATTEMPT_ID,
          providerId: 'pytest' as const,
          format: 'junit_xml' as const,
          bindingCapability: 'aggregate' as const,
          reportDigests: ['b'.repeat(64)],
          assertions: [
            {
              assertion: { providerId: 'pytest', localId: 'tests/test_api.py::test_update' },
              providerId: 'pytest',
              status: 'passed' as const,
              testName: 'test_update',
            },
          ],
          summary: {
            assertionCount: 1,
            passedCount: 1,
            failedCount: 0,
            erroredCount: 0,
            skippedCount: 0,
            suiteInfrastructureError: false,
          },
        },
      },
    },
  ];
}

describe('ProofGraph claim lifecycle (runtime)', () => {
  let env: Env | undefined;
  let prevConfig: string | undefined;
  let prevRequire: string | undefined;
  let prevPlatform: string | undefined;

  beforeEach(() => {
    prevConfig = process.env.OPENCODE_CONFIG_DIR;
    prevRequire = process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
    prevPlatform = process.env.FLOWGUARD_HOST_PLATFORM;
  });

  afterEach(() => {
    restoreEnv('OPENCODE_CONFIG_DIR', prevConfig);
    restoreEnv('FLOWGUARD_REQUIRE_TEST_CONFIG_DIR', prevRequire);
    restoreEnv('FLOWGUARD_HOST_PLATFORM', prevPlatform);
    if (env) {
      rmSync(env.rootDir, { recursive: true, force: true });
      env = undefined;
    }
  });

  it('persists claims submitted through the real /plan tool payload', async () => {
    env = await boot('plan-claims');
    await writeStateWithArtifacts(
      env.sDir,
      makeState('TICKET', {
        ticket: TICKET,
        activeChecks: ACTIVE_CHECKS,
        verificationCandidates: STRUCTURED_CANDIDATES,
      }),
    );

    const raw = await plan.execute({ planText: PLAN_TEXT, claims: [CRITICAL_CLAIM_INPUT] }, env.tc);
    expect(String(raw)).not.toContain('INTERNAL_ERROR');

    const state = await readState(env.sDir);
    expect(state!.plan?.claimDeclarations).toEqual({
      flow: 'plan',
      version: 'v2',
      claims: [CRITICAL_CLAIM],
    });
  });

  it('carries the declarations into the reviewer prompt before any evidence exists', async () => {
    env = await boot('plan-prompt');
    await writeStateWithArtifacts(
      env.sDir,
      makeState('TICKET', {
        ticket: TICKET,
        activeChecks: ACTIVE_CHECKS,
        verificationCandidates: STRUCTURED_CANDIDATES,
      }),
    );
    await plan.execute({ planText: PLAN_TEXT, claims: [CRITICAL_CLAIM_INPUT] }, env.tc);

    const state = await readState(env.sDir);
    const context = buildReviewerProofContext(state!).join('\n');

    expect(context).toContain('Declared Claims (pre-evidence, advisory)');
    expect(context).toContain(CRITICAL_CLAIM_ID);
    expect(context).toContain('expected check: build');
    // Not yet approved: the reviewer must see that nothing is certificate-bound.
    expect(context).toContain('Plan approval certificate: none recorded');
  });

  it('rejects a critical claim without a counterexample check at submission', async () => {
    env = await boot('plan-reject');
    await writeStateWithArtifacts(
      env.sDir,
      makeState('TICKET', {
        ticket: TICKET,
        activeChecks: ACTIVE_CHECKS,
        verificationCandidates: STRUCTURED_CANDIDATES,
      }),
    );

    const raw = await plan.execute(
      {
        planText: PLAN_TEXT,
        claims: [{ ...CRITICAL_CLAIM_INPUT, counterexampleRequirement: undefined }],
      },
      env.tc,
    );
    const parsed = JSON.parse(String(raw));

    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE');
    // Nothing may be persisted: an unprovable claim must never reach a certificate.
    const state = await readState(env.sDir);
    expect(state!.plan).toBeFalsy();
    expect(state!.phase).toBe('TICKET');
  });

  it('rejects a critical claim that reuses its positive check at submission', async () => {
    env = await boot('plan-same-check');
    await writeStateWithArtifacts(
      env.sDir,
      makeState('TICKET', {
        ticket: TICKET,
        activeChecks: ACTIVE_CHECKS,
        verificationCandidates: STRUCTURED_CANDIDATES,
      }),
    );

    const raw = await plan.execute(
      {
        planText: PLAN_TEXT,
        claims: [
          {
            ...CRITICAL_CLAIM_INPUT,
            counterexampleRequirement: {
              checkId: 'build',
              kind: 'assertion',
              assertion: { providerId: 'junit', localId: 'com.example.CounterTest#counterexample' },
            },
          },
        ],
      },
      env.tc,
    );
    const parsed = JSON.parse(String(raw));

    expect(parsed.code).toBe('PROOFGRAPH_CLAIM_UNSATISFIABLE');
    expect(String(parsed.message)).toContain('counterexampleRequirement');
    expect(String(parsed.message)).toContain('assertionCapability');
    const state = await readState(env.sDir);
    expect(state!.plan).toBeFalsy();
    expect(state!.phase).toBe('TICKET');
  });

  it('rejects a claim referencing a check that is not active', async () => {
    env = await boot('plan-inactive-check');
    await writeStateWithArtifacts(
      env.sDir,
      makeState('TICKET', {
        ticket: TICKET,
        activeChecks: ['build'],
        verificationCandidates: STRUCTURED_CANDIDATES,
      }),
    );

    const raw = await plan.execute({ planText: PLAN_TEXT, claims: [CRITICAL_CLAIM_INPUT] }, env.tc);
    const parsed = JSON.parse(String(raw));

    expect(parsed.code).toBe('PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE');
    expect(String(parsed.message)).toContain('security');
  });

  it('warns early when target paths look HIGH-RISK without a critical claim', async () => {
    env = await boot('plan-warn');
    await writeStateWithArtifacts(
      env.sDir,
      makeState('TICKET', {
        ticket: TICKET,
        activeChecks: ACTIVE_CHECKS,
        verificationCandidates: STRUCTURED_CANDIDATES,
      }),
    );

    const raw = await plan.execute(
      { planText: PLAN_TEXT, targetPaths: ['src/state/schema.ts'] },
      env.tc,
    );
    const parsed = JSON.parse(String(raw));

    expect(parsed.error).toBeUndefined();
    expect(parsed.proofGraphRiskWarning).toMatchObject({
      computedMinimumTaskClass: 'HIGH-RISK',
      assessedFrom: 'plan_target_paths',
    });
    // Advisory only: the plan still advances.
    const state = await readState(env.sDir);
    expect(state!.plan).toBeTruthy();
  });

  it('binds the human approval into a certificate carrying every required digest', async () => {
    env = await boot('plan-cert');
    await writeStateWithArtifacts(
      env.sDir,
      makeState('TICKET', {
        ticket: TICKET,
        activeChecks: ACTIVE_CHECKS,
        verificationCandidates: STRUCTURED_CANDIDATES,
      }),
    );
    await plan.execute({ planText: PLAN_TEXT, claims: [CRITICAL_CLAIM_INPUT] }, env.tc);
    const submitted = await readState(env.sDir);

    const approved = executeReviewDecision(
      { ...submitted!, phase: 'PLAN_REVIEW' },
      { verdict: 'approve', rationale: 'ok', decidedBy: 'approver' },
      realDigestContext(),
    );

    expect(approved.kind).toBe('ok');
    if (approved.kind !== 'ok') return;
    const certificate = approved.state.plan?.approvalCertificate;
    expect(certificate).toMatchObject({
      flow: 'plan',
      authorityDigest: submitted!.plan!.current.digest,
    });
    expect(certificate?.certificateId).toMatch(/^[0-9a-f-]{36}$/);
    expect(certificate?.claimDeclarationsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(certificate?.decisionAttestationDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('standalone review hypotheses (runtime)', () => {
  let env: Env | undefined;
  let prevConfig: string | undefined;
  let prevRequire: string | undefined;
  let prevPlatform: string | undefined;

  beforeEach(() => {
    prevConfig = process.env.OPENCODE_CONFIG_DIR;
    prevRequire = process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
    prevPlatform = process.env.FLOWGUARD_HOST_PLATFORM;
  });

  afterEach(() => {
    restoreEnv('OPENCODE_CONFIG_DIR', prevConfig);
    restoreEnv('FLOWGUARD_REQUIRE_TEST_CONFIG_DIR', prevRequire);
    restoreEnv('FLOWGUARD_HOST_PLATFORM', prevPlatform);
    if (env) {
      rmSync(env.rootDir, { recursive: true, force: true });
      env = undefined;
    }
  });

  function findings(obligationId: string, iteration: number, planVersion: number): ReviewFindings {
    return {
      iteration,
      planVersion,
      reviewMode: 'subagent',
      overallVerdict: 'changes_requested',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: 'ses_r' },
      reviewedAt: FIXED_TIME,
      attestation: {
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        toolObligationId: obligationId,
        iteration,
        planVersion,
        reviewedBy: 'flowguard-reviewer',
      },
    };
  }

  it('produces exactly the profile objective count, never a duplicated set', async () => {
    env = await boot('standalone');
    await writeStateWithArtifacts(env.sDir, makeState('READY'));

    const first = await review.execute(
      { inputOrigin: 'manual_text', text: 'PR under review' },
      env.tc,
    );
    const obligationId = JSON.parse(String(first)).requiredReviewAttestation
      ?.toolObligationId as string;
    expect(obligationId).toBeTruthy();

    const prepared = await readState(env.sDir);
    const obligation = prepared!.reviewAssurance!.obligations.find(
      (o) => o.obligationId === obligationId,
    )!;

    await review.execute(
      {
        inputOrigin: 'manual_text',
        text: 'PR under review',
        reviewFindings: findings(obligationId, obligation.iteration, obligation.planVersion),
      },
      env.tc,
    );

    const completed = await readState(env.sDir);
    expect(completed!.phase).toBe('REVIEW_COMPLETE');

    // Preparation and completion must bind to ONE evidence chain. A second
    // prepared entry would duplicate every hypothesis claim in the projection.
    const prepared_entries = completed!.standaloneReviewEvidence.filter(
      (e) => e.kind === 'prepared',
    );
    expect(prepared_entries).toHaveLength(1);
    expect(completed!.proofGraph?.claims).toHaveLength(3);
    expect(
      completed!.proofGraph?.claims.every(
        (c) => c.signalClass === 'hypothesis' && c.provenance === null,
      ),
    ).toBe(true);
  });

  it('reports hypotheses separately from an undeclared contract', async () => {
    env = await boot('standalone-coverage');
    await writeStateWithArtifacts(env.sDir, makeState('READY'));
    await review.execute({ inputOrigin: 'manual_text', text: 'PR under review' }, env.tc);

    const state = await readState(env.sDir);
    const summary = summarizePersistedProofGraph(state!);

    expect(summary).toMatchObject({
      coverage: 'NOT_DECLARED',
      claimCount: 3,
      contractClaimCount: 0,
      hypothesisCount: 3,
    });
  });
});

describe('implementation risk assessment (runtime)', () => {
  it('persists the assessment bound to the exact implementation revision', async () => {
    const state = makeState('IMPLEMENTATION', {
      ticket: TICKET,
      activeChecks: ACTIVE_CHECKS,
      implementation: IMPL_EVIDENCE,
      implementationRiskAssessment: {
        computedMinimumTaskClass: 'HIGH-RISK',
        touchedSurfaces: ['src/state/schema.ts'],
        assessedFrom: 'implementation_changed_files',
        assessedFileCount: 1,
        implementationDigest: IMPL_EVIDENCE.digest,
        riskTriggers: ['state_integrity'],
      },
    });

    expect(
      isRiskAssessmentCurrent(state.implementationRiskAssessment, state.implementation?.digest),
    ).toBe(true);
  });

  it('treats an assessment from a superseded revision as not current', async () => {
    const state = makeState('IMPLEMENTATION', {
      implementation: { ...IMPL_EVIDENCE, digest: 'new-revision-digest' },
      implementationRiskAssessment: {
        computedMinimumTaskClass: 'HIGH-RISK',
        touchedSurfaces: ['src/state/schema.ts'],
        assessedFrom: 'implementation_changed_files',
        assessedFileCount: 1,
        implementationDigest: IMPL_EVIDENCE.digest,
        riskTriggers: ['state_integrity'],
      },
    });

    // A stale classification must never justify a gate decision on new code.
    expect(
      isRiskAssessmentCurrent(state.implementationRiskAssessment, state.implementation?.digest),
    ).toBe(false);
  });
});

describe('ProofGraph materialization and gate (runtime)', () => {
  /** Approve the plan through the real rail so the certificate is authentic. */
  function approvedPlanState(
    claim: V2PlanClaimDeclaration = CRITICAL_CLAIM,
    verificationCandidates: SessionState['verificationCandidates'] = STRUCTURED_CANDIDATES,
  ): SessionState {
    const base = makeState('PLAN_REVIEW', {
      ticket: TICKET,
      activeChecks: ACTIVE_CHECKS,
      verificationCandidates,
      plan: {
        current: {
          body: PLAN_TEXT,
          digest: 'plan-digest',
          sections: [],
          createdAt: FIXED_TIME,
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
        reviewFindings: undefined,
        claimDeclarations: { flow: 'plan', version: 'v2', claims: [claim] },
      },
    });
    const approved = executeReviewDecision(
      base,
      { verdict: 'approve', rationale: 'ok', decidedBy: 'approver' },
      realDigestContext(),
    );
    if (approved.kind !== 'ok') throw new Error('plan approval failed');
    return approved.state;
  }

  function implReviewState(
    attempts: SessionState['validationAttempts'],
    claim: V2PlanClaimDeclaration = CRITICAL_CLAIM,
    verificationCandidates: SessionState['verificationCandidates'] = STRUCTURED_CANDIDATES,
  ): SessionState {
    return {
      ...approvedPlanState(claim, verificationCandidates),
      phase: 'IMPL_REVIEW',
      implementation: IMPL_EVIDENCE,
      validationAttempts: attempts,
    };
  }

  it('materializes an approved declaration into a certificate-bound fact claim', async () => {
    const state = implReviewState(fullEvidence());
    const { contract, coverage } = await materializeApprovedPlanContractResult(state, '/tmp');

    expect(coverage).toEqual([]);
    expect(contract.claims).toHaveLength(1);
    expect(contract.claims[0]).toMatchObject({ claimId: CRITICAL_CLAIM_ID, signalClass: 'fact' });
    expect(contract.claims[0]?.provenance).toMatchObject({
      kind: 'canonical_authority',
      authorityId: 'plan',
      approval: { declarationId: CRITICAL_CLAIM_ID },
    });
    expect(contract.claims[0]?.evidenceRefs).toContainEqual({
      kind: 'validation_attempt',
      attemptId: ATTEMPT_ID,
    });
  });

  it('records a coverage gap when the declared expected check never ran', async () => {
    const state = implReviewState([]);
    const { contract, coverage } = await materializeApprovedPlanContractResult(state, '/tmp');

    expect(contract.claims).toHaveLength(1);
    expect(coverage).toContainEqual({
      claimId: CRITICAL_CLAIM_ID,
      cause: 'missing_expected_check',
    });
  });

  it('POSITIVE gate: a proven critical fact allows approval', async () => {
    const state = implReviewState(fullEvidence());
    const { contract } = await materializeApprovedPlanContractResult(state, '/tmp');
    const summary = summarizeProofGraph({ ...state, proofContract: contract }, FIXED_TIME);

    expect(summary.projection.claims[0]?.verificationState).toBe('PROVEN');

    const decision = evaluateProofGraphGate(summary);
    expect(decision.gated).toBe(false);
  });

  it('materializes and proves an aggregate_check from a complete pytest report', async () => {
    const state = implReviewState(aggregateEvidence(), AGGREGATE_CLAIM, AGGREGATE_CANDIDATES);
    const { contract, coverage } = await materializeApprovedPlanContractResult(state, '/tmp');
    const summary = summarizeProofGraph({ ...state, proofContract: contract }, FIXED_TIME);

    expect(coverage).toEqual([]);
    expect(contract.claims[0]?.counterexampleRefs).toEqual([
      { kind: 'validation_attempt', attemptId: COUNTEREXAMPLE_ATTEMPT_ID },
    ]);
    expect(summary.projection.claims[0]?.verificationState).toBe('PROVEN');
  });

  it.each(['pytest tests/test_api.py', 'pytest -k update'])(
    'does not prove an aggregate_check from a scope-filtered pytest report: %s',
    async (command) => {
      const filteredCandidates = [
        AGGREGATE_CANDIDATES[0]!,
        {
          ...AGGREGATE_CANDIDATES[1]!,
          command,
          fullCheckScopeAttestation: undefined,
        },
      ];
      const attempts = aggregateEvidence().map((attempt) =>
        attempt.attemptId === COUNTEREXAMPLE_ATTEMPT_ID
          ? {
              ...attempt,
              result: { ...attempt.result, fullCheckScopeAttestation: undefined },
            }
          : attempt,
      );
      const state = implReviewState(attempts, AGGREGATE_CLAIM, filteredCandidates);
      const { contract, coverage } = await materializeApprovedPlanContractResult(state, '/tmp');
      const summary = summarizeProofGraph({ ...state, proofContract: contract }, FIXED_TIME);

      // The report totals are internally consistent, but the command's scope is not complete.
      expect(coverage).toContainEqual({
        claimId: AGGREGATE_CLAIM.claimId,
        cause: 'aggregate_counterexample_unsupported',
      });
      expect(contract.claims[0]?.counterexampleRefs).toEqual([]);
      expect(summary.projection.claims[0]?.verificationState).not.toBe('PROVEN');
    },
  );

  it('NEGATIVE gate: an unproven critical fact blocks the human approval', async () => {
    const state = implReviewState([]);
    const { contract } = await materializeApprovedPlanContractResult(state, '/tmp');
    const summary = summarizeProofGraph({ ...state, proofContract: contract }, FIXED_TIME);

    expect(summary.projection.claims[0]?.verificationState).not.toBe('PROVEN');

    const blocked = executeReviewDecision(
      {
        ...state,
        phase: 'EVIDENCE_REVIEW',
        proofContract: contract,
        proofGraph: summary.projection,
      },
      { verdict: 'approve', rationale: 'ship it', decidedBy: 'approver' },
      // No policy configuration at all: enforcement is unconditional (#762).
      realDigestContext(),
    );

    expect(blocked.kind).toBe('blocked');
    if (blocked.kind !== 'blocked') return;
    expect(blocked.code).toBe('PROOFGRAPH_CRITICAL_FACTS_UNPROVEN');
    expect(blocked.reason).toContain(CRITICAL_CLAIM_ID);
  });

  it('projects the full declaration-to-evidence chain for audit', async () => {
    const state = implReviewState(fullEvidence());
    const { contract } = await materializeApprovedPlanContractResult(state, '/tmp');
    const summary = summarizeProofGraph({ ...state, proofContract: contract }, FIXED_TIME);
    const projection = buildProofApprovalProjection({
      ...state,
      proofContract: contract,
      proofGraph: summary.projection,
    });

    expect(projection.certificates[0]?.declaredClaimCount).toBe(1);
    expect(projection.implementationDigest).toBe(IMPL_EVIDENCE.digest);
    expect(projection.claims[0]).toMatchObject({
      claimId: CRITICAL_CLAIM_ID,
      verificationState: 'PROVEN',
      evidenceRefCount: 1,
    });
    expect(projection.claims[0]?.certificateId).toBe(
      projection.certificates[0]?.certificateId ?? null,
    );
  });

  it('binds the review evidence digest into the plan certificate', () => {
    const findingsHash = 'a'.repeat(64);
    const obligationId = '33333333-1111-4111-8111-111111111111';
    const invocationId = '44444444-2222-4222-8222-222222222222';
    const state = makeState('PLAN_REVIEW', {
      ticket: TICKET,
      activeChecks: ACTIVE_CHECKS,
      plan: {
        current: {
          body: PLAN_TEXT,
          digest: 'plan-digest',
          sections: [],
          createdAt: FIXED_TIME,
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
        reviewFindings: undefined,
        claimDeclarations: { flow: 'plan', version: 'v2', claims: [CRITICAL_CLAIM] },
      },
      reviewAssurance: {
        obligations: [
          {
            obligationId,
            obligationType: 'plan' as const,
            subjectDigest: 'plan-digest',
            iteration: 0,
            planVersion: 1,
            criteriaVersion: 'p40-v1',
            mandateDigest: 'e78b6bab98fcf033874fcc07e17d87aaff73fca47b1a28209e5dd4a1a28eedb7',
            createdAt: FIXED_TIME,
            pluginHandshakeAt: FIXED_TIME,
            status: 'fulfilled' as const,
            invocationId,
            blockedCode: null,
            fulfilledAt: FIXED_TIME,
            consumedAt: null,
            requiredChallengeCount: undefined,
          },
        ],
        invocations: [
          {
            invocationId,
            obligationId,
            obligationType: 'plan' as const,
            parentSessionId: 'ses_parent',
            childSessionId: 'ses_child',
            agentType: 'flowguard-reviewer' as const,
            invocationMode: 'host_subagent_task' as const,
            hostVisible: true,
            promptHash: 'abc',
            mandateDigest: 'e78b6bab98fcf033874fcc07e17d87aaff73fca47b1a28209e5dd4a1a28eedb7',
            criteriaVersion: 'p40-v1',
            findingsHash,
            invokedAt: FIXED_TIME,
            fulfilledAt: FIXED_TIME,
            consumedByObligationId: null,
            reviewOutputMode: 'structured_output' as const,
            structuredOutputUsed: true,
            reviewAssuranceLevel: 'structured_high' as const,
            attemptId: '55555555-3333-4333-8333-333333333333',
          },
        ],
        attempts: [
          {
            attemptId: '55555555-3333-4333-8333-333333333333',
            obligationId,
            obligationType: 'plan' as const,
            subjectDigest: 'plan-digest',
            childSessionId: 'ses_child',
            ordinal: 0,
            status: 'bound' as const,
            createdAt: FIXED_TIME,
          },
        ],
      },
    });
    const approved = executeReviewDecision(
      state,
      { verdict: 'approve', rationale: 'ok', decidedBy: 'approver' },
      realDigestContext(),
    );
    if (approved.kind !== 'ok') throw new Error('plan approval failed');
    const cert = approved.state.plan?.approvalCertificate;
    expect(cert).toBeDefined();
    expect(cert!.reviewObligationId).toBe(obligationId);
    expect(cert!.reviewEvidenceDigest).toBe(findingsHash);
    expect(cert!.reviewEvidenceDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
