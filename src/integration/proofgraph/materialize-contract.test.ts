import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeState } from '../../fixtures.js';
import {
  computeArtifactDigest,
  computeProjectionDigest,
} from '../../audit/proofgraph/mutation-report.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';
import { computeRecordDigest } from '../../state/evidence-plan.js';
import { evaluateProofGraph } from '../../audit/proofgraph/evaluate.js';
import { deriveProofGraph } from '../../audit/proofgraph/derive.js';
import {
  materializeApprovedPlanContract,
  materializeApprovedPlanContractResult,
} from './materialize-contract.js';
import type { PlanClaimDeclarations } from '../../state/proofgraph-approval.js';

const PLAN_DIGEST = 'approved-plan';
const IMPL_DIGEST = 'current-implementation';
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const CLAIM_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-01-01T00:00:00.000Z';

/**
 * The plan's record digest. The approval certificate binds this exact value:
 * `hasCurrentPlanApprovalCertificate` rejects a certificate whose
 * `planRecordDigest` differs from the plan's, so the fixture must derive both
 * from the same computation rather than using a placeholder literal.
 */
const PLAN_RECORD_DIGEST = computeRecordDigest({
  contentDigest: PLAN_DIGEST,
  planVersion: 1,
  supersedesRecordDigest: null,
  originatingReviewObligationId: null,
  revisionReason: null,
});

function stateWithClaims() {
  const state = makeState('IMPL_REVIEW', {
    verificationCandidates: [
      {
        assertionCapability: 'unsupported' as const,
        kind: 'test' as const,
        command: './mvnw verify',
        source: 'repo:mvnw',
        confidence: 'high' as const,
        reason: 'Maven test',
      },
      {
        assertionCapability: 'structured' as const,
        kind: 'security' as const,
        command: './mvnw test',
        source: 'repo:mvnw',
        confidence: 'high' as const,
        reason: 'JUnit via Maven wrapper',
        assertionReport: {
          collection: 'snapshot_diff' as const,
          transport: 'file' as const,
          format: 'junit_xml' as const,
          providerId: 'junit' as const,
          standardPatterns: ['target/surefire-reports/TEST-*.xml'],
        },
      },
    ],
    plan: {
      current: {
        body: 'approved plan',
        digest: PLAN_DIGEST,
        sections: [],
        createdAt: NOW,
        recordDigest: PLAN_RECORD_DIGEST,
        planVersion: 1,
        supersedesRecordDigest: null,
        originatingReviewObligationId: null,
        revisionReason: null,
        lineageStatus: 'verified' as const,
      },
      history: [],
      claimDeclarations: {
        flow: 'plan',
        claims: [
          {
            claimId: CLAIM_ID,
            statement: 'the approved plan behavior is implemented',
            critical: true,
            authoritySectionId: 'implementation',
            expectedCheckId: 'test',
            counterexampleRequirement: {
              checkId: 'security',
              assertion: { providerId: 'junit', localId: 'some-id' },
            },
            structuralSurface: 'command-registration',
            mutationProfile: 'semantic',
          },
        ],
      },
      approvalCertificate: {
        flow: 'plan',
        authorityDigest: PLAN_DIGEST,
        claimDeclarationsDigest: hashText(
          canonicalJsonStringify({
            flow: 'plan',
            claims: [
              {
                claimId: CLAIM_ID,
                statement: 'the approved plan behavior is implemented',
                critical: true,
                authoritySectionId: 'implementation',
                expectedCheckId: 'test',
                counterexampleRequirement: {
                  checkId: 'security',
                  assertion: { providerId: 'junit', localId: 'some-id' },
                },
                structuralSurface: 'command-registration',
                mutationProfile: 'semantic',
              },
            ],
          }),
        ),
        decisionAttestationDigest: 'a'.repeat(64),
        approvedAt: NOW,
        approvedBy: 'user',
        certificateId: '00000000-0000-4000-8000-000000000001',
        planVersion: 1,
        planRecordDigest: PLAN_RECORD_DIGEST,
        reviewBinding: {
          kind: 'current_review',
          reviewObligationId: '00000000-0000-4000-8000-0000000000ab',
          reviewEvidenceDigest: 'e'.repeat(64),
          reviewedSubjectDigest: PLAN_DIGEST,
        },
        reviewObligationId: '00000000-0000-4000-8000-0000000000ab',
        reviewEvidenceDigest: 'e'.repeat(64),
      },
    },
    reviewDecision: {
      verdict: 'approve',
      rationale: 'approved',
      decidedAt: NOW,
      decidedBy: 'user',
    },
    implementation: {
      changedFiles: ['src/example.ts'],
      domainFiles: ['src/example.ts'],
      digest: IMPL_DIGEST,
      executedAt: NOW,
    },
    validationAttempts: [
      {
        attemptId: ATTEMPT_ID,
        scope: 'implementation',
        implementationDigest: IMPL_DIGEST,
        result: {
          checkId: 'test',
          passed: true,
          detail: 'passed',
          executedAt: NOW,
          kind: 'test',
          command: 'npm test',
          exitCode: 0,
          executionMs: 1,
          outputDigest: 'a'.repeat(64),
          timedOut: false,
          outcome: 'supported' as const,
        },
      },
    ],
  });
  return state;
}

