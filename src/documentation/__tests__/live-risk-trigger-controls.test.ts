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
  CLAIM_STATEMENT,
  POSITIVE_ASSERTION,
  assertFullEvidence,
  assertInstalledBuildIdentity,
  assertNoCompletionPackage,
  assertRetainedClaim,
  assertStateIntegrityTrigger,
  assertImplementationRecorded,
  claimDeclaration,
  driveImplementation,
  MAX_IMPLEMENT_RECORD_RESUMES,
  needsImplementationResume,
} from '../../../demos/risk-trigger-fixture/run-live-risk-trigger-controls.mjs';
import {
  captureFailureProvenance,
  finalizeControlRecord,
} from '../../../demos/java-task-manager/run-live-matrix.mjs';
import { DemoNotVerifiedError, RESULT } from '../../../demos/lib/results.mjs';

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

  it('keeps both control cases on identical executable checks, differing only by coverage', () => {
    const uncovered = claimDeclaration(false);
    const covered = claimDeclaration(true);
    const { coversRiskTriggers, ...rest } = covered;

    expect(coversRiskTriggers).toEqual(['state_integrity']);
    expect(rest).toEqual(uncovered);
    expect(uncovered).not.toHaveProperty('coversRiskTriggers');
  });

  it('binds the retained claim to rejection-observing assertion identities', () => {
    expect(claimDeclaration(false).statement).toBe(CLAIM_STATEMENT);
    expect(CLAIM_STATEMENT).toBe(
      'ModuleStateStore.write rejects writes with missing or blank ownership values (null, empty, or whitespace-only).',
    );
    expect(CLAIM_STATEMENT.toLowerCase()).not.toContain('document');
    expect(CLAIM_STATEMENT.toLowerCase()).not.toContain('invariant sentence');
    expect(POSITIVE_ASSERTION).toBe('fixture.StateNoteTest#rejectsMissingOwnership');
    expect(ADVERSARIAL_ASSERTION).toBe(
      'fixture.StateNoteFalsificationProbeTest#rejectsMissingOrBlankOwnership',
    );
    expect(POSITIVE_ASSERTION).not.toBe(ADVERSARIAL_ASSERTION);
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

  describe('failure-path provenance contract', () => {
    function capturingRunner() {
      return {
        requireBoundState: () => ({
          state: { phase: 'PLAN_REVIEW', flowguardSessionId: 'fg-session-1' },
        }),
        captureProvenance: async (target: Record<string, unknown>) => {
          target.transcripts = { parent: { file: 'parent.json' }, reviewers: [] };
        },
      };
    }

    it('a failed or not-verified run stays classified when the provenance export succeeds', async () => {
      for (const result of [RESULT.FAILED, RESULT.NOT_VERIFIED]) {
        const record: Record<string, unknown> = { name: 'risk-case', result };
        await captureFailureProvenance(
          record,
          { sessionId: 'ses_risk_03', workspace: '/tmp/risk' },
          capturingRunner(),
        );
        expect(record.result).toBe(result);
        expect(record.transcripts).toBeDefined();
        expect(record.phase).toBe('PLAN_REVIEW');
        expect(record.flowguardSessionId).toBe('fg-session-1');
      }
    });

    it('a failed export keeps the classification and records the capture error', async () => {
      const record: Record<string, unknown> = { name: 'risk-case', result: RESULT.NOT_VERIFIED };
      await captureFailureProvenance(
        record,
        { sessionId: 'ses_risk_04', workspace: '/tmp/risk' },
        {
          requireBoundState: () => {
            throw new Error('no persisted state');
          },
          captureProvenance: async () => {},
        },
      );
      expect(record.result).toBe(RESULT.NOT_VERIFIED);
      expect(String(record.transcriptCaptureError)).toContain('no persisted state');
    });
  });

  describe('PASS contract', () => {
    it('HAPPY: a record turns PASS only after captureProvenance succeeded', async () => {
      const record: Record<string, unknown> = {
        name: 'risk-case',
        result: 'FAILED',
        phase: 'EVIDENCE_REVIEW',
      };
      const session = { sessionId: 'ses_risk_01', workspace: '/tmp/risk' };
      const order: string[] = [];
      const runner = {
        captureProvenance: async (target: Record<string, unknown>) => {
          expect(target.result).toBe('FAILED');
          order.push('capture');
        },
      };
      await finalizeControlRecord(record, session, runner, { verificationState: 'PROVEN' });
      expect(order).toEqual(['capture']);
      expect(record.result).toBe(RESULT.CONTROL_PASSED);
      expect(record.verificationState).toBe('PROVEN');
    });

    it('BAD/EDGE: injected capture failure and payload PASS both stay FAILED', async () => {
      const session = { sessionId: 'ses_risk_02', workspace: '/tmp/risk' };
      const record: Record<string, unknown> = { name: 'risk-case-fault', result: 'FAILED' };
      const runner = {
        captureProvenance: async () => {
          throw new Error('parent transcript export failed for ses_risk_02 (exit=2)');
        },
      };
      await expect(
        finalizeControlRecord(record, session, runner, { result: 'PASS' }),
      ).rejects.toThrow('parent transcript export failed');
      record.result = 'FAILED';
      record.error = 'Error: parent transcript export failed for ses_risk_02 (exit=2)';
      const passed = [record].filter((entry) => entry.result === RESULT.CONTROL_PASSED).length;
      expect(passed).toBe(0);
      expect(record.error).toContain('parent transcript export failed');
    });
  });
});

