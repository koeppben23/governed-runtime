/**
 * @module integration/integrity-incident-e2e.test
 * @description D7 (#1028) end-to-end chain: an actual reviewer-evidence replay
 * goes through `recordEvidenceOrBlockReuse()`, the blocked integrity incident is
 * persisted and re-read from disk, and the reloaded state is evaluated by the
 * ceremony and approval gates.
 *
 * This complements the state-fixture unit tests: it proves the real reuse
 * rejection reaches persisted state and that the persisted incident (not a
 * pre-set fixture) withholds reduced ceremony and the approval waiver.
 *
 * @test-policy HAPPY, BAD
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readState, writeState } from '../adapters/persistence.js';
import {
  IMPL_EVIDENCE,
  makeState,
  POLICY_SNAPSHOT,
  VALIDATION_PASSED,
  VERIFICATION_CANDIDATES,
} from '../fixtures.js';
import { reducedCeremonyReady } from '../machine/guards.js';
import type { ReviewObligationType } from '../state/evidence.js';
import type { SessionState } from '../state/schema.js';
import { ensureReviewAssurance } from '../state/review-dispatch.js';
import { TEST_EXECUTION_OBSERVATION } from '../state/evidence-test-constants.js';
import {
  enforceImplementationReviewSubject,
  type ReviewDecisionInput,
} from '../rails/review-decision-gates.js';
import { resolveCeremonyProfile } from './phase-tool-gate.js';
import { recordEvidenceOrBlockReuse } from './review/evidence/reviewer-evidence-recorder.js';
import { persistAuthorizedReviewDispatch } from './review/dispatch/durable-dispatch.js';
import {
  appendObligationWithAttempt,
  artifactReviewSubjectScope,
  consumeReviewObligation,
  createReviewObligation,
  freezeReviewMaterial,
} from './review/obligations/assurance.js';
import { hashFindings } from './review/findings-hash.js';

const NOW = '2026-05-10T12:00:00.000Z';
const PARENT = 'integrity-e2e-parent-session';
const CHILD = 'integrity-e2e-child-session';
const PROMPT_DIGEST = 'b'.repeat(64);

const DOC_IMPL = {
  ...IMPL_EVIDENCE,
  changedFiles: ['docs/usage-notes.md'],
  domainFiles: [],
};

const TEST_ATTEMPT_ID = '00000000-0000-4000-8000-0000000000f1';
const LINT_ATTEMPT_ID = '00000000-0000-4000-8000-0000000000f2';

function baseFindings(overallVerdict: 'accept' | 'unable_to_review') {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    reviewedBy: { sessionId: CHILD },
    reviewedAt: NOW,
  };
}

const SEED_FINDINGS = baseFindings('accept');
const REPLAY_FINDINGS = baseFindings('accept');

const APPROVAL_INPUT: ReviewDecisionInput = {
  verdict: 'approve',
  rationale: 'ship it',
  decisionIdentity: {
    actorId: 'approver',
    actorEmail: null,
    actorSource: 'unknown',
    actorAssurance: 'best_effort',
  },
  subjectAttestation: { kind: 'ok', digest: DOC_IMPL.digest },
};

function validationAttempt(checkId: string) {
  const base = VALIDATION_PASSED[checkId === 'test' ? 0 : 1]!;
  return {
    attemptId: checkId === 'test' ? TEST_ATTEMPT_ID : LINT_ATTEMPT_ID,
    scope: 'implementation' as const,
    implementationId: DOC_IMPL.implementationId,
    implementationDigest: DOC_IMPL.digest,
    executionObservation: TEST_EXECUTION_OBSERVATION,
    result: { ...base, checkId, passed: true } as (typeof VALIDATION_PASSED)[number],
  };
}

/** Reduced-ceremony-ready state (otherwise valid waiver) with seeded assurance. */
function reducedReadyState(reviewAssurance: SessionState['reviewAssurance']): SessionState {
  const policySnapshot = {
    ...POLICY_SNAPSHOT,
    allowReducedCeremony: true,
    requireHumanGates: true,
    effectiveGateBehavior: 'human_gated' as const,
  };
  return makeState('EVIDENCE_REVIEW', {
    claimedTaskClass: 'TRIVIAL',
    verificationCandidates: VERIFICATION_CANDIDATES,
    implementation: DOC_IMPL,
    implementationRiskAssessment: {
      computedMinimumTaskClass: 'TRIVIAL',
      effectiveTaskClass: 'TRIVIAL',
      declaredTaskClass: null,
      declarationKind: 'absent' as const,
      ticketDigest: null,
      escalatedTaskClass: 'TRIVIAL',
      touchedSurfaces: ['docs/usage-notes.md'],
      riskTriggers: [],
      assessedFrom: 'implementation_changed_files',
      assessedFileCount: 1,
      implementationDigest: DOC_IMPL.digest,
    },
    activeChecks: ['test', 'lint'],
    implValidation: VALIDATION_PASSED,
    validationAttempts: [validationAttempt('test'), validationAttempt('lint')],
    policySnapshot,
    reducedCeremony: {
      profile: 'reduced',
      reason: 'POST_IMPL_VERIFIED_TRIVIAL',
      effectiveTaskClass: 'TRIVIAL',
      declaredTaskClass: null,
      declarationKind: 'absent' as const,
      ticketDigest: null,
      escalatedTaskClass: 'TRIVIAL',
      computedMinimumTaskClass: 'TRIVIAL',
      touchedSurfaces: ['docs/usage-notes.md'],
      implementationId: DOC_IMPL.implementationId,
      implementationDigest: DOC_IMPL.digest,
      policyDigest: policySnapshot.hash,
      verificationBasis: {
        checkIds: ['test', 'lint'],
        attempts: [
          {
            checkId: 'test',
            attemptId: TEST_ATTEMPT_ID,
            executedAt: VALIDATION_PASSED[0]!.executedAt,
          },
          {
            checkId: 'lint',
            attemptId: LINT_ATTEMPT_ID,
            executedAt: VALIDATION_PASSED[1]!.executedAt,
          },
        ],
      },
      decidedAt: '2026-01-02T00:00:00.000Z',
    },
    reviewAssurance,
  });
}

