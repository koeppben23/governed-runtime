import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  withStrictReviewFindings,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
  withTestEnv,
} from './test-helpers.js';
import {
  status,
  hydrate,
  ticket,
  plan,
  implement,
  decision,
  run_check,
  review,
  abort_session,
  archive,
  architecture,
  declare_contract,
} from './tools/index.js';
import {
  PersistenceError,
  readState,
  statePath,
  writeState,
  writeReport,
  reportPath,
} from '../adapters/persistence.js';
import { writeStateWithArtifacts } from './tools/helpers.js';
import { REVIEW_REPORT_SCHEMA_ID } from '../state/evidence-identifiers.js';
import { mintProofGraphClaimId } from '../state/proofgraph-approval.js';
import { makePlanRevision, TEST_EXECUTION_OBSERVATION } from '../state/evidence-test-constants.js';
import { completedDispatchForInvocation } from '../state/evidence-test-constants.js';
import {
  artifactReviewSubjectScope,
  buildInvocationEvidence,
  createReviewObligation,
  freezeReviewMaterial,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
} from './review/obligations/assurance.js';
import { hashFindings } from './review/findings-hash.js';
import { hostTaskDispatchPlan } from './tools/review-validation-test-helpers.js';
import type { ReviewFindings } from '../state/evidence.js';
// ─── Zod v4 Metadata Regression (P1 review gate) ──────────────────────────────
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

// ─── Workspace Mock (P26) ────────────────────────────────────────────────────

const wsOriginals = vi.hoisted(() => ({
  archiveSession:
    null as unknown as (typeof import('../adapters/workspace/index.js'))['archiveSession'],
  verifyArchive:
    null as unknown as (typeof import('../adapters/workspace/index.js'))['verifyArchive'],
}));

vi.mock('../adapters/workspace', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/workspace/index.js')>();
  wsOriginals.archiveSession = original.archiveSession;
  wsOriginals.verifyArchive = original.verifyArchive;
  return {
    ...original,
    archiveSession: vi.fn(original.archiveSession),
    verifyArchive: vi.fn(original.verifyArchive),
  };
});

// ─── Actor Mock (P27) ────────────────────────────────────────────────────────

const actorOriginal = vi.hoisted(() => ({
  resolveActor: null as unknown as (typeof import('../adapters/actor.js'))['resolveActor'],
}));

vi.mock('../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/actor.js')>();
  actorOriginal.resolveActor = original.resolveActor;
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      source: 'env',
      assurance: 'best_effort',
    }),
  };
});

const discoveryPersistenceOriginal = vi.hoisted(() => ({
  readDiscovery:
    null as unknown as (typeof import('../adapters/persistence-discovery.js'))['readDiscovery'],
}));

vi.mock('../adapters/persistence-discovery.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/persistence-discovery.js')>();
  discoveryPersistenceOriginal.readDiscovery = original.readDiscovery;
  return {
    ...original,
    readDiscovery: vi.fn(original.readDiscovery),
  };
});

const executorOriginal = vi.hoisted(() => ({
  executeCheck: null as unknown as (typeof import('../verification/executor.js'))['executeCheck'],
}));

vi.mock('../verification/executor.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../verification/executor.js')>();
  executorOriginal.executeCheck = original.executeCheck;
  return {
    ...original,
    executeCheck: vi.fn(original.executeCheck),
  };
});

const wsMock = await import('../adapters/workspace/index.js');
const actorMock = await import('../adapters/actor.js');
const discoveryPersistenceMock = await import('../adapters/persistence-discovery.js');
const executorMock = await import('../verification/executor.js');

// ─── Test Setup ──────────────────────────────────────────────────────────────

let ws: TestWorkspace;
let ctx: TestToolContext;
let cleanupEnv: () => void;

beforeEach(async () => {
  cleanupEnv = withTestEnv({ FLOWGUARD_POLICY_PATH: undefined });
  ws = await createTestWorkspace();
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
  });
});

