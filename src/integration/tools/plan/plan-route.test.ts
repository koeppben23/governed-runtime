/**
 * Seven settlement assertion purposes ported to the live plan/ADR continuation
 * routes. Real persistence, no generic settlement executor or reviewer callback.
 * This is component evidence, not installed-host or reviewer-integrity proof.
 */
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readState, statePath, writeState } from '../../../adapters/persistence.js';
import { sessionDir } from '../../../adapters/workspace/index.js';
import {
  ARCHITECTURE_DECISION,
  FIXED_TIME,
  PLAN_RECORD,
  POLICY_SNAPSHOT,
  SELF_REVIEW_PENDING,
  TICKET,
  assuranceWith,
  makeState,
} from '../../../fixtures.js';
import { buildInvocationFixture } from '../../../review-invocation-test-helpers.js';
import { hashText } from '../../../shared/hashing.js';
import type {
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewObligation,
} from '../../../state/evidence.js';
import { completedDispatchForInvocation } from '../../../state/evidence-test-constants.js';
import { resolveReviewContinuation } from '../../../state/review-continuation.js';
import { ensureReviewAssurance } from '../../../state/review-dispatch.js';
import type { SessionState } from '../../../state/schema.js';
import {
  artifactReviewSubjectScope,
  createReviewObligation,
  freezeReviewMaterial,
} from '../../review/obligations/assurance.js';
import {
  createReviewAttempt,
  updateAttemptStatus,
} from '../../review/obligations/attempt-lifecycle.js';
import { hashFindings } from '../../review/findings-hash.js';
import { buildIncoherentCaptureRearm } from '../../review/obligations/incoherent-capture-rearm.js';
import {
  canonicalBinding,
  createTestWorkspace,
  createToolContext,
  type TestWorkspace,
} from '../../test-helpers.js';
import { routeArchitectureInitialSubmission } from '../architecture/architecture-restart.js';
import { withMutableSession, writeStateWithArtifacts } from '../helpers.js';
import { routePlanInitialSubmission } from './plan-route.js';
import { planInputFlags } from './plan-types.js';

type Family = 'plan' | 'architecture';
const LATER = '2026-01-01T00:01:00.000Z';

function obligationFor(family: Family): ReviewObligation {
  const artifact = family === 'plan' ? PLAN_RECORD.current.body : ARCHITECTURE_DECISION.adrText;
  const digest = hashText(artifact);
  return createReviewObligation({
    obligationType: family,
    reviewCycle: 1,
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
    iteration: 0,
    planVersion: 1,
    now: FIXED_TIME,
    subjectDigest: digest,
    reviewMaterial: freezeReviewMaterial(artifact, digest),
    reviewSubjectScope: artifactReviewSubjectScope(
      family === 'plan' ? 'plan' : 'adr',
      artifact,
      digest,
    ),
    changedFiles: ['src/a.ts'],
    policySnapshot: POLICY_SNAPSHOT,
  });
}

function attemptFor(
  obligation: ReviewObligation,
  ordinal: number,
  rejected = false,
  rejectionReason?: ReviewAttempt['rejectionReason'],
): ReviewAttempt {
  const attempt = createReviewAttempt({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest,
    ordinal,
    origin: { kind: 'initial' },
    repositoryDiscovery: { kind: 'not_applicable' },
    observationCapability: null,
    now: FIXED_TIME,
  });
  if (!rejected) return attempt;
  const updated = updateAttemptStatus(
    assuranceWith({ obligation, attempts: [attempt] }),
    attempt.attemptId,
    'rejected',
    LATER,
    rejectionReason ? { rejectionReason } : undefined,
  );
  const result = updated.attempts.find((item) => item.attemptId === attempt.attemptId);
  if (!result) throw new Error('The fixture attempt must survive rejection.');
  return result;
}

function fulfilledFor(
  obligation: ReviewObligation,
  parentSessionId: string,
  findings: Record<string, unknown> = { overallVerdict: 'accept' },
) {
  const bound: ReviewAttempt = {
    ...attemptFor(obligation, 1),
    status: 'bound',
    childSessionId: 'ses_child',
    completedAt: LATER,
  };
  const invocation = buildInvocationFixture({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    mandateDigest: obligation.mandateDigest,
    criteriaVersion: obligation.criteriaVersion,
    parentSessionId,
    childSessionId: bound.childSessionId!,
    promptHash: hashText('fixture frozen prompt'),
    findingsHash: hashFindings(findings),
    invokedAt: FIXED_TIME,
    fulfilledAt: LATER,
    attemptId: bound.attemptId,
    capturedRawFindings: findings,
  });
  const fulfilled: ReviewObligation = {
    ...obligation,
    status: 'fulfilled',
    fulfilledAt: LATER,
    invocationId: invocation.invocationId,
  };
  const assurance = assuranceWith({
    obligation: fulfilled,
    attempts: [bound],
    invocations: [invocation],
    dispatches: [completedDispatchForInvocation(invocation)],
  });
  return { fulfilled, bound, invocation, assurance };
}