function buildObligation(
  obligationType: 'plan' | 'review',
  subjectDigest: string,
  reviewCycle: number | null,
) {
  const obligation = createReviewObligation({
    obligationType,
    reviewCycle,
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest,
    reviewMaterial: freezeReviewMaterial(`frozen ${obligationType} material`, subjectDigest),
    reviewSubjectScope: artifactReviewSubjectScope('plan', '# Plan\nBody', subjectDigest),
    ...(obligationType === 'plan'
      ? {
          repositoryEvidenceFreeze: {
            kind: 'unavailable' as const,
            reason: 'repository_unavailable',
          },
        }
      : {}),
  });
  const minted = appendObligationWithAttempt(ensureReviewAssurance(undefined), obligation, NOW);
  return { obligation, attemptId: minted.attemptId, assurance: minted.assurance };
}

function recordingParams(
  obligation: { obligationId: string; obligationType: ReviewObligationType },
  attemptId: string,
  findings: ReturnType<typeof baseFindings>,
) {
  return {
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    sessionId: PARENT,
    childSessionId: CHILD,
    hostCallId: CHILD,
    attemptId,
    promptHash: PROMPT_DIGEST,
    findingsHash: hashFindings(findings),
    invokedAt: NOW,
    fulfilledAt: NOW,
    reviewerResult: {
      sessionId: CHILD,
      reviewOutputMode: 'structured_output',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'structured_high',
      findings,
    },
  };
}