afterEach(async () => {
  vi.mocked(wsMock.archiveSession).mockReset().mockImplementation(wsOriginals.archiveSession);
  vi.mocked(wsMock.verifyArchive).mockReset().mockImplementation(wsOriginals.verifyArchive);
  vi.mocked(actorMock.resolveActor)
    .mockReset()
    .mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'best_effort' as const,
    });
  vi.mocked(discoveryPersistenceMock.readDiscovery)
    .mockReset()
    .mockImplementation(discoveryPersistenceOriginal.readDiscovery);
  vi.mocked(executorMock.executeCheck)
    .mockReset()
    .mockImplementation(executorOriginal.executeCheck);
  cleanupEnv();
  vi.clearAllMocks();
  await ws.cleanup();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function hydrateSession(
  overrides: { policyMode?: string; profileId?: string } = {},
): Promise<Record<string, unknown>> {
  const args: { policyMode: string; profileId?: string } = {
    policyMode: overrides.policyMode ?? 'solo',
  };
  if (overrides.profileId !== undefined) {
    args.profileId = overrides.profileId;
  }
  const raw = await hydrate.execute(args, ctx);
  return parseToolResult(raw);
}

async function hydrateAndTicket(ticketText = 'Fix the auth bug'): Promise<void> {
  await hydrateSession();
  await ticket.execute({ text: ticketText, source: 'user' }, ctx);
}

// =============================================================================
// Tool: declare_contract (ProofGraph declaration, #762)
// =============================================================================

function makeStructuredSecurityCandidate() {
  return {
    assertionCapability: 'structured' as const,
    candidateId: 'vc_security_structured',
    kind: 'security' as const,
    command: 'npm run security',
    source: 'test',
    confidence: 'high' as const,
    reason: 'security',
    assertionReport: {
      collection: 'snapshot_diff' as const,
      transport: 'file' as const,
      format: 'junit_xml' as const,
      providerId: 'junit',
      standardPatterns: ['TEST-*.xml'],
    },
  };
}

function makeAssertionExtraction(assertionId: string, status: 'passed' | 'failed') {
  const localId = assertionId.includes(':') ? assertionId.split(':')[1]! : assertionId;
  return {
    status: 'extracted' as const,
    attemptId: '00000000-0000-4000-8000-0000000000dd',
    providerId: 'junit' as const,
    format: 'junit_xml' as const,
    bindingCapability: 'assertion' as const,
    reportDigests: ['a'.repeat(64)],
    assertions: [
      {
        assertion: { providerId: 'junit', localId },
        providerId: 'junit',
        status,
        testName: 'verify',
        suiteName: 'com.example.SecurityTest',
      },
    ],
    summary: {
      assertionCount: 1,
      passedCount: status === 'passed' ? 1 : 0,
      failedCount: status === 'failed' ? 1 : 0,
      erroredCount: 0,
      skippedCount: 0,
      suiteInfrastructureError: false,
    },
  };
}

