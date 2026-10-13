/**
 * @module documentation/demo-control-oracles.test
 * @description F4/F5: the shared control oracle must verify the positive AND
 * adversarial assertion, distinct attempts, role-specific evidence binding,
 * freshness, and the real absence of completion packages.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNoCompletionPackage,
  assertProofEvidence,
} from '../../../demos/lib/control-oracles.mjs';

const CLAIM_ID = '11111111-1111-4111-8111-111111111111';
const TEST_ATTEMPT = '22222222-2222-4222-8222-222222222222';
const BUILD_ATTEMPT = '33333333-3333-4333-8333-333333333333';
const POSITIVE = { providerId: 'junit', localId: 'example.PositiveTest#documentsInvariant' };
const ADVERSARIAL = { providerId: 'junit', localId: 'example.ProbeTest#noRelaxation' };

function attempt(attemptId: string, checkId: string, locals: Record<string, string>) {
  return {
    attemptId,
    scope: 'implementation',
    result: {
      checkId,
      passed: true,
      exitCode: 0,
      assertionExtraction: {
        assertions: Object.entries(locals).map(([localId, status]) => ({
          assertion: { providerId: 'junit', localId },
          status,
        })),
      },
    },
  };
}

function state(
  overrides: Record<string, unknown> = {},
  mutate?: (value: Record<string, unknown>) => void,
) {
  const value: Record<string, unknown> = {
    phase: 'EVIDENCE_REVIEW',
    plan: {
      current: { digest: 'plan-digest' },
      approvalCertificate: { certificateId: 'cert-1' },
    },
    implementation: { digest: 'impl-digest' },
    proofContract: {
      claims: [
        {
          claimId: CLAIM_ID,
          signalClass: 'fact',
          critical: true,
          provenance: {
            kind: 'canonical_authority',
            authorityId: 'plan',
            digest: 'plan-digest',
            approval: { certificateId: 'cert-1', declarationId: CLAIM_ID },
          },
        },
      ],
    },
    proofGraph: {
      claims: [
        {
          claimId: CLAIM_ID,
          verificationState: 'PROVEN',
          freshness: { stale: false, boundDigest: 'impl-digest' },
          evidenceRefs: [{ kind: 'validation_attempt', attemptId: TEST_ATTEMPT }],
          counterexampleRefs: [{ kind: 'validation_attempt', attemptId: BUILD_ATTEMPT }],
        },
      ],
    },
    validationAttempts: [
      attempt(BUILD_ATTEMPT, 'build', { [ADVERSARIAL.localId]: 'passed' }),
      attempt(TEST_ATTEMPT, 'test', {
        [POSITIVE.localId]: 'passed',
        [ADVERSARIAL.localId]: 'skipped',
      }),
    ],
    ...overrides,
  };
  if (mutate) mutate(value);
  return value;
}

const oracle = {
  claimId: CLAIM_ID,
  positiveAssertion: POSITIVE,
  adversarialAssertion: ADVERSARIAL,
};

describe('demo control oracles', () => {
  describe('HAPPY — full evidence contract', () => {
    it('accepts a fresh PROVEN fact with both bound assertions', () => {
      const result = assertProofEvidence(state(), { ...oracle, mode: 'positive' });
      expect(result).toEqual({
        claimId: CLAIM_ID,
        buildAttemptId: BUILD_ATTEMPT,
        testAttemptId: TEST_ATTEMPT,
      });
    });

    it('accepts a genuinely skipped adversarial assertion in negative mode', () => {
      const negative = state({}, (value) => {
        const projection = (value.proofGraph as { claims: { verificationState: string }[] })
          .claims[0]!;
        projection.verificationState = 'NOT_VERIFIED';
        const attempts = value.validationAttempts as ReturnType<typeof attempt>[];
        const build = attempts.find((item) => item.attemptId === BUILD_ATTEMPT)!;
        const extraction = build.result.assertionExtraction as {
          assertions: { assertion: { localId: string }; status: string }[];
        };
        const adversarial = extraction.assertions.find(
          (item) => item.assertion.localId === ADVERSARIAL.localId,
        )!;
        adversarial.status = 'skipped';
      });
      const result = assertProofEvidence(negative, { ...oracle, mode: 'negative' });
      expect(result.testAttemptId).toBe(TEST_ATTEMPT);
    });
  });

  describe('BAD — the F5 oracle gaps must fail closed', () => {
    it('rejects a flow whose positive assertion did not pass', () => {
      const broken = state({}, (value) => {
        const attempts = value.validationAttempts as ReturnType<typeof attempt>[];
        const test = attempts.find((item) => item.attemptId === TEST_ATTEMPT)!;
        const extraction = test.result.assertionExtraction as {
          assertions: { assertion: { localId: string }; status: string }[];
        };
        const positive = extraction.assertions.find(
          (item) => item.assertion.localId === POSITIVE.localId,
        )!;
        positive.status = 'failed';
      });
      expect(() => assertProofEvidence(broken, { ...oracle, mode: 'positive' })).toThrow(
        /positive assertion/i,
      );
    });

    it('rejects role bindings that cross-reference the checked attempts', () => {
      const broken = state({}, (value) => {
        const projection = (
          value.proofGraph as {
            claims: { evidenceRefs: unknown[]; counterexampleRefs: unknown[] }[];
          }
        ).claims[0]!;
        projection.evidenceRefs = [{ kind: 'validation_attempt', attemptId: BUILD_ATTEMPT }];
      });
      expect(() => assertProofEvidence(broken, { ...oracle, mode: 'positive' })).toThrow(
        /positive evidence/i,
      );
    });

    it('rejects shared attempts for positive and adversarial evidence', () => {
      const broken = state({}, (value) => {
        const attempts = value.validationAttempts as ReturnType<typeof attempt>[];
        attempts[0]!.attemptId = TEST_ATTEMPT;
      });
      expect(() => assertProofEvidence(broken, { ...oracle, mode: 'positive' })).toThrow(
        /distinct attempts/i,
      );
    });
  });

  describe('CORNER — negative mode requires an honest skip', () => {
    it('rejects negative mode when the adversarial assertion actually passed', () => {
      const broken = state({}, (value) => {
        const projection = (value.proofGraph as { claims: { verificationState: string }[] })
          .claims[0]!;
        projection.verificationState = 'NOT_VERIFIED';
        const attempts = value.validationAttempts as ReturnType<typeof attempt>[];
        const build = attempts.find((item) => item.attemptId === BUILD_ATTEMPT)!;
        const extraction = build.result.assertionExtraction as {
          assertions: { assertion: { localId: string }; status: string }[];
        };
        extraction.assertions[0]!.status = 'passed';
      });
      expect(() => assertProofEvidence(broken, { ...oracle, mode: 'negative' })).toThrow(
        /skipped/i,
      );
    });
  });

  describe('EDGE — freshness and real package absence', () => {
    it('rejects a stale projection binding', () => {
      const broken = state({}, (value) => {
        const projection = (
          value.proofGraph as { claims: { freshness: { stale: boolean } }[] }
        ).claims[0]!;
        projection.freshness.stale = true;
      });
      expect(() => assertProofEvidence(broken, { ...oracle, mode: 'positive' })).toThrow(/fresh/i);
    });

    it('proves completion-package absence on the real archive directory', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowguard-control-oracle-'));
      const sessionDir = path.join(root, 'sessions', 'ses_x');
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.mkdirSync(path.join(root, 'sessions', 'archive'), { recursive: true });
      const runner: {
        requireBoundState: () => {
          sessionDir: string;
          state: { exportCompletionEvidence: unknown };
        };
      } = {
        requireBoundState: () => ({
          sessionDir,
          state: { exportCompletionEvidence: null },
        }),
      };
      const session = { sessionId: 'ses_x' };
      expect(assertNoCompletionPackage(runner, session).produced).toEqual([]);

      fs.writeFileSync(
        path.join(root, 'sessions', 'archive', `export-${session.sessionId}.tar.gz`),
        'package',
      );
      expect(() => assertNoCompletionPackage(runner, session)).toThrow(/completion package/);

      fs.rmSync(path.join(root, 'sessions', 'archive', `export-${session.sessionId}.tar.gz`));
      runner.requireBoundState = () => ({
        sessionDir,
        state: { exportCompletionEvidence: { packageDigest: 'x' } },
      });
      expect(() => assertNoCompletionPackage(runner, session)).toThrow(
        /persisted export completion evidence/,
      );
    });
  });
});
