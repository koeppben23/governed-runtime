import { describe, expect, it } from 'vitest';
import { executeReviewDecision } from './review-decision.js';
import {
  resolveArchitectureReviewEvidence,
  resolveBoundReviewEvidenceForSubject,
  resolveLatestBoundReviewEvidence,
} from './review-evidence-resolution.js';
import { makeState, ARCHITECTURE_DECISION, FIXED_TIME } from '../fixtures.js';
import { TEAM_POLICY } from '../config/policy.js';
import type { ReviewAssuranceState } from '../state/evidence-review.js';

const ARCH_INVOCATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Minimal converged self-review for gate-path tests. */
const CONVERGED_SELF_REVIEW = {
  iteration: 1,
  maxIterations: 3,
  prevDigest: null,
  currDigest: 'review-digest',
  revisionDelta: 'none' as const,
  verdict: 'accept' as const,
  decidedAt: FIXED_TIME,
};

const baseCtx = {
  now: () => FIXED_TIME,
  digest: (text: string) => `sha256:${text.length}`,
  policy: TEAM_POLICY,
};

// ─── Architecture review evidence resolution (resolver-level) ───────────────

interface AssuranceEntry {
  obligationId: string;
  obligationType?: 'architecture' | 'plan';
  subjectDigest: string;
  status: 'fulfilled' | 'consumed' | 'pending';
  iteration?: number;
  createdAt?: string;
  /** `null` = obligation without linkage; `undefined` = no invocation entry. */
  invocationId?: string | null;
  findingsHash?: string;
  invokedAt?: string;
  consumedByObligationId?: string | null;
  capturedVerdict?: string;
}

/** Arbitrary assurance chains for resolver tests (one obligation per entry). */
function assuranceChain(entries: AssuranceEntry[]): ReviewAssuranceState {
  const obligations: ReviewAssuranceState['obligations'] = entries.map((e) => {
    const createdAt = e.createdAt ?? '2026-01-01T00:00:00.000Z';
    const subjectDigest = e.subjectDigest;
    return {
      obligationId: e.obligationId,
      obligationType: e.obligationType ?? 'architecture',
      iteration: e.iteration ?? 0,
      planVersion: 1,
      criteriaVersion: 'criteria-v1',
      mandateDigest: 'm'.repeat(64),
      createdAt,
      pluginHandshakeAt: null,
      status: e.status,
      invocationId: e.invocationId === undefined ? ARCH_INVOCATION_ID : e.invocationId,
      blockedCode: null,
      fulfilledAt: createdAt,
      consumedAt: e.status === 'consumed' ? createdAt : null,
      subjectDigest,
      reviewMaterial: {
        content: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        materialDigest: 'material-digest-of-architecture-review',
        subjectDigest,
      },
      reviewSubjectScope: {
        kind: 'artifact',
        artifact: {
          kind: 'adr',
          digest: subjectDigest,
          sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'ADR' }]],
        },
      },
      repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
      maxReviewerOutputRepairAttempts: 0,
    };
  });
  const invocations: ReviewAssuranceState['invocations'] = entries
    .filter((e) => e.invocationId !== undefined)
    .map((e, index) => {
      const createdAt = e.createdAt ?? '2026-01-01T00:00:00.000Z';
      return {
        invocationId:
          e.invocationId === null
            ? `${e.obligationId}-inv-${(e.findingsHash ?? 'x').slice(0, 8)}`
            : (e.invocationId as string),
        obligationId: e.obligationId,
        obligationType: e.obligationType ?? 'architecture',
        parentSessionId: `parent-${index}`,
        childSessionId: `child-${index}`,
        agentType: 'flowguard-reviewer',
        invocationMode: 'host_subagent_task',
        hostVisible: true,
        promptHash: 'prompt-hash',
        mandateDigest: 'm'.repeat(64),
        criteriaVersion: 'criteria-v1',
        findingsHash: e.findingsHash ?? 'f'.repeat(64),
        invokedAt: e.invokedAt ?? createdAt,
        fulfilledAt: e.invokedAt ?? createdAt,
        consumedByObligationId: e.consumedByObligationId ?? null,
        ...(e.capturedVerdict ? { capturedVerdict: e.capturedVerdict } : {}),
        reviewOutputMode: 'structured_output',
        structuredOutputUsed: true,
        reviewAssuranceLevel: 'structured_high',
      };
    });
  return { assuranceSchemaVersion: 'review-assurance.v5', obligations, invocations, attempts: [] };
}

