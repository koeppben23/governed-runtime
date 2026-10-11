/**
 * @module documentation/live-risk-trigger-controls.test
 * @description Fail-closed oracles and adversarial regressions for the #1074
 * risk-trigger coverage controls.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADVERSARIAL_ASSERTION,
  POSITIVE_ASSERTION,
  assertFullEvidence,
  assertInstalledBuildIdentity,
  assertNoCompletionPackage,
  assertRetainedClaim,
  assertStateIntegrityTrigger,
  claimDeclaration,
} from '../../../demos/risk-trigger-fixture/run-live-risk-trigger-controls.mjs';

const CLAIM_ID = '11111111-1111-4111-8111-111111111111';

function state(covered: boolean) {
  const certificate = {
    certificateId: '22222222-2222-4222-8222-222222222222',
    claimDeclarationsDigest: 'a'.repeat(64),
    decisionAttestationDigest: 'b'.repeat(64),
  };
  const fact = {
    claimId: CLAIM_ID,
    critical: true,
    signalClass: 'fact',
    provenance: {
      kind: 'canonical_authority',
      authorityId: 'plan',
      digest: 'plan-digest',
      approval: { ...certificate, declarationId: CLAIM_ID },
    },
  };
  return {
    phase: 'EVIDENCE_REVIEW',
    implementation: { digest: 'impl-digest' },
    implementationRiskAssessment: { riskTriggers: ['state_integrity'] },
    plan: {
      current: { digest: 'plan-digest' },
      approvalCertificate: certificate,
      claimDeclarations: { claims: [{ claimId: CLAIM_ID, ...claimDeclaration(covered) }] },
    },
    proofContract: { claims: [fact] },
    proofGraph: {
      claims: [
        {
          ...fact,
          verificationState: 'PROVEN',
          freshness: { boundDigest: 'impl-digest', stale: false },
          evidenceRefs: [{ kind: 'validation_attempt', attemptId: 'test-attempt' }],
          counterexampleRefs: [{ kind: 'validation_attempt', attemptId: 'build-attempt' }],
        },
      ],
    },
    validationAttempts: [
      {
        scope: 'implementation',
        attemptId: 'build-attempt',
        result: {
          checkId: 'build',
          passed: true,
          exitCode: 0,
          assertionExtraction: {
            assertions: [
              {
                assertion: { providerId: 'junit', localId: ADVERSARIAL_ASSERTION },
                status: 'passed',
              },
            ],
          },
        },
      },
      {
        scope: 'implementation',
        attemptId: 'test-attempt',
        result: {
          checkId: 'test',
          passed: true,
          exitCode: 0,
          assertionExtraction: {
            assertions: [
              {
                assertion: { providerId: 'junit', localId: POSITIVE_ASSERTION },
                status: 'passed',
              },
            ],
          },
        },
      },
    ],
  };
}

describe('risk-trigger control oracles', () => {
  it('requires the detected state_integrity trigger from the real change', () => {
    expect(assertStateIntegrityTrigger(state(false)).riskTriggers).toEqual(['state_integrity']);
    expect(() =>
      assertStateIntegrityTrigger({ implementationRiskAssessment: { riskTriggers: [] } }),
    ).toThrow(/not detected/);
    expect(() => assertStateIntegrityTrigger({ implementationRiskAssessment: null })).toThrow(
      /not detected/,
    );
  });

  it('compares the retained claim exactly against the control contract', () => {
    expect(assertRetainedClaim(state(true), true)).toBe(CLAIM_ID);
    expect(assertRetainedClaim(state(false), false)).toBe(CLAIM_ID);

    const restatement = state(false);
    restatement.plan.claimDeclarations.claims[0]!.statement = 'A weaker, easier statement.';
    expect(() => assertRetainedClaim(restatement, false)).toThrow(/no longer matches/);

    const authority = state(false);
    authority.plan.claimDeclarations.claims[0]!.authoritySectionId = 'Context';
    expect(() => assertRetainedClaim(authority, false)).toThrow(/no longer matches/);

    const provider = state(false);
    provider.plan.claimDeclarations.claims[0]!.counterexampleRequirement.assertion.providerId =
      'jest';
    expect(() => assertRetainedClaim(provider, false)).toThrow(/no longer matches/);

    const coverage = state(false);
    coverage.plan.claimDeclarations.claims[0]!.coversRiskTriggers = ['state_integrity'];
    expect(() => assertRetainedClaim(coverage, false)).toThrow(/no longer matches/);

    const missingCoverage = state(true);
    missingCoverage.plan.claimDeclarations.claims[0]!.coversRiskTriggers = undefined as never;
    expect(() => assertRetainedClaim(missingCoverage, true)).toThrow(/no longer matches/);

    const empty = state(false);
    empty.plan.claimDeclarations.claims = [];
    expect(() => assertRetainedClaim(empty, false)).toThrow(/retained critical plan claim/);

    const noIdentity = state(false);
    noIdentity.plan.claimDeclarations.claims[0]!.claimId = undefined as never;
    expect(() => assertRetainedClaim(noIdentity, false)).toThrow(/runtime-minted identity/);
  });

  it('requires the same full PROVEN evidence contract before either approval', () => {
    expect(assertFullEvidence(state(true), true).buildAttemptId).toBe('build-attempt');
    expect(assertFullEvidence(state(false), false).testAttemptId).toBe('test-attempt');

    const unproven = state(false);
    unproven.proofGraph.claims[0]!.verificationState = 'NOT_VERIFIED';
    expect(() => assertFullEvidence(unproven, false)).toThrow(/fresh PROVEN/);

    const stale = state(false);
    stale.proofGraph.claims[0]!.freshness.stale = true;
    expect(() => assertFullEvidence(stale, false)).toThrow(/fresh PROVEN/);

    const foreignCertificate = state(false);
    foreignCertificate.proofContract.claims[0]!.provenance.approval.certificateId = 'foreign';
    expect(() => assertFullEvidence(foreignCertificate, false)).toThrow(/certificate binding/);

    const sameAttempt = state(false);
    sameAttempt.validationAttempts[1]!.attemptId = 'build-attempt';
    expect(() => assertFullEvidence(sameAttempt, false)).toThrow(/distinct attempts/);

    const redTest = state(false);
    redTest.validationAttempts[1]!.result.passed = false;
    expect(() => assertFullEvidence(redTest, false)).toThrow(/checks must be green/);

    const skippedAdversarial = state(false);
    skippedAdversarial.validationAttempts[0]!.result.assertionExtraction.assertions[0]!.status =
      'skipped';
    expect(() => assertFullEvidence(skippedAdversarial, false)).toThrow(
      /adversarial assertion must be passed/,
    );

    const skippedPositive = state(false);
    skippedPositive.validationAttempts[1]!.result.assertionExtraction.assertions[0]!.status =
      'skipped';
    expect(() => assertFullEvidence(skippedPositive, false)).toThrow(
      /positive assertion must be passed/,
    );

    const noPositive = state(false);
    noPositive.validationAttempts[1]!.result.assertionExtraction.assertions = [];
    expect(() => assertFullEvidence(noPositive, false)).toThrow(
      /positive assertion must be passed/,
    );

    const noFreshness = state(false);
    noFreshness.proofGraph.claims[0]!.freshness = undefined as never;
    expect(() => assertFullEvidence(noFreshness, false)).toThrow(
      /bound to the current implementation/,
    );

    const wrongDigest = state(false);
    wrongDigest.proofGraph.claims[0]!.freshness.boundDigest = 'other-digest';
    expect(() => assertFullEvidence(wrongDigest, false)).toThrow(
      /bound to the current implementation/,
    );

    const unboundAttempt = state(false);
    unboundAttempt.proofGraph.claims[0]!.evidenceRefs = [];
    expect(() => assertFullEvidence(unboundAttempt, false)).toThrow(
      /positive evidence does not reference/,
    );

    const swappedRoles = state(false);
    swappedRoles.proofGraph.claims[0]!.evidenceRefs = [
      { kind: 'validation_attempt', attemptId: 'build-attempt' },
    ];
    swappedRoles.proofGraph.claims[0]!.counterexampleRefs = [
      { kind: 'validation_attempt', attemptId: 'test-attempt' },
    ];
    expect(() => assertFullEvidence(swappedRoles, false)).toThrow(
      /positive evidence does not reference/,
    );

    const crossReferenced = state(false);
    crossReferenced.proofGraph.claims[0]!.evidenceRefs = [
      { kind: 'validation_attempt', attemptId: 'test-attempt' },
      { kind: 'validation_attempt', attemptId: 'build-attempt' },
    ];
    expect(() => assertFullEvidence(crossReferenced, false)).toThrow(/roles are not independent/);
  });

  it('binds the installed build to the checkout when built from source', () => {
    expect(assertInstalledBuildIdentity({ gitSha: 'abc' }, 'abc', true).gitSha).toBe('abc');
    expect(() => assertInstalledBuildIdentity({ gitSha: 'old' }, 'abc', true)).toThrow(
      /!= checkout abc/,
    );
    // A provided tarball is checked by its checksum, not by the checkout identity.
    expect(assertInstalledBuildIdentity({ gitSha: 'old' }, 'abc', false).gitSha).toBe('old');
  });

  describe('assertNoCompletionPackage', () => {
    let root: string;

    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    it('fails when a denied approval left a package or completion evidence', async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-denied-package-'));
      const sessionDir = path.join(root, 'sessions', 'ses_x');
      await fs.mkdir(path.join(root, 'sessions', 'archive'), { recursive: true });
      await fs.mkdir(sessionDir, { recursive: true });
      const runner: {
        requireBoundState: () => {
          state: { exportCompletionEvidence: unknown };
          sessionDir: string;
        };
      } = {
        requireBoundState: () => ({ state: { exportCompletionEvidence: null }, sessionDir }),
      };
      const session = { sessionId: 'ses_x' };
      expect(assertNoCompletionPackage(runner, session).produced).toEqual([]);

      await fs.writeFile(path.join(root, 'sessions', 'archive', 'export-ses_x.tar.gz'), 'package');
      expect(() => assertNoCompletionPackage(runner, session)).toThrow(
        /produced completion package/,
      );
      await fs.rm(path.join(root, 'sessions', 'archive', 'export-ses_x.tar.gz'));

      runner.requireBoundState = () => ({
        state: { exportCompletionEvidence: { packageDigest: 'x' } },
        sessionDir,
      });
      expect(() => assertNoCompletionPackage(runner, session)).toThrow(
        /persisted export completion evidence/,
      );
    });
  });
});