describe('declare_contract', () => {
  const NOW = '2026-01-01T00:00:00.000Z';
  const SHA = 'a'.repeat(64);

  async function seedImplValidation(
    overrides: {
      checkId?: string;
      passed?: boolean;
      digest?: string;
      /** Active checks deliberately left without an implementation attempt. */
      unattemptedChecks?: string[];
    } = {},
  ): Promise<string> {
    const checkId = overrides.checkId ?? 'test';
    const digest = overrides.digest ?? 'impl-digest-1';
    await hydrateSession();
    const { computeFingerprint, sessionDir: resolveSessionDir } =
      await import('../adapters/workspace/index.js');
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
    const state = await readState(sessDir);
    await writeStateWithArtifacts(sessDir, {
      ...state!,
      phase: 'IMPL_VALIDATION',
      activeChecks: [checkId, 'security', ...(overrides.unattemptedChecks ?? [])],
      ticket: {
        text: 'approved ticket',
        digest: 'ticket-digest',
        source: 'user',
        createdAt: NOW,
        riskDeclaration: { kind: 'absent' },
      },
      implementation: {
        implementationId: '00000000-0000-4000-8000-0000000000aa',
        changedFiles: ['a.ts'],
        domainFiles: [],
        digest,
        executedAt: NOW,
      },
      validationAttempts: [
        {
          attemptId: crypto.randomUUID(),
          scope: 'implementation',
          implementationId: '00000000-0000-4000-8000-0000000000aa',
          implementationDigest: digest,
          executionObservation: TEST_EXECUTION_OBSERVATION,
          result: {
            checkId,
            passed: overrides.passed ?? true,
            detail: '',
            executedAt: NOW,
            kind: 'test',
            command: 'npm test',
            exitCode: (overrides.passed ?? true) ? 0 : 1,
            executionMs: 5,
            outputDigest: SHA,
            timedOut: false,
            outcome: 'supported' as const,
          },
        },
        {
          attemptId: crypto.randomUUID(),
          scope: 'implementation',
          implementationId: '00000000-0000-4000-8000-0000000000aa',
          implementationDigest: digest,
          executionObservation: TEST_EXECUTION_OBSERVATION,
          result: {
            checkId: 'security',
            passed: true,
            detail: '',
            executedAt: NOW,
            kind: 'security',
            command: 'npm run security',
            exitCode: 0,
            executionMs: 5,
            outputDigest: SHA,
            timedOut: false,
            outcome: 'supported' as const,
            assertionExtraction: makeAssertionExtraction(
              'junit:com.example.SecurityTest#verify',
              'passed',
            ),
          },
        },
      ],
      verificationCandidates: [
        {
          assertionCapability: 'unsupported' as const,
          candidateId: 'vc_test_impl',
          kind: checkId as 'test',
          command: 'npm test',
          source: 'test',
          confidence: 'high' as const,
          reason: 'test',
        },
        makeStructuredSecurityCandidate(),
      ],
    });
    return sessDir;
  }

  it('declares a claim, persists the contract + projection, and reports PROVEN', async () => {
    const sessDir = await seedImplValidation({ checkId: 'test', passed: true });
    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [
            {
              statement: 'the change is covered by the test check',
              checkId: 'test',
              critical: true,
              claimScope: 'specific_behavior',
              counterexampleRequirement: {
                checkId: 'security',
                kind: 'assertion',
                assertion: { providerId: 'junit', localId: 'com.example.SecurityTest#verify' },
              },
              authority: 'ticket',
            },
          ],
        },
        ctx,
      ),
    );
    const projection = result.proofGraph as Record<string, unknown>;
    expect(projection).toBeDefined();
    const claims = projection.claims as Array<Record<string, unknown>>;
    expect(claims).toHaveLength(1);
    expect(claims[0]!.signalClass).toBe('fact');
    expect(claims[0]!.verificationState).toBe('PROVEN');

    const persisted = await readState(sessDir);
    expect(persisted!.proofContract?.claims).toHaveLength(1);
    expect(persisted!.proofGraph?.claims[0]?.verificationState).toBe('PROVEN');
  });

  it('appends a manual plan-provenanced fact without changing certificate-bound claims or coverage', async () => {
    const sessDir = await seedImplValidation({ checkId: 'test', passed: true });
    const state = await readState(sessDir);
    const existingClaim = {
      claimId: '10000000-0000-4000-8000-000000000001',
      statement: 'The approved behavior remains covered.',
      signalClass: 'fact' as const,
      critical: true,
      provenance: {
        kind: 'canonical_authority' as const,
        authorityId: 'plan' as const,
        digest: 'approved-plan-digest',
        approval: {
          certificateId: '20000000-0000-4000-8000-000000000002',
          claimDeclarationsDigest: SHA,
          decisionAttestationDigest: SHA,
          declarationId: '10000000-0000-4000-8000-000000000001',
        },
      },
      evidenceRefs: [
        { kind: 'validation_attempt' as const, attemptId: state!.validationAttempts[0]!.attemptId },
      ],
      counterexampleRefs: [
        { kind: 'validation_attempt' as const, attemptId: state!.validationAttempts[1]!.attemptId },
      ],
      counterexampleRequirement: {
        kind: 'assertion' as const,
        checkId: 'security',
        assertion: { providerId: 'junit', localId: 'com.example.SecurityTest#verify' },
      },
      requiredEvidence: {
        positive: ['executed_test' as const],
        adversarial: ['counterexample' as const],
      },
    };
    const coverage = [{ claimId: existingClaim.claimId, cause: 'missing_expected_check' as const }];
    await writeStateWithArtifacts(sessDir, {
      ...state!,
      plan: {
        current: makePlanRevision({ body: 'manual authority plan', createdAt: NOW }),
        history: [],
        reviewCompletion: 'pending',
      },
      proofContract: { version: 'contract.v2', claims: [existingClaim] },
      proofContractCoverage: coverage,
    });

    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [
            {
              statement: 'The manual plan-provenanced fact is covered.',
              checkId: 'test',
              critical: true,
              claimScope: 'specific_behavior',
              counterexampleRequirement: {
                checkId: 'security',
                kind: 'assertion',
                assertion: { providerId: 'junit', localId: 'com.example.SecurityTest#verify' },
              },
              authority: 'plan',
            },
          ],
        },
        ctx,
      ),
    );
    expect(result.error).toBeUndefined();

    const persisted = await readState(sessDir);
    expect(persisted!.proofContract?.claims).toHaveLength(2);
    expect(persisted!.proofContract?.claims[0]).toEqual(existingClaim);
    expect(persisted!.proofContractCoverage).toEqual(coverage);
    const manual = persisted!.proofContract!.claims[1]!;
    expect(manual).toMatchObject({ signalClass: 'fact', provenance: { authorityId: 'plan' } });
    expect(
      manual.provenance?.kind === 'canonical_authority' && manual.provenance.approval,
    ).toBeUndefined();

    const statusResult = parseToolResult(await status.execute({ proofGraph: true }, ctx));
    expect(statusResult.persistedProofGraph).toMatchObject({
      claimCount: 2,
      contractClaimCount: 2,
    });
    expect(statusResult.proofApprovals).toMatchObject({
      implementationDigest: 'impl-digest-1',
      coverageGaps: coverage,
    });
    expect((statusResult.proofApprovals as { claims: unknown[] }).claims).toHaveLength(2);
    expect(
      (statusResult.proofGraph as { projection: { claims: unknown[] } }).projection.claims,
    ).toHaveLength(2);
  });

  it('blocks a derived manual claim id collision without mutating state', async () => {
    const sessDir = await seedImplValidation();
    const statement = 'A colliding manual claim.';
    // The collision is only detectable when the persisted id was minted by the
    // same identity authority the tool derives its candidate id from.
    const claimId = mintProofGraphClaimId({ domain: 'manual', statement });
    const state = await readState(sessDir);
    await writeStateWithArtifacts(sessDir, {
      ...state!,
      proofContract: {
        version: 'contract.v2',
        claims: [
          {
            claimId,
            statement: 'Existing claim with the derived id.',
            signalClass: 'hypothesis',
            critical: false,
            provenance: null,
            evidenceRefs: [],
            counterexampleRefs: [],
          },
        ],
      },
    });
    const before = await readState(sessDir);

    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [
            { statement, checkId: 'test', critical: false, claimScope: 'specific_behavior' },
          ],
        },
        ctx,
      ),
    );

    expect(result.code).toBe('PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE');
    expect(String(result.message)).toContain('statement');
    expect(String(result.message)).toContain(claimId);
    expect(await readState(sessDir)).toEqual(before);
  });

  // AC#11 (#762): one critical claim carrying an executed positive test, a
  // negative/fault scenario, and a structural consistency assertion together.
  describe('combined evidence on a single critical claim', () => {
    const COMBINED = {
      statement: 'the declared command surface is consistent and covered by tests',
      checkId: 'test',
      critical: true,
      claimScope: 'specific_behavior' as const,
      counterexampleRequirement: {
        checkId: 'security',
        kind: 'assertion' as const,
        assertion: { providerId: 'junit', localId: 'com.example.SecurityTest#verify' },
      },
      authority: 'ticket' as const,
      structuralSurface: 'command-registration' as const,
    };

    it('is PROVEN with positive + negative + structural evidence bound to one claim', async () => {
      const sessDir = await seedImplValidation({ checkId: 'test', passed: true });
      const result = parseToolResult(await declare_contract.execute({ claims: [COMBINED] }, ctx));
      const claim = (result.proofGraph as Record<string, unknown>).claims as Array<
        Record<string, unknown>
      >;
      expect(claim).toHaveLength(1);
      expect(claim[0]!.critical).toBe(true);
      expect(claim[0]!.signalClass).toBe('fact');
      expect(claim[0]!.verificationState).toBe('PROVEN');

      // All three evidence kinds are actually bound to this one claim.
      const persisted = await readState(sessDir);
      const declared = persisted!.proofContract!.claims[0]!;
      expect(declared.evidenceRefs.map((r) => r.kind).sort()).toEqual([
        'structural_surface',
        'validation_attempt',
      ]);
      expect(declared.counterexampleRefs.map((r) => r.kind)).toEqual(['validation_attempt']);
      // The structural assertion is REQUIRED evidence, not decoration.
      expect([...declared.requiredEvidence!.positive].sort()).toEqual([
        'executed_test',
        'structural_assertion',
      ]);
      expect(declared.requiredEvidence!.adversarial).toEqual(['counterexample']);
    });

    it('is CONTRADICTED when a matching assertion fails', async () => {
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      const digest = 'impl-combined';
      const failedExtraction = {
        status: 'extracted' as const,
        attemptId: '00000000-0000-4000-8000-0000000000aa',
        providerId: 'junit' as const,
        bindingCapability: 'assertion' as const,
        format: 'junit_xml' as const,
        reportDigests: ['a'.repeat(64)],
        assertions: [
          {
            assertion: {
              providerId: 'junit',
              localId: 'com.example.SecurityTest#verifyNoSqlInjection',
            },
            providerId: 'junit',
            status: 'failed' as const,
            testName: 'verifyNoSqlInjection',
            suiteName: 'com.example.SecurityTest',
          },
        ],
        summary: {
          assertionCount: 1,
          passedCount: 0,
          failedCount: 1,
          erroredCount: 0,
          skippedCount: 0,
          suiteInfrastructureError: false,
        },
      };
      const attempt = (checkId: string, passed: boolean) => ({
        attemptId: crypto.randomUUID(),
        scope: 'implementation' as const,
        implementationId: '00000000-0000-4000-8000-0000000000aa',
        implementationDigest: digest,
        executionObservation: TEST_EXECUTION_OBSERVATION,
        result: {
          checkId,
          passed,
          detail: '',
          executedAt: NOW,
          kind: checkId === 'security' ? ('security' as const) : ('test' as const),
          command: 'run',
          exitCode: passed ? 0 : 1,
          executionMs: 5,
          outputDigest: SHA,
          timedOut: false,
          outcome: passed ? ('supported' as const) : ('inconclusive' as const),
        },
      });
      await writeStateWithArtifacts(sessDir, {
        ...state!,
        phase: 'IMPL_VALIDATION',
        activeChecks: ['test', 'security'],
        verificationCandidates: [
          {
            assertionCapability: 'unsupported' as const,
            candidateId: 'vc_test_impl',
            kind: 'test' as const,
            command: 'npm test',
            source: 'test',
            confidence: 'high' as const,
            reason: 'test',
          },
          {
            assertionCapability: 'structured' as const,
            candidateId: 'vc_security_impl',
            kind: 'security' as const,
            command: 'npm run security',
            source: 'test',
            confidence: 'high' as const,
            reason: 'security',
            assertionReport: {
              collection: 'snapshot_diff' as const,
              transport: 'file' as const,
              format: 'junit_xml' as const,
              providerId: 'junit',
              standardPatterns: ['TEST-*.xml'],
            },
          },
        ],
        ticket: {
          text: 'approved ticket',
          digest: 'ticket-digest',
          source: 'user',
          createdAt: NOW,
          riskDeclaration: { kind: 'absent' },
        },
        implementation: {
          implementationId: '00000000-0000-4000-8000-0000000000aa',
          changedFiles: ['a.ts'],
          domainFiles: [],
          digest,
          executedAt: NOW,
        },
        validationAttempts: [
          attempt('test', true),
          {
            ...attempt('security', false),
            result: {
              ...attempt('security', false).result,
              assertionExtraction: failedExtraction,
            },
          },
        ],
      });
      const result = parseToolResult(
        await declare_contract.execute(
          {
            claims: [
              {
                ...COMBINED,
                counterexampleRequirement: {
                  checkId: 'security',
                  kind: 'assertion',
                  assertion: {
                    providerId: 'junit',
                    localId: 'com.example.SecurityTest#verifyNoSqlInjection',
                  },
                },
              },
            ],
          },
          ctx,
        ),
      );
      const claims = (result.proofGraph as Record<string, unknown>).claims as Array<
        Record<string, unknown>
      >;
      expect(claims[0]!.verificationState).toBe('CONTRADICTED');
    });
  });

  it('rejects a critical claim that declares no adversarial counterexample', async () => {
    // Such a claim could never become PROVEN, so it is refused at declaration
    // time rather than recorded as permanently NOT_VERIFIED (#762).
    await seedImplValidation({ checkId: 'test', passed: true });
    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [
            {
              statement: 'critical but unfalsified',
              checkId: 'test',
              critical: true,
              claimScope: 'specific_behavior',
              authority: 'ticket',
            },
          ],
        },
        ctx,
      ),
    );
    expect(result.error).toBe(true);
    expect(result.code).toBe('PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE');
    expect(String(result.message)).toContain('counterexampleRequirement');
  });

  it('rejects a critical claim that reuses its positive check as the counterexample', async () => {
    await seedImplValidation({ checkId: 'test', passed: true });
    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [
            {
              statement: 'critical but not independently falsified',
              checkId: 'test',
              critical: true,
              claimScope: 'specific_behavior',
              counterexampleRequirement: {
                checkId: 'test',
                kind: 'assertion',
                assertion: { providerId: 'junit', localId: 'com.example.Test#testMethod' },
              },
              authority: 'ticket',
            },
          ],
        },
        ctx,
      ),
    );

    expect(result.code).toBe('PROOFGRAPH_CLAIM_UNSATISFIABLE');
    expect(String(result.message)).toContain('counterexampleRequirement');
    expect(String(result.message)).toContain('assertionCapability');
  });

  it('rejects a claim referencing a check that is not active', async () => {
    await seedImplValidation({ checkId: 'test', passed: true });
    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [
            {
              statement: 'x',
              checkId: 'nonexistent',
              critical: false,
              claimScope: 'specific_behavior',
            },
          ],
        },
        ctx,
      ),
    );
    expect(result.error).toBe(true);
    expect(result.code).toBe('PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE');
    // The public field name must be the one the caller supplied.
    expect(String(result.message)).toContain('checkId');
  });

  it('classifies a claim without an approved authority as a NOT_VERIFIED hypothesis', async () => {
    await seedImplValidation({ checkId: 'test', passed: true });
    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [
            {
              statement: 'unsourced assertion',
              checkId: 'test',
              critical: false,
              claimScope: 'specific_behavior',
            },
          ],
        },
        ctx,
      ),
    );
    const claims = (result.proofGraph as Record<string, unknown>).claims as Array<
      Record<string, unknown>
    >;
    expect(claims[0]!.signalClass).toBe('hypothesis');
    expect(claims[0]!.provenance).toBeNull();
    expect(claims[0]!.verificationState).toBe('NOT_VERIFIED');
  });

  it('reports UNPROVEN when the covering check failed', async () => {
    await seedImplValidation({ checkId: 'test', passed: false });
    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [
            {
              statement: 'covered by a failing check',
              checkId: 'test',
              critical: false,
              claimScope: 'specific_behavior',
              authority: 'ticket',
            },
          ],
        },
        ctx,
      ),
    );
    const claims = (result.proofGraph as Record<string, unknown>).claims as Array<
      Record<string, unknown>
    >;
    expect(claims[0]!.verificationState).toBe('UNPROVEN');
  });

  it('fails closed when an active check has no implementation attempt', async () => {
    await seedImplValidation({ checkId: 'test', unattemptedChecks: ['lint'] });
    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [
            { statement: 'x', checkId: 'lint', critical: false, claimScope: 'specific_behavior' },
          ],
        },
        ctx,
      ),
    );
    expect(result.error).toBe(true);
    expect(result.code).toBe('PROOFGRAPH_CLAIM_EVIDENCE_UNRESOLVED');
  });

  it('is not allowed outside the implementation phases', async () => {
    await hydrateSession();
    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [
            { statement: 'x', checkId: 'test', critical: false, claimScope: 'specific_behavior' },
          ],
        },
        ctx,
      ),
    );
    expect(result.error).toBe(true);
    expect(result.code).toBe('COMMAND_NOT_ALLOWED');
  });

  it('reports CONTRADICTED when a declared counterexample assertion falsifies', async () => {
    await hydrateSession();
    const { computeFingerprint, sessionDir: resolveSessionDir } =
      await import('../adapters/workspace/index.js');
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
    const state = await readState(sessDir);
    const digest = 'impl-cx';
    const assertionId = 'junit:com.example.SecurityTest#verifyNoXss';
    function attempt(checkId: string, passed: boolean) {
      return {
        attemptId: crypto.randomUUID(),
        scope: 'implementation' as const,
        implementationId: '00000000-0000-4000-8000-0000000000aa',
        implementationDigest: digest,
        executionObservation: TEST_EXECUTION_OBSERVATION,
        result: {
          checkId,
          passed,
          detail: '',
          executedAt: NOW,
          kind: checkId === 'security' ? ('security' as const) : ('test' as const),
          command: 'run',
          exitCode: passed ? 0 : 1,
          executionMs: 5,
          outputDigest: SHA,
          timedOut: false,
          outcome: passed ? ('supported' as const) : ('inconclusive' as const),
        },
      };
    }
    await writeStateWithArtifacts(sessDir, {
      ...state!,
      phase: 'IMPL_REVIEW',
      activeChecks: ['test', 'security'],
      verificationCandidates: [
        {
          assertionCapability: 'unsupported' as const,
          candidateId: 'vc_test_cx',
          kind: 'test' as const,
          command: 'npm test',
          source: 'test',
          confidence: 'high' as const,
          reason: 'test',
        },
        makeStructuredSecurityCandidate(),
      ],
      ticket: {
        text: 'approved ticket',
        digest: 'ticket-digest',
        source: 'user',
        createdAt: NOW,
        riskDeclaration: { kind: 'absent' },
      },
      implementation: {
        implementationId: '00000000-0000-4000-8000-0000000000aa',
        changedFiles: ['a.ts'],
        domainFiles: [],
        digest,
        executedAt: NOW,
      },
      validationAttempts: [
        attempt('test', true),
        {
          ...attempt('security', false),
          result: {
            ...attempt('security', false).result,
            assertionExtraction: makeAssertionExtraction(assertionId, 'failed'),
          },
        },
      ],
    });
    const result = parseToolResult(
      await declare_contract.execute(
        {
          claims: [
            {
              statement: 'the change is safe',
              checkId: 'test',
              critical: true,
              claimScope: 'specific_behavior',
              authority: 'ticket',
              counterexampleRequirement: {
                checkId: 'security',
                kind: 'assertion',
                assertion: { providerId: 'junit', localId: 'com.example.SecurityTest#verifyNoXss' },
              },
            },
          ],
        },
        ctx,
      ),
    );
    const claims = (result.proofGraph as Record<string, unknown>).claims as Array<
      Record<string, unknown>
    >;
    expect(claims[0]!.verificationState).toBe('CONTRADICTED');
    const persisted = await readState(sessDir);
    expect(persisted!.proofGraph?.claims[0]?.verificationState).toBe('CONTRADICTED');
  });
});