describe('architecture review evidence resolution', () => {
  const ADR_DIGEST = 'a'.repeat(64);
  const OTHER_DIGEST = 'b'.repeat(64);

  function resolverState(entries: AssuranceEntry[]) {
    return makeState('ARCH_REVIEW', {
      architecture: { ...ARCHITECTURE_DECISION, digest: ADR_DIGEST },
      reviewAssurance: assuranceChain(entries),
    });
  }

  describe('resolveBoundReviewEvidenceForSubject', () => {
    it('returns the latest-bound obligation when several match (sort by iteration, then createdAt)', () => {
      const state = resolverState([
        {
          obligationId: 'older',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          iteration: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          invocationId: 'inv-older',
          findingsHash: '1'.repeat(64),
          invokedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          obligationId: 'newer',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          iteration: 1,
          createdAt: '2026-01-02T00:00:00.000Z',
          invocationId: 'inv-newer',
          findingsHash: '2'.repeat(64),
          invokedAt: '2026-01-02T00:00:00.000Z',
        },
      ]);
      const resolved = resolveBoundReviewEvidenceForSubject(state, 'architecture', ADR_DIGEST);
      expect(resolved?.obligationId).toBe('newer');
      expect(resolved?.findingsHash).toBe('2'.repeat(64));
    });

    it('breaks iteration ties by createdAt (later createdAt wins)', () => {
      const state = resolverState([
        {
          obligationId: 'older-created',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          iteration: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          invocationId: 'inv-a',
          findingsHash: '1'.repeat(64),
        },
        {
          obligationId: 'newer-created',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          iteration: 0,
          createdAt: '2026-01-02T00:00:00.000Z',
          invocationId: 'inv-b',
          findingsHash: '2'.repeat(64),
        },
      ]);
      const resolved = resolveBoundReviewEvidenceForSubject(state, 'architecture', ADR_DIGEST);
      expect(resolved?.obligationId).toBe('newer-created');
      expect(resolved?.findingsHash).toBe('2'.repeat(64));
    });

    it('skips an obligation without invocation evidence and falls back to the next one', () => {
      const state = resolverState([
        {
          obligationId: 'no-evidence',
          subjectDigest: ADR_DIGEST,
          status: 'fulfilled',
          iteration: 1,
          createdAt: '2026-01-02T00:00:00.000Z',
        },
        {
          obligationId: 'with-evidence',
          subjectDigest: ADR_DIGEST,
          status: 'fulfilled',
          iteration: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          invocationId: 'inv-real',
          findingsHash: '3'.repeat(64),
        },
      ]);
      const resolved = resolveBoundReviewEvidenceForSubject(state, 'architecture', ADR_DIGEST);
      expect(resolved?.obligationId).toBe('with-evidence');
      expect(resolved?.findingsHash).toBe('3'.repeat(64));
    });

    it('excludes obligations of another type even with a matching subject digest', () => {
      const state = resolverState([
        {
          obligationId: 'plan-ob',
          obligationType: 'plan',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: 'inv-plan',
          findingsHash: '4'.repeat(64),
        },
      ]);
      expect(resolveBoundReviewEvidenceForSubject(state, 'architecture', ADR_DIGEST)).toBeNull();
    });

    it('excludes obligations that are neither fulfilled nor consumed', () => {
      const state = resolverState([
        {
          obligationId: 'pending-ob',
          subjectDigest: ADR_DIGEST,
          status: 'pending',
          invocationId: 'inv-pending',
          findingsHash: '5'.repeat(64),
        },
      ]);
      expect(resolveBoundReviewEvidenceForSubject(state, 'architecture', ADR_DIGEST)).toBeNull();
    });

    it('resolves a fulfilled (not consumed) obligation', () => {
      const state = resolverState([
        {
          obligationId: 'fulfilled-ob',
          subjectDigest: ADR_DIGEST,
          status: 'fulfilled',
          invocationId: 'inv-fulfilled',
          findingsHash: '6'.repeat(64),
        },
      ]);
      const resolved = resolveBoundReviewEvidenceForSubject(state, 'architecture', ADR_DIGEST);
      expect(resolved?.obligationId).toBe('fulfilled-ob');
    });

    it('requires the exact subject digest (no cross-digest fallback)', () => {
      const state = resolverState([
        {
          obligationId: 'other-digest-ob',
          subjectDigest: OTHER_DIGEST,
          status: 'consumed',
          invocationId: 'inv-other',
          findingsHash: '7'.repeat(64),
        },
      ]);
      expect(resolveBoundReviewEvidenceForSubject(state, 'architecture', ADR_DIGEST)).toBeNull();
    });

    it('prefers the invocation bound via obligation.invocationId over obligationId-linked ones', () => {
      const assurance = assuranceChain([
        {
          obligationId: 'ob-2',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: 'inv-2',
          findingsHash: '9'.repeat(64),
          invokedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      const extra = assuranceChain([
        {
          obligationId: 'ob-2',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: 'inv-other',
          findingsHash: '8'.repeat(64),
          invokedAt: '2026-01-02T00:00:00.000Z',
        },
      ]);
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, digest: ADR_DIGEST },
        reviewAssurance: {
          ...assurance,
          invocations: [...assurance.invocations, ...extra.invocations],
        },
      });
      // ob-2's canonical linkage points at inv-2 (8s-hash must not win even
      // though inv-other is newer and shares the obligationId).
      const forOb2 = resolveBoundReviewEvidenceForSubject(state, 'architecture', ADR_DIGEST);
      expect(forOb2?.obligationId).toBe('ob-2');
      expect(forOb2?.findingsHash).toBe('9'.repeat(64));
    });

    it('resolves via obligationId linkage when the obligation invocationId is null', () => {
      const state = resolverState([
        {
          obligationId: 'ob-host-task',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: null,
          findingsHash: 'a'.repeat(64),
        },
      ]);
      const resolved = resolveBoundReviewEvidenceForSubject(state, 'architecture', ADR_DIGEST);
      expect(resolved?.obligationId).toBe('ob-host-task');
      expect(resolved?.findingsHash).toBe('a'.repeat(64));
    });

    it('restricts obligationId linkage to the obligation at hand (no foreign invocation bleed)', () => {
      const own = assuranceChain([
        {
          obligationId: 'ob-own',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: null,
          findingsHash: 'a'.repeat(64),
          invokedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      const foreign = assuranceChain([
        {
          obligationId: 'ob-foreign',
          subjectDigest: OTHER_DIGEST,
          status: 'consumed',
          invocationId: null,
          findingsHash: 'c'.repeat(64),
          invokedAt: '2026-01-02T00:00:00.000Z',
        },
      ]);
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, digest: ADR_DIGEST },
        reviewAssurance: {
          ...own,
          obligations: [...own.obligations, ...foreign.obligations],
          invocations: [...own.invocations, ...foreign.invocations],
        },
      });
      const resolved = resolveBoundReviewEvidenceForSubject(state, 'architecture', ADR_DIGEST);
      expect(resolved?.obligationId).toBe('ob-own');
      expect(resolved?.findingsHash).toBe('a'.repeat(64));
    });

    it('prefers the consumed invocation when several link to one obligation (invocationId unset)', () => {
      const assurance = assuranceChain([
        {
          obligationId: 'ob-multi',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: null,
          findingsHash: 'd'.repeat(64),
          invokedAt: '2026-01-01T00:00:00.000Z',
          consumedByObligationId: 'ob-multi',
        },
      ]);
      const newer = assuranceChain([
        {
          obligationId: 'ob-multi',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: null,
          findingsHash: 'e'.repeat(64),
          invokedAt: '2026-01-02T00:00:00.000Z',
        },
      ]);
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, digest: ADR_DIGEST },
        reviewAssurance: {
          ...assurance,
          invocations: [...assurance.invocations, ...newer.invocations],
        },
      });
      // The obligation was consumed with the OLDER invocation; the newer
      // un-consumed one must not override that linkage.
      const resolved = resolveBoundReviewEvidenceForSubject(state, 'architecture', ADR_DIGEST);
      expect(resolved?.findingsHash).toBe('d'.repeat(64));
    });

    it('falls back to the newest invocation when none is consumed-linked', () => {
      const assurance = assuranceChain([
        {
          obligationId: 'ob-multi',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: null,
          findingsHash: 'a'.repeat(64),
          invokedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      const newer = assuranceChain([
        {
          obligationId: 'ob-multi',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: null,
          findingsHash: 'b'.repeat(64),
          invokedAt: '2026-01-02T00:00:00.000Z',
        },
      ]);
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, digest: ADR_DIGEST },
        reviewAssurance: {
          ...assurance,
          invocations: [...assurance.invocations, ...newer.invocations],
        },
      });
      const resolved = resolveBoundReviewEvidenceForSubject(state, 'architecture', ADR_DIGEST);
      expect(resolved?.findingsHash).toBe('b'.repeat(64));
    });

    it('excludes invocations without a findingsHash', () => {
      const state = resolverState([
        {
          obligationId: 'ob-empty-hash',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: 'inv-empty',
          findingsHash: '',
        },
      ]);
      expect(resolveBoundReviewEvidenceForSubject(state, 'architecture', ADR_DIGEST)).toBeNull();
    });

    it('surfaces the host-captured verdict when present', () => {
      const state = resolverState([
        {
          obligationId: 'ob-verdict',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: 'inv-verdict',
          findingsHash: 'b'.repeat(64),
          capturedVerdict: 'accept',
        },
      ]);
      const resolved = resolveBoundReviewEvidenceForSubject(state, 'architecture', ADR_DIGEST);
      expect(resolved?.reviewerVerdict).toBe('accept');
    });

    it('returns null without any assurance', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, digest: ADR_DIGEST },
      });
      expect(resolveBoundReviewEvidenceForSubject(state, 'architecture', ADR_DIGEST)).toBeNull();
    });
  });

  describe('resolveLatestBoundReviewEvidence', () => {
    it('returns the latest bound evidence across subjects', () => {
      const state = resolverState([
        {
          obligationId: 'old-subject',
          subjectDigest: OTHER_DIGEST,
          status: 'consumed',
          iteration: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          invocationId: 'inv-old',
          findingsHash: 'c'.repeat(64),
        },
        {
          obligationId: 'new-subject',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          iteration: 1,
          createdAt: '2026-01-02T00:00:00.000Z',
          invocationId: 'inv-new',
          findingsHash: 'd'.repeat(64),
        },
      ]);
      const latest = resolveLatestBoundReviewEvidence(state, 'architecture');
      expect(latest?.obligationId).toBe('new-subject');
      expect(latest?.subjectDigest).toBe(ADR_DIGEST);
    });

    it('excludes other obligation types entirely', () => {
      const state = resolverState([
        {
          obligationId: 'plan-ob',
          obligationType: 'plan',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: 'inv-plan',
          findingsHash: 'e'.repeat(64),
        },
      ]);
      expect(resolveLatestBoundReviewEvidence(state, 'architecture')).toBeNull();
    });

    it('excludes pending obligations', () => {
      const state = resolverState([
        {
          obligationId: 'pending-ob',
          subjectDigest: ADR_DIGEST,
          status: 'pending',
          invocationId: 'inv-pending',
          findingsHash: 'f'.repeat(64),
        },
      ]);
      expect(resolveLatestBoundReviewEvidence(state, 'architecture')).toBeNull();
    });

    it('resolves a fulfilled (not consumed) obligation', () => {
      const state = resolverState([
        {
          obligationId: 'fulfilled-ob',
          subjectDigest: ADR_DIGEST,
          status: 'fulfilled',
          invocationId: 'inv-fulfilled',
          findingsHash: '1'.repeat(64),
        },
      ]);
      const latest = resolveLatestBoundReviewEvidence(state, 'architecture');
      expect(latest?.obligationId).toBe('fulfilled-ob');
    });

    it('skips evidence-less obligations and continues searching', () => {
      const state = resolverState([
        {
          obligationId: 'no-evidence',
          subjectDigest: OTHER_DIGEST,
          status: 'fulfilled',
          iteration: 1,
          createdAt: '2026-01-02T00:00:00.000Z',
        },
        {
          obligationId: 'with-evidence',
          subjectDigest: ADR_DIGEST,
          status: 'fulfilled',
          iteration: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          invocationId: 'inv-real',
          findingsHash: '2'.repeat(64),
        },
      ]);
      const latest = resolveLatestBoundReviewEvidence(state, 'architecture');
      expect(latest?.obligationId).toBe('with-evidence');
    });
  });

  describe('resolveArchitectureReviewEvidence', () => {
    it('mints current_review for reviewer_accepted with exact-subject evidence', () => {
      const state = resolverState([
        {
          obligationId: 'ob-1',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: 'inv-1',
          findingsHash: '3'.repeat(64),
        },
      ]);
      const resolution = resolveArchitectureReviewEvidence(state, {
        ...ARCHITECTURE_DECISION,
        digest: ADR_DIGEST,
        reviewCompletion: 'reviewer_accepted',
      });
      expect(resolution.kind).toBe('bound');
      if (resolution.kind === 'bound') {
        expect(resolution.binding).toEqual({
          kind: 'current_review',
          reviewObligationId: 'ob-1',
          reviewEvidenceDigest: '3'.repeat(64),
          reviewedSubjectDigest: ADR_DIGEST,
        });
      }
    });

    it('mints current_review when the exact evidence captured an accept verdict', () => {
      const state = resolverState([
        {
          obligationId: 'ob-1',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: 'inv-1',
          findingsHash: '3'.repeat(64),
          capturedVerdict: 'accept',
        },
      ]);
      const resolution = resolveArchitectureReviewEvidence(state, {
        ...ARCHITECTURE_DECISION,
        digest: ADR_DIGEST,
        reviewCompletion: 'reviewer_accepted',
      });
      expect(resolution.kind).toBe('bound');
      if (resolution.kind === 'bound') {
        expect(resolution.binding.kind).toBe('current_review');
      }
    });

    it('refuses current_review when the exact evidence captured a rejecting verdict', () => {
      const state = resolverState([
        {
          obligationId: 'ob-1',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: 'inv-1',
          findingsHash: '3'.repeat(64),
          capturedVerdict: 'changes_requested',
        },
      ]);
      const resolution = resolveArchitectureReviewEvidence(state, {
        ...ARCHITECTURE_DECISION,
        digest: ADR_DIGEST,
        reviewCompletion: 'reviewer_accepted',
      });
      expect(resolution).toEqual({ kind: 'unavailable' });
    });

    it('mints review_exhausted_override from the latest real evidence', () => {
      const state = resolverState([
        {
          obligationId: 'ob-1',
          subjectDigest: OTHER_DIGEST,
          status: 'consumed',
          invocationId: 'inv-1',
          findingsHash: '4'.repeat(64),
        },
      ]);
      const resolution = resolveArchitectureReviewEvidence(state, {
        ...ARCHITECTURE_DECISION,
        digest: ADR_DIGEST,
        reviewCompletion: 'review_exhausted',
      });
      expect(resolution.kind).toBe('bound');
      if (resolution.kind === 'bound') {
        expect(resolution.binding).toEqual({
          kind: 'review_exhausted_override',
          lastReviewObligationId: 'ob-1',
          lastReviewEvidenceDigest: '4'.repeat(64),
          reviewedSubjectDigest: OTHER_DIGEST,
          approvedSubjectDigest: ADR_DIGEST,
        });
      }
    });

    it('mints review_exhausted_override when the latest evidence did not accept', () => {
      const state = resolverState([
        {
          obligationId: 'ob-1',
          subjectDigest: OTHER_DIGEST,
          status: 'consumed',
          invocationId: 'inv-1',
          findingsHash: '4'.repeat(64),
          capturedVerdict: 'changes_requested',
        },
      ]);
      const resolution = resolveArchitectureReviewEvidence(state, {
        ...ARCHITECTURE_DECISION,
        digest: ADR_DIGEST,
        reviewCompletion: 'review_exhausted',
      });
      expect(resolution.kind).toBe('bound');
      if (resolution.kind === 'bound') {
        expect(resolution.binding.kind).toBe('review_exhausted_override');
      }
    });

    it('flags an exhaustion contradiction when the latest evidence captured accept', () => {
      const state = resolverState([
        {
          obligationId: 'ob-1',
          subjectDigest: OTHER_DIGEST,
          status: 'consumed',
          invocationId: 'inv-1',
          findingsHash: '4'.repeat(64),
          capturedVerdict: 'accept',
        },
      ]);
      const resolution = resolveArchitectureReviewEvidence(state, {
        ...ARCHITECTURE_DECISION,
        digest: ADR_DIGEST,
        reviewCompletion: 'review_exhausted',
      });
      expect(resolution).toEqual({ kind: 'exhaustion_contradiction', capturedVerdict: 'accept' });
    });

    it('resolves unavailable for any other review completion (kind comes from the gate path only)', () => {
      const state = resolverState([
        {
          obligationId: 'ob-1',
          subjectDigest: ADR_DIGEST,
          status: 'consumed',
          invocationId: 'inv-1',
          findingsHash: '5'.repeat(64),
        },
      ]);
      const resolution = resolveArchitectureReviewEvidence(state, {
        ...ARCHITECTURE_DECISION,
        digest: ADR_DIGEST,
        reviewCompletion: 'pending',
      });
      expect(resolution).toEqual({ kind: 'unavailable' });
    });
  });

  describe('evidence gate via executeReviewDecision', () => {
    it('reports the actual review completion in the blocked details', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('ARCHITECTURE_REVIEW_EVIDENCE_REQUIRED');
        // Pins the rendered completion detail (blocked() renders vars into
        // the reason message; an emptied detail literal must not survive).
        expect(result.reason).toContain('Current review completion: reviewer_accepted.');
      }
    });

    it('approve at ARCH_REVIEW without architecture state stays blocked (no resolution crash path)', () => {
      const state = makeState('ARCH_REVIEW', {
        selfReview: CONVERGED_SELF_REVIEW,
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('ARCHITECTURE_REVIEW_COMPLETION_REQUIRED');
      }
    });

    it('blocks reviewer_accepted when the exact evidence captured a rejecting verdict', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: assuranceChain([
          {
            obligationId: 'ob-reject',
            subjectDigest: ARCHITECTURE_DECISION.digest,
            status: 'consumed',
            invocationId: 'inv-reject',
            findingsHash: 'a'.repeat(64),
            capturedVerdict: 'changes_requested',
          },
        ]),
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('ARCHITECTURE_REVIEW_EVIDENCE_REQUIRED');
      }
    });

    it('blocks review_exhausted when the latest evidence captured an accept verdict (coherence)', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'review_exhausted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: assuranceChain([
          {
            obligationId: 'ob-accept',
            subjectDigest: ARCHITECTURE_DECISION.digest,
            status: 'consumed',
            invocationId: 'inv-accept',
            findingsHash: 'b'.repeat(64),
            capturedVerdict: 'accept',
          },
        ]),
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('ARCHITECTURE_REVIEW_EVIDENCE_CONTRADICTS_COMPLETION');
        expect(result.reason).toContain('reviewCompletion: review_exhausted');
        expect(result.reason).toContain('captured reviewer verdict: accept.');
      }
    });

    it('allows review_exhausted when the latest evidence did not accept (consistent override)', () => {
      const state = makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'review_exhausted' },
        selfReview: CONVERGED_SELF_REVIEW,
        reviewAssurance: assuranceChain([
          {
            obligationId: 'ob-cr',
            subjectDigest: ARCHITECTURE_DECISION.digest,
            status: 'consumed',
            invocationId: 'inv-cr',
            findingsHash: 'c'.repeat(64),
            capturedVerdict: 'changes_requested',
          },
        ]),
      });
      const result = executeReviewDecision(
        state,
        { verdict: 'approve', rationale: 'ok', decidedBy: 'reviewer-1' },
        baseCtx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.architecture?.approvalCertificate?.reviewBinding?.kind).toBe(
          'review_exhausted_override',
        );
      }
    });
  });
});
