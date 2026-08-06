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
import {
  materializeApprovedPlanContract,
  materializeApprovedPlanContractResult,
} from './materialize-contract.js';

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
            counterexampleCheckId: 'security',
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
                counterexampleCheckId: 'security',
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
        reviewObligationId: null,
        reviewEvidenceDigest: null,
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
      };
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

  it('legacy counterexampleCheckId is normalized and materialized with counterexampleRefs', async () => {
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
      mode: 'check',
      checkId: 'security',
    });
  });
});