describe('materializeApprovedPlanContract', () => {
  it('keeps a current legacy certificate audit-valid while making its claim proof-ineligible', async () => {
    const state = stateWithClaims();
    const materialized = await materializeApprovedPlanContractResult(state, process.cwd());
    expect(materialized.coverage).toContainEqual({
      claimId: CLAIM_ID,
      cause: 'legacy_claim_declaration_v1',
    });
    expect(materialized.contract.claims[0]!.proofEligibility).toBe('legacy_declaration_v1');
    const projection = evaluateProofGraph(
      {
        claims: materialized.contract.claims,
        providerResults: [],
        counterexamples: [],
        currentImplementationDigest: IMPL_DIGEST,
      },
      NOW,
    );
    expect(projection.claims[0]!.verificationState).toBe('NOT_VERIFIED');
  });

  it('keeps an already-materialized legacy claim from becoming PROVEN when eligibility is absent', () => {
    const state = stateWithClaims();
    const claim = {
      claimId: CLAIM_ID,
      statement: 'the approved plan behavior is implemented',
      signalClass: 'fact' as const,
      critical: false,
      provenance: {
        kind: 'canonical_authority' as const,
        authorityId: 'plan',
        digest: PLAN_DIGEST,
      },
      evidenceRefs: [],
      counterexampleRefs: [],
    };
    const projection = deriveProofGraph(
      { ...state, proofContract: { version: 'contract.v1' as const, claims: [claim] } },
      [
        {
          claimId: CLAIM_ID,
          providerKind: 'executed_test',
          providerId: 'test-provider',
          providerVersion: '1',
          status: 'pass',
          input: { command: 'npm test' },
          source: { location: 'package.json', stableId: 'test' },
          binding: { kind: 'implementation', digest: IMPL_DIGEST },
          resultDigest: 'a'.repeat(64),
          executedAt: NOW,
          attestation: 'flowguard_executed',
        },
      ],
      [],
      NOW,
    );
    expect(state.plan!.approvalCertificate).toBeDefined();
    expect(projection.claims[0]!.verificationState).toBe('NOT_VERIFIED');
  });

  it('materializes approved pre-evidence claims with current implementation attempts only', async () => {
    const contract = await materializeApprovedPlanContract(stateWithClaims(), process.cwd());

    expect(contract.claims).toHaveLength(1);
    expect(contract.claims[0]!.evidenceRefs).toEqual([
      { kind: 'validation_attempt', attemptId: ATTEMPT_ID },
      { kind: 'structural_surface', surfaceId: 'command-registration' },
    ]);
    expect(contract.claims[0]!.provenance).toEqual({
      kind: 'canonical_authority',
      authorityId: 'plan',
      digest: PLAN_DIGEST,
      approval: {
        certificateId: '00000000-0000-4000-8000-000000000001',
        claimDeclarationsDigest:
          stateWithClaims().plan!.approvalCertificate!.claimDeclarationsDigest,
        decisionAttestationDigest: 'a'.repeat(64),
        declarationId: CLAIM_ID,
      },
    });
  });

  it('retains a claim with required executed-test coverage when its expected check is absent', async () => {
    const state = stateWithClaims();
    const contract = await materializeApprovedPlanContract(
      { ...state, validationAttempts: [] },
      process.cwd(),
    );

    expect(contract.claims).toHaveLength(1);
    expect(contract.claims[0]!.evidenceRefs).toEqual([
      { kind: 'structural_surface', surfaceId: 'command-registration' },
    ]);
    expect(contract.claims[0]!.requiredEvidence).toEqual({
      positive: ['executed_test', 'structural_assertion', 'fault_injection'],
      adversarial: ['counterexample'],
    });
    expect(
      (
        await materializeApprovedPlanContractResult(
          { ...state, validationAttempts: [] },
          process.cwd(),
        )
      ).coverage,
    ).toEqual([
      { claimId: CLAIM_ID, cause: 'legacy_claim_declaration_v1' },
      { claimId: CLAIM_ID, cause: 'missing_expected_check' },
      { claimId: CLAIM_ID, cause: 'unverified_mutation_profile' },
    ]);
  });

  it('binds the newest digest-verified current mutation attempt on later materialization', async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), 'flowguard-materialize-'));
    const reportPath = 'reports/mutation/mutation.json';
    const rawReport = JSON.stringify({
      schemaVersion: '1',
      files: {
        'src/audit/proofgraph/evaluate.ts': {
          mutants: [{ id: '1', mutatorName: 'BooleanLiteral', status: 'Killed' }],
        },
      },
    });
    try {
      await mkdir(path.join(worktree, 'reports', 'mutation'), { recursive: true });
      await writeFile(path.join(worktree, reportPath), rawReport, 'utf8');
      const initial = stateWithClaims();
      const declarations = {
        flow: 'plan' as const,
        claims: [
          {
            ...initial.plan!.claimDeclarations!.claims[0]!,
            mutationProfile: 'proofgraph-evaluator',
          },
        ],
      } as NonNullable<typeof initial.plan>['claimDeclarations'];
      const state = {
        ...initial,
        plan: {
          ...initial.plan!,
          claimDeclarations: declarations,
          approvalCertificate: {
            ...initial.plan!.approvalCertificate!,
            claimDeclarationsDigest: hashText(canonicalJsonStringify(declarations)),
          },
        },
      };
      const materialized = await materializeApprovedPlanContractResult(
        {
          ...state,
          mutationAttempts: [
            {
              attemptId: '33333333-3333-4333-8333-333333333333',
              implementationDigest: IMPL_DIGEST,
              command: 'npm run mutation',
              startedAt: NOW,
              completedAt: '2026-01-01T00:01:00.000Z',
              exitCode: 0,
              artifactDigest: computeArtifactDigest(rawReport),
              projectionDigest: computeProjectionDigest(JSON.parse(rawReport)),
              reportPath,
              providerVersion: 'semantic-mutation.v1',
            },
          ],
        },
        worktree,
      );

      expect(materialized.contract.claims[0]!.evidenceRefs).toContainEqual({
        kind: 'mutation_attempt',
        attemptId: '33333333-3333-4333-8333-333333333333',
        profileId: 'proofgraph-evaluator',
      });
      expect(materialized.coverage).not.toContainEqual({
        claimId: CLAIM_ID,
        cause: 'unverified_mutation_profile',
      });
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it('records diagnostic coverage when declarations or approval eligibility are absent', async () => {
    const state = stateWithClaims();
    await expect(
      materializeApprovedPlanContractResult(
        { ...state, plan: { ...state.plan!, claimDeclarations: undefined } },
        process.cwd(),
      ),
    ).resolves.toMatchObject({ coverage: [{ cause: 'missing_declarations' }] });
    await expect(
      materializeApprovedPlanContractResult(
        { ...state, plan: { ...state.plan!, approvalCertificate: undefined } },
        process.cwd(),
      ),
    ).resolves.toMatchObject({ coverage: [{ cause: 'missing_certificate' }] });
    await expect(
      materializeApprovedPlanContractResult({ ...state, implementation: null }, process.cwd()),
    ).resolves.toMatchObject({ coverage: [{ cause: 'missing_implementation' }] });
  });

  it('fails closed with invalid certificate coverage when a certificate is stale', async () => {
    const state = stateWithClaims();
    const withoutCertificate = await materializeApprovedPlanContract(
      { ...state, plan: { ...state.plan!, approvalCertificate: undefined } },
      process.cwd(),
    );
    const staleCertificate = await materializeApprovedPlanContract(
      {
        ...state,
        plan: {
          ...state.plan!,
          approvalCertificate: {
            ...state.plan!.approvalCertificate!,
            authorityDigest: 'other-plan',
          },
        },
      },
      process.cwd(),
    );

    expect(withoutCertificate).toEqual({ version: 'contract.v1', claims: [] });
    expect(staleCertificate).toEqual({ version: 'contract.v1', claims: [] });
  });

  it('fails closed when the certificate declaration digest is not canonical', async () => {
    const state = stateWithClaims();
    const result = await materializeApprovedPlanContractResult(
      {
        ...state,
        plan: {
          ...state.plan!,
          approvalCertificate: {
            ...state.plan!.approvalCertificate!,
            claimDeclarationsDigest: 'b'.repeat(64),
          },
        },
      },
      process.cwd(),
    );

    expect(result).toEqual({
      contract: { version: 'contract.v1', claims: [] },
      coverage: [{ cause: 'invalid_certificate' }],
    });
  });

  it('counterexample requirement is materialized with counterexampleRefs', async () => {
    const state = stateWithClaims();
    const result = await materializeApprovedPlanContractResult(
      {
        ...state,
        validationAttempts: [
          {
            attemptId: '11111111-1111-4111-8111-111111111111',
            scope: 'implementation' as const,
            implementationDigest: IMPL_DIGEST,
            result: {
              checkId: 'test',
              passed: true,
              detail: 'passed',
              executedAt: NOW,
              kind: 'test' as const,
              command: 'npm test',
              exitCode: 0,
              executionMs: 1,
              outputDigest: 'a'.repeat(64),
              timedOut: false,
              outcome: 'supported' as const,
            },
          },
          {
            attemptId: '22222222-2222-4222-8222-222222222222',
            scope: 'implementation' as const,
            implementationDigest: IMPL_DIGEST,
            result: {
              checkId: 'security',
              passed: true,
              detail: 'passed',
              executedAt: NOW,
              kind: 'security' as const,
              command: 'npm run security',
              exitCode: 0,
              executionMs: 1,
              outputDigest: 'b'.repeat(64),
              timedOut: false,
              outcome: 'supported' as const,
            },
          },
        ],
      },
      process.cwd(),
    );
    const claim = result.contract.claims[0];
    expect(claim).toBeDefined();
    expect(claim!.counterexampleRefs).toHaveLength(1);
    expect((claim!.counterexampleRefs[0]! as { attemptId: string }).attemptId).toBe(
      '22222222-2222-4222-8222-222222222222',
    );
    expect(claim!.counterexampleRequirement).toEqual({
      checkId: 'security',
      assertion: { providerId: 'junit', localId: 'some-id' },
    });
  });
});