/**
 * Fake runner over a scripted sequence of persisted states: each turn advances
 * to the next state. Records the turn labels and the IMPL_REVIEW resume call.
 */
function scriptedRunner(states: Array<Record<string, unknown>>) {
  let index = 0;
  const turns: string[] = [];
  const reviewResumes: string[] = [];
  return {
    turns,
    reviewResumes,
    async turn(_session: unknown, label: string) {
      turns.push(label);
      index = Math.min(index + 1, states.length - 1);
    },
    requireBoundState() {
      return { state: states[index] };
    },
    async completeImplementationReview(_session: unknown, label: string) {
      reviewResumes.push(label);
    },
  };
}

const IMPLEMENTED = {
  phase: 'EVIDENCE_REVIEW',
  implementation: { digest: 'd'.repeat(64) },
  implementationRiskAssessment: { riskTriggers: ['state_integrity'] },
};
const NOT_IMPLEMENTED = { phase: 'IMPLEMENTATION', implementation: null };

describe('risk-trigger implementation turn classification', () => {
  it('HAPPY: a recorded implementation proceeds to the shared IMPL_REVIEW resume', async () => {
    const runner = scriptedRunner([{ phase: 'PLAN_REVIEW' }, IMPLEMENTED]);
    await driveImplementation(runner, {}, 'risk-covered');
    expect(runner.turns).toEqual(['risk-covered-05-implement']);
    expect(runner.reviewResumes).toEqual(['risk-covered-05-implement']);
  });

  it('CORNER: an implement turn without a recorded implementation is re-entered once', async () => {
    const runner = scriptedRunner([{ phase: 'PLAN_REVIEW' }, NOT_IMPLEMENTED, IMPLEMENTED]);
    await driveImplementation(runner, {}, 'risk-uncovered');
    expect(MAX_IMPLEMENT_RECORD_RESUMES).toBe(1);
    expect(runner.turns).toEqual([
      'risk-uncovered-05-implement',
      'risk-uncovered-05-implement-resume-1',
    ]);
    expect(runner.reviewResumes).toEqual(['risk-uncovered-05-implement-resume-1']);
  });

  it('BAD: no recorded implementation after the bounded re-entry is NOT_VERIFIED, never FAILED', async () => {
    const runner = scriptedRunner([{ phase: 'PLAN_REVIEW' }, NOT_IMPLEMENTED, NOT_IMPLEMENTED]);
    const outcome = driveImplementation(runner, {}, 'risk-uncovered');
    await expect(outcome).rejects.toBeInstanceOf(DemoNotVerifiedError);
    await expect(outcome).rejects.toThrow(
      /no implementation was recorded \(phase IMPLEMENTATION\)/,
    );
    expect(runner.turns).toHaveLength(1 + MAX_IMPLEMENT_RECORD_RESUMES);
    expect(runner.reviewResumes).toEqual([]);
  });

  it('EDGE: only an unrecorded IMPLEMENTATION phase is resumable; a misclassified trigger stays FAILED', () => {
    expect(needsImplementationResume(NOT_IMPLEMENTED)).toBe(true);
    expect(needsImplementationResume(IMPLEMENTED)).toBe(false);
    expect(needsImplementationResume({ phase: 'IMPL_VALIDATION', implementation: null })).toBe(
      false,
    );
    expect(assertImplementationRecorded(IMPLEMENTED, 'x')).toEqual(IMPLEMENTED.implementation);
    expect(() => assertImplementationRecorded(NOT_IMPLEMENTED, 'x')).toThrow(DemoNotVerifiedError);
    // A recorded change whose trigger is missing is a product/oracle contradiction.
    const misclassified = { ...IMPLEMENTED, implementationRiskAssessment: { riskTriggers: [] } };
    expect(() => assertStateIntegrityTrigger(misclassified)).toThrow(/not detected/);
    expect(() => assertStateIntegrityTrigger(misclassified)).not.toThrow(DemoNotVerifiedError);
  });
});