describe('integrity incident chain (recordEvidenceOrBlockReuse → persisted state → gates)', () => {
  it('BAD: a real evidence replay blocks the persisted obligation and withholds ceremony and approval', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'fg-integrity-e2e-'));
    const persistingDeps = {
      updateReviewAssurance: async (
        dir: string,
        update: (state: SessionState, now: string) => SessionState,
      ) => {
        const current = await readState(dir);
        if (current === null) throw new Error(`no persisted state at ${dir}`);
        await writeState(dir, update(current, new Date().toISOString()));
      },
    };

    try {
      const seed = buildObligation('plan', 'subject-digest-seed', 1);
      await writeState(sessionDir, reducedReadyState(seed.assurance));

      // 1. A real, authorized reviewer run binds fresh evidence; the verdict is
      //    then consumed through the canonical settlement mutator.
      await persistAuthorizedReviewDispatch(persistingDeps, sessionDir, {
        attemptId: seed.attemptId,
        obligationId: seed.obligation.obligationId,
        hostCallId: CHILD,
        canonicalPromptDigest: PROMPT_DIGEST,
        authorizedAt: NOW,
      });
      const seedResult = await recordEvidenceOrBlockReuse(
        persistingDeps as never,
        sessionDir,
        recordingParams(seed.obligation, seed.attemptId, SEED_FINDINGS) as never,
      );
      expect(seedResult).toBe('fulfilled');
      await persistingDeps.updateReviewAssurance(sessionDir, (state) => ({
        ...state,
        reviewAssurance: consumeReviewObligation(
          ensureReviewAssurance(state.reviewAssurance),
          state.reviewAssurance?.obligations.find(
            (obligation) => obligation.obligationId === seed.obligation.obligationId,
          ) ?? null,
          new Date().toISOString(),
        ),
      }));

      const before = await readState(sessionDir);
      expect(before).not.toBeNull();
      // Baseline: no open work and no incident → both authorization paths open.
      expect(reducedCeremonyReady(before!)).toBe(true);
      expect(
        resolveCeremonyProfile({ state: before!, changedFiles: ['docs/usage-notes.md'] }).profile,
      ).toBe('reduced');
      expect(enforceImplementationReviewSubject(before!, APPROVAL_INPUT)).toBeNull();

      // 2. A new obligation is minted; the reviewer replays the consumed child
      //    session / evidence instead of producing a fresh invocation.
      const target = buildObligation('plan', 'subject-digest-target', 1);
      await persistingDeps.updateReviewAssurance(sessionDir, (state) => ({
        ...state,
        reviewAssurance: appendObligationWithAttempt(
          ensureReviewAssurance(state.reviewAssurance),
          target.obligation,
          new Date().toISOString(),
        ).assurance,
      }));

      const replayResult = await recordEvidenceOrBlockReuse(
        persistingDeps as never,
        sessionDir,
        recordingParams(target.obligation, target.attemptId, REPLAY_FINDINGS) as never,
      );
      expect(replayResult).toBe('reused');

      // 3. Reload from disk: the incident is persisted and withholds both paths.
      const after = await readState(sessionDir);
      expect(after).not.toBeNull();
      const persisted = after!.reviewAssurance!.obligations.find(
        (obligation) => obligation.obligationId === target.obligation.obligationId,
      );
      expect(persisted).toMatchObject({
        status: 'blocked',
        blockedCode: 'SUBAGENT_EVIDENCE_REUSED',
      });

      expect(reducedCeremonyReady(after!)).toBe(false);
      expect(
        resolveCeremonyProfile({ state: after!, changedFiles: ['docs/usage-notes.md'] }),
      ).toMatchObject({ profile: 'full', reason: 'REVIEW_INTEGRITY_INCIDENT' });
      expect(enforceImplementationReviewSubject(after!, APPROVAL_INPUT)).toMatchObject({
        code: 'IMPLEMENTATION_REVIEW_EVIDENCE_REQUIRED',
      });
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