describe('materializeApprovedPlanContractResult — mutation coverage', () => {
  const AGG_ID = '33333333-3333-4333-8333-333333333333';
  const V2_CLAIM_ID = '44444444-4444-4444-8444-444444444444';

  const EXTRACTED_AGGREGATE = {
    status: 'extracted' as const,
    attemptId: AGG_ID,
    providerId: 'junit' as const,
    format: 'junit_xml' as const,
    bindingCapability: 'aggregate' as const,
    reportDigests: ['report-digest'],
    assertions: [],
    summary: {
      assertionCount: 0,
      passedCount: 0,
      failedCount: 0,
      erroredCount: 0,
      skippedCount: 0,
      suiteInfrastructureError: false,
    },
  };

  function aggregateAttempt(candidateId?: string) {
    return {
      attemptId: AGG_ID,
      scope: 'implementation' as const,
      implementationDigest: IMPL_DIGEST,
      result: {
        checkId: 'security',
        passed: true,
        detail: 'aggregate',
        executedAt: NOW,
        kind: 'security' as const,
        command: 'npm run security',
        exitCode: 0,
        executionMs: 1,
        outputDigest: 'c'.repeat(64),
        timedOut: false,
        outcome: 'supported' as const,
        fullCheckScopeAttestation: 'full_check' as const,
        assertionExtraction: EXTRACTED_AGGREGATE,
        ...(candidateId ? { candidateId } : {}),
      },
    };
  }

  function v2Declarations(claims: unknown[]) {
    return { flow: 'plan' as const, version: 'v2' as const, claims };
  }

  function withV2Declarations(state: ReturnType<typeof stateWithClaims>, claims: unknown[]) {
    // Test fixtures build v2 declaration bodies inline; the runtime contract
    // is `'version' in declarations` + `claimScope` presence, not a schema parse.
    const declarations = v2Declarations(claims) as PlanClaimDeclarations;
    return {
      ...state,
      plan: {
        ...state.plan!,
        claimDeclarations: declarations,
        approvalCertificate: {
          ...state.plan!.approvalCertificate!,
          claimDeclarationsDigest: hashText(canonicalJsonStringify(declarations)),
        },
      },
    };
  }

  it('versioned declarations materialize with claimScope and eligible eligibility', async () => {
    const state = withV2Declarations(stateWithClaims(), [
      {
        claimId: V2_CLAIM_ID,
        statement: 'v2 claim',
        critical: true,
        authoritySectionId: 'implementation',
        claimScope: 'specific_behavior',
        expectedCheckId: 'test',
      },
    ]);
    const result = await materializeApprovedPlanContractResult(state, process.cwd());
    expect(result.coverage).toEqual([]);
    const claim = result.contract.claims[0]!;
    expect(claim.claimScope).toBe('specific_behavior');
    expect(claim.proofEligibility).toBe('eligible');
    expect(claim.requiredEvidence).toEqual({
      positive: ['executed_test'],
      adversarial: ['counterexample'],
    });
  });

  it('requires schema_compare for config-defaults surfaces and structural_assertion otherwise', async () => {
    const state = stateWithClaims();
    const declarations = {
      flow: 'plan' as const,
      claims: [
        {
          claimId: '55555555-5555-4555-8555-555555555555',
          statement: 'config defaults claim',
          critical: false,
          authoritySectionId: 'implementation',
          expectedCheckId: 'test',
          structuralSurface: 'config-defaults',
        },
        {
          claimId: '66666666-6666-4666-8666-666666666666',
          statement: 'command registration claim',
          critical: false,
          authoritySectionId: 'implementation',
          expectedCheckId: 'test',
          structuralSurface: 'command-registration',
        },
      ],
    };
    const plan = {
      ...state.plan!,
      claimDeclarations: declarations,
      approvalCertificate: {
        ...state.plan!.approvalCertificate!,
        claimDeclarationsDigest: hashText(canonicalJsonStringify(declarations)),
      },
    };
    const result = await materializeApprovedPlanContractResult({ ...state, plan }, process.cwd());
    const claims = result.contract.claims as readonly {
      requiredEvidence: { positive: string[]; adversarial: string[] };
    }[];
    expect(claims[0]!.requiredEvidence.positive).toEqual(['executed_test', 'schema_compare']);
    expect(claims[1]!.requiredEvidence.positive).toEqual(['executed_test', 'structural_assertion']);
    expect(claims[0]!.requiredEvidence.adversarial).toEqual([]);
  });

  it('records unverified_mutation_profile and requires fault_injection without a verified attempt', async () => {
    const state = stateWithClaims();
    const result = await materializeApprovedPlanContractResult(
      { ...state, mutationAttempts: [] },
      process.cwd(),
    );
    expect(result.coverage).toContainEqual({
      claimId: CLAIM_ID,
      cause: 'unverified_mutation_profile',
    });
    expect(result.contract.claims[0]!.requiredEvidence!.positive).toContain('fault_injection');
  });

  it('binds aggregate counterexample attempts matching checkId, candidateId, and aggregate extraction', async () => {
    const state = withV2Declarations(stateWithClaims(), [
      {
        claimId: V2_CLAIM_ID,
        statement: 'aggregate claim',
        critical: false,
        authoritySectionId: 'implementation',
        claimScope: 'suite',
        expectedCheckId: 'test',
        counterexampleRequirement: {
          kind: 'aggregate_check',
          checkId: 'security',
          candidateId: 'vc-sec',
        },
      },
    ]);
    const result = await materializeApprovedPlanContractResult(
      { ...state, validationAttempts: [aggregateAttempt('vc-sec')] },
      process.cwd(),
    );
    expect(result.coverage).toEqual([{ claimId: V2_CLAIM_ID, cause: 'missing_expected_check' }]);
    const claim = result.contract.claims[0]!;
    expect(claim.counterexampleRefs).toHaveLength(1);
  });

  it('records an aggregate gap when the attempt candidateId does not match', async () => {
    const state = withV2Declarations(stateWithClaims(), [
      {
        claimId: V2_CLAIM_ID,
        statement: 'aggregate claim',
        critical: false,
        authoritySectionId: 'implementation',
        claimScope: 'suite',
        expectedCheckId: 'test',
        counterexampleRequirement: {
          kind: 'aggregate_check',
          checkId: 'security',
          candidateId: 'vc-sec',
        },
      },
    ]);
    const result = await materializeApprovedPlanContractResult(
      { ...state, validationAttempts: [aggregateAttempt('vc-other')] },
      process.cwd(),
    );
    expect(result.coverage).toContainEqual({
      claimId: V2_CLAIM_ID,
      cause: 'aggregate_counterexample_unsupported',
    });
    expect(result.contract.claims[0]!.counterexampleRefs).toHaveLength(0);
  });

  it('accepts an aggregate attempt when the requirement does not pin a candidateId', async () => {
    const state = withV2Declarations(stateWithClaims(), [
      {
        claimId: V2_CLAIM_ID,
        statement: 'aggregate claim',
        critical: false,
        authoritySectionId: 'implementation',
        claimScope: 'suite',
        expectedCheckId: 'test',
        counterexampleRequirement: { kind: 'aggregate_check', checkId: 'security' },
      },
    ]);
    const result = await materializeApprovedPlanContractResult(
      { ...state, validationAttempts: [aggregateAttempt('vc-anything')] },
      process.cwd(),
    );
    expect(result.contract.claims[0]!.counterexampleRefs).toHaveLength(1);
  });

  it('records an aggregate gap when the attempt lacks full_check or aggregate binding', async () => {
    const state = withV2Declarations(stateWithClaims(), [
      {
        claimId: V2_CLAIM_ID,
        statement: 'aggregate claim',
        critical: false,
        authoritySectionId: 'implementation',
        claimScope: 'suite',
        expectedCheckId: 'test',
        counterexampleRequirement: { kind: 'aggregate_check', checkId: 'security' },
      },
    ]);
    const withoutFullCheck = {
      ...aggregateAttempt(),
      result: {
        ...aggregateAttempt().result,
        fullCheckScopeAttestation: undefined,
      },
    };
    const result = await materializeApprovedPlanContractResult(
      { ...state, validationAttempts: [withoutFullCheck] },
      process.cwd(),
    );
    expect(result.coverage).toContainEqual({
      claimId: V2_CLAIM_ID,
      cause: 'aggregate_counterexample_unsupported',
    });
  });

  it('records invalid_counterexample_contract for a non-structured candidate', async () => {
    const state = stateWithClaims();
    const result = await materializeApprovedPlanContractResult(
      {
        ...state,
        verificationCandidates: [
          {
            assertionCapability: 'unsupported' as const,
            kind: 'security' as const,
            command: './mvnw security',
            source: 'repo:mvnw',
            confidence: 'high' as const,
            reason: 'not structured',
          },
        ],
      },
      process.cwd(),
    );
    expect(result.coverage).toContainEqual({
      claimId: CLAIM_ID,
      cause: 'invalid_counterexample_contract',
    });
    expect(result.contract.claims[0]!.counterexampleRefs).toHaveLength(0);
  });

  it('excludes attempts with a foreign scope or implementation digest from evidenceRefs', async () => {
    const state = stateWithClaims();
    const result = await materializeApprovedPlanContractResult(
      {
        ...state,
        validationAttempts: [
          ...state.validationAttempts,
          {
            attemptId: '77777777-7777-4777-8777-777777777777',
            scope: 'baseline' as const,
            planDigest: 'baseline-plan-digest',
            result: {
              checkId: 'test',
              passed: true,
              detail: 'foreign scope',
              executedAt: NOW,
              kind: 'test' as const,
              command: 'npm test',
              exitCode: 0,
              executionMs: 1,
              outputDigest: 'd'.repeat(64),
              timedOut: false,
              outcome: 'supported' as const,
            },
          },
          {
            attemptId: '88888888-8888-4888-8888-888888888888',
            scope: 'implementation' as const,
            implementationDigest: 'other-implementation',
            result: {
              checkId: 'test',
              passed: true,
              detail: 'foreign digest',
              executedAt: NOW,
              kind: 'test' as const,
              command: 'npm test',
              exitCode: 0,
              executionMs: 1,
              outputDigest: 'e'.repeat(64),
              timedOut: false,
              outcome: 'supported' as const,
            },
          },
        ],
      },
      process.cwd(),
    );
    const claim = result.contract.claims[0]!;
    expect(claim.evidenceRefs).toEqual([
      { kind: 'validation_attempt', attemptId: ATTEMPT_ID },
      { kind: 'structural_surface', surfaceId: 'command-registration' },
    ]);
  });

  it('fails closed with invalid_certificate coverage outside IMPL_REVIEW', async () => {
    const state = stateWithClaims();
    const result = await materializeApprovedPlanContractResult(
      { ...state, phase: 'IMPLEMENTATION' as const },
      process.cwd(),
    );
    expect(result.coverage).toEqual([{ cause: 'invalid_certificate' }]);
    expect(result.contract.claims).toHaveLength(0);
  });
});