describe.each<Family>(['plan', 'architecture'])(
  '%s live continuation settlement port',
  (family) => {
    let workspace: TestWorkspace;
    let state: SessionState;
    let obligation: ReviewObligation;

    beforeEach(async () => {
      workspace = await createTestWorkspace();
      const binding = await canonicalBinding(workspace.tmpDir);
      obligation = obligationFor(family);
      state = makeState(family === 'plan' ? 'PLAN' : 'ARCHITECTURE', {
        binding,
        ticket: TICKET,
        ...(family === 'plan'
          ? { plan: PLAN_RECORD }
          : { architecture: { ...ARCHITECTURE_DECISION, digest: obligation.subjectDigest } }),
        selfReview: { ...SELF_REVIEW_PENDING, iteration: 0, currDigest: obligation.subjectDigest },
      });
    });

    afterEach(async () => workspace.cleanup());

    async function route(
      item: ReviewObligation,
      attempts: ReviewAttempt[],
      evidence: Pick<ReviewAssuranceState, 'invocations' | 'dispatches'> = {
        invocations: [],
        dispatches: [],
      },
    ) {
      const seeded = {
        ...state,
        reviewAssurance: assuranceWith({
          obligation: item,
          attempts,
          invocations: evidence.invocations,
          dispatches: evidence.dispatches,
        }),
      };
      const context = createToolContext({
        worktree: workspace.tmpDir,
        directory: workspace.tmpDir,
        sessionID: seeded.binding.hostSessionId,
      });
      const dir = sessionDir(seeded.binding.fingerprint, context.sessionID);
      await writeStateWithArtifacts(dir, seeded);
      const before = await readFile(statePath(dir), 'utf8');
      const session = await withMutableSession(context);
      const inputSnapshot = structuredClone(session.state);
      const response =
        family === 'plan'
          ? await routePlanInitialSubmission({
              ...session,
              args: { planText: PLAN_RECORD.current.body },
              context,
              input: planInputFlags({ planText: PLAN_RECORD.current.body }),
              maxPlanReviewIterations: 3,
            })
          : await routeArchitectureInitialSubmission(
              { title: ARCHITECTURE_DECISION.title, adrText: ARCHITECTURE_DECISION.adrText },
              session,
            );
      // Routing must never mutate the caller's snapshot in place.
      expect(session.state).toEqual(inputSnapshot);
      const after = await readState(dir);
      if (!after) throw new Error('The persisted session must survive routing.');
      const assurance = ensureReviewAssurance(after.reviewAssurance);
      expect(assurance.obligations).toHaveLength(1);
      // Closure may block an obligation, but never mints, repairs or erases attempts/evidence.
      expect(assurance.attempts).toEqual(attempts);
      expect(assurance.invocations).toEqual(evidence.invocations);
      expect(assurance.dispatches).toEqual(evidence.dispatches);
      expect(after.phase).toBe(seeded.phase);
      return {
        response: response === null ? null : JSON.parse(response),
        after,
        assurance,
        obligation: assurance.obligations[0]!,
        dir,
        unchanged: (await readFile(statePath(dir), 'utf8')) === before,
      };
    }

    it('keeps pending work and re-emits the exact bindable attempt', async () => {
      const attempt = attemptFor(obligation, 1);
      const result = await route(obligation, [attempt]);
      expect(result.obligation.status).toBe('pending');
      expect(result.response.reviewAttemptId).toBe(attempt.attemptId);
      expect(result.response.reviewObligation.obligationId).toBe(obligation.obligationId);
      expect(result.response.reviewDispatch.required).toBe(true);
      expect(result.unchanged).toBe(true);
    });

    async function rejectsWithoutRepair(reason?: ReviewAttempt['rejectionReason']) {
      const rejected = attemptFor(obligation, 1, true, reason);
      const result = await route(obligation, [rejected]);
      expect(result.response).toMatchObject({ error: true, code: 'REVIEW_ATTEMPT_UNAVAILABLE' });
      expect(result.obligation).toEqual({
        ...obligation,
        status: 'blocked',
        blockedCode: 'REVIEW_ATTEMPT_UNAVAILABLE',
      });
      expect(resolveReviewContinuation(result.after.reviewAssurance, family).kind).toBe('blocked');
    }

    it('blocks after output rejection without reissuing an attempt', async () => {
      await rejectsWithoutRepair('consistency_invalid');
    });

    it('blocks after governance rejection (the original identical structured-reason case)', async () => {
      await rejectsWithoutRepair('consistency_invalid');
    });

    it('blocks when the rejection has no structured reason', async () => {
      await rejectsWithoutRepair();
    });

    it('leaves fulfilled state untouched and defers to verdict handling, never certifying evidence here', async () => {
      const { fulfilled, bound, assurance } = fulfilledFor(obligation, state.binding.hostSessionId);
      const result = await route(fulfilled, [bound], assurance);
      expect(result.obligation).toEqual(fulfilled);
      expect(result.response).toBeNull();
      expect(result.unchanged).toBe(true);
      expect(resolveReviewContinuation(result.after.reviewAssurance, family).kind).toBe(
        'awaiting_verdict',
      );
    });

    it('refuses broken frozen material with zero persisted mutation', async () => {
      // The exact old mismatch fixture now fails at the persistence schema, before routing.
      const valid = await route(obligation, [attemptFor(obligation, 1)]);
      const bytes = await readFile(statePath(valid.dir), 'utf8');
      const tampered: ReviewObligation = {
        ...obligation,
        reviewMaterial: { ...obligation.reviewMaterial, subjectDigest: 'other-digest' },
      };
      await expect(
        writeState(valid.dir, {
          ...valid.after,
          reviewAssurance: assuranceWith({
            obligation: tampered,
            attempts: [attemptFor(tampered, 1, true, 'consistency_invalid')],
          }),
        }),
      ).rejects.toMatchObject({ code: 'SCHEMA_VALIDATION_FAILED' });
      expect(await readFile(statePath(valid.dir), 'utf8')).toBe(bytes);
      // A schema-valid but content-tampered envelope must also refuse route-time settlement.
      const brokenContent: ReviewObligation = {
        ...obligation,
        reviewMaterial: {
          ...obligation.reviewMaterial,
          content: `${obligation.reviewMaterial.content}\nTampered`,
        },
      };
      const result = await route(brokenContent, [
        attemptFor(brokenContent, 1, true, 'consistency_invalid'),
      ]);
      expect(result.response).toMatchObject({
        error: true,
        code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      });
      expect(result.obligation.status).toBe('pending');
      expect(result.obligation.blockedCode).toBeNull();
      expect(result.unchanged).toBe(true);
    });

    it('invariant: each intact pending obligation retains a legal exact-attempt continuation', async () => {
      const bindable = attemptFor(obligation, 2);
      const rejected = attemptFor(obligation, 1, true, 'consistency_invalid');
      for (const attempts of [[rejected], [bindable]]) {
        const result = await route(obligation, attempts);
        if (result.obligation.status !== 'pending') {
          expect(result.obligation.status).toBe('blocked');
          expect(result.obligation.blockedCode).toBe('REVIEW_ATTEMPT_UNAVAILABLE');
          continue;
        }
        const continuation = resolveReviewContinuation(result.after.reviewAssurance, family);
        expect(continuation).toMatchObject({
          kind: 'awaiting_task',
          attemptId: bindable.attemptId,
        });
        expect(result.assurance.attempts).toContainEqual(bindable);
        expect(result.response.reviewAttemptId).toBe(bindable.attemptId);
        expect(result.unchanged).toBe(true);
      }
      // The original mixed fixture had TWO initial attempts: it is not a legal V2
      // persisted input. Reject it instead of normalizing it to an authorized retry.
      const valid = await route(obligation, [bindable]);
      const before = await readFile(statePath(valid.dir), 'utf8');
      await expect(
        writeState(valid.dir, {
          ...valid.after,
          reviewAssurance: assuranceWith({ obligation, attempts: [rejected, bindable] }),
        }),
      ).rejects.toMatchObject({ code: 'SCHEMA_VALIDATION_FAILED' });
      expect(await readFile(statePath(valid.dir), 'utf8')).toBe(before);

      // Exercise the current legal mixed shape via the existing bounded re-arm
      // owner, with exact completed-release lineage. This does not certify the
      // fixture findings or run the independent F12 validation policy.
      const scope = obligation.reviewSubjectScope;
      if (scope.kind !== 'artifact') throw new Error('The fixture must have artifact scope.');
      const fulfilled = fulfilledFor(obligation, state.binding.hostSessionId, {
        overallVerdict: 'accept',
        blockingIssues: [
          {
            severity: 'major',
            category: 'correctness',
            message: 'fixture contradiction',
            relation: {
              subjectAnchors: [
                {
                  kind: 'artifact_section',
                  artifactKind: scope.artifact.kind,
                  artifactDigest: obligation.subjectDigest,
                  sectionPath: scope.artifact.sectionPaths[0],
                },
              ],
              evidenceLocations: [],
            },
          },
        ],
      });
      const rearmed = buildIncoherentCaptureRearm({
        assurance: fulfilled.assurance,
        obligationId: obligation.obligationId,
        incoherentInvocationId: fulfilled.invocation.invocationId,
        incoherentAttemptId: fulfilled.bound.attemptId,
        maxIncoherentReviewerCaptureRetries: 1,
        now: LATER,
      });
      expect(rearmed.kind).toBe('rearmed');
      if (rearmed.kind !== 'rearmed')
        throw new Error('The lineage fixture must permit one re-arm.');
      const pending = rearmed.assurance.obligations[0]!;
      const mixed = await route(pending, rearmed.assurance.attempts, rearmed.assurance);
      expect(mixed.obligation.status).toBe('pending');
      expect(mixed.assurance.attempts.map((item) => item.status)).toEqual(['rejected', 'created']);
      expect(mixed.response.reviewAttemptId).toBe(rearmed.attempt.attemptId);
      expect(resolveReviewContinuation(mixed.after.reviewAssurance, family)).toMatchObject({
        kind: 'awaiting_task',
        attemptId: rearmed.attempt.attemptId,
      });
      expect(mixed.unchanged).toBe(true);
    });
  },
);
