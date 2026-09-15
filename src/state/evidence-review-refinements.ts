/**
 * @module evidence-review-refinements
 * @description Cross-record superRefine refinements for review obligations and
 *              assurance state.
 *
 * Extracted from evidence-review.ts along the refinement boundary to keep both
 * modules within the file-size budget. These are the ONLY structural
 * validators for frozen repository authority coherence:
 *
 * - standalone review obligations require a frozen reviewSubject whose
 *   subjectDigest matches;
 * - frozen repository authorities must be structurally consistent;
 * - an attempt's Discovery variant must match its obligation's frozen
 *   repository governance;
 * - a persisted provenance projection must equal the canonical derivation
 *   from frozen authority.
 *
 * Callback parameter types are STRUCTURAL (deliberately not imported from
 * evidence-review.ts) so this module stays acyclic and the superRefine
 * inference chains cleanly.
 *
 * @version v1
 */

import { z } from 'zod';
import type { FrozenRepositoryAuthority } from './evidence-review-authority.js';
import type { ReviewRepositoryIdentity as RepositoryIdentityValue } from './evidence-review-subject.js';
import type { ReviewRepositoryRevisionProvenance as ProvenanceValue } from './evidence-primitives.js';
import {
  deriveRepositoryRevisionProvenance,
  hasFrozenRepositoryAuthority,
  verifyFrozenRepositoryAuthority,
} from './evidence-review-authority.js';

/** Minimal structural obligation shape the refinements operate on. */
export interface ObligationRefinementShape {
  readonly obligationType: string;
  readonly obligationId: string;
  readonly subjectDigest: string;
  readonly criteriaVersion: string;
  readonly status: string;
  readonly invocationId: string | null;
  readonly fulfilledAt?: string | null;
  readonly consumedAt?: string | null;
  readonly reviewMaterial?: {
    readonly subjectDigest: string;
  } | null;
  readonly reviewSubject?: {
    readonly kind: string;
    readonly subjectDigest: string;
    readonly baseRepository?: RepositoryIdentityValue;
    readonly headRepository?: RepositoryIdentityValue | null;
    readonly baseSha?: string;
    readonly headSha?: string;
  } | null;
  readonly repositoryAuthority?: FrozenRepositoryAuthority;
  readonly repositoryEvidenceFreeze?: {
    readonly kind: 'available' | 'unavailable';
    readonly reason?: string;
  } | null;
  readonly repositoryRevisionProvenance?: ProvenanceValue;
  readonly reviewSubjectScope?: {
    readonly kind: string;
    readonly implementationDigest?: string;
  } | null;
}

/**
 * Implementation obligations bind their scope kind AND digest to the frozen
 * implementation subject: `obligationType === 'implement'` requires
 * `reviewSubjectScope.kind === 'implementation'` with a digest equal to the
 * obligation subject digest. Any other kind (repository_change, content,
 * artifact, unavailable) is an unsatisfiable current-contract state and is
 * rejected at the schema boundary. Mirror-side, no other obligation type may
 * carry an implementation scope.
 */
export function refineImplementationScopeSubjectCoherence(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  const scope = obligation.reviewSubjectScope;
  if (obligation.obligationType === 'implement') {
    if (scope?.kind !== 'implementation') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewSubjectScope'],
        message: 'implement obligations require an implementation reviewSubjectScope.',
      });
      return;
    }
    if (scope.implementationDigest !== obligation.subjectDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewSubjectScope'],
        message:
          'implementation reviewSubjectScope digest must equal the obligation subject digest',
      });
    }
    return;
  }
  if (scope?.kind === 'implementation') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewSubjectScope'],
      message: 'only implement obligations may carry an implementation reviewSubjectScope.',
    });
  }
}

/** Minimal structural attempt shape for the Discovery-coherence refinement. */
export interface AttemptRefinementShape {
  readonly attemptId: string;
  readonly obligationId: string;
  readonly obligationType: string;
  readonly subjectDigest: string;
  readonly ordinal: number;
  readonly status: string;
  readonly childSessionId?: string;
  readonly completedAt?: string;
  readonly observationCapability?: string;
  readonly rejectionReason?: string;
  readonly schemaErrorFingerprint?: string;
  readonly createdAt: string;
  readonly origin: {
    readonly kind: string;
    readonly predecessorAttemptId?: string;
    readonly triggerReason?: string;
  };
  readonly repositoryDiscovery: { readonly kind: 'repository' | 'not_applicable' };
}

/** Minimal structural assurance shape for the cross-record refinements. */
export interface AssuranceRefinementShape {
  readonly obligations: readonly ObligationRefinementShape[];
  readonly invocations: readonly {
    readonly invocationId: string;
    readonly obligationId: string;
    readonly obligationType: string;
    readonly childSessionId: string;
    readonly attemptId?: string;
    readonly invocationMode?: string;
    readonly source?: string;
    readonly hostVisible?: boolean;
    readonly hostCapturedAgentId?: string;
    readonly hostCapturedAgentType?: string;
    readonly hostCaptureSource?: string;
    readonly hostTaskCallId?: string;
    readonly canonicalPromptDigest?: string;
    readonly consumedByObligationId?: string | null;
    readonly reviewOutputMode?: string;
    readonly structuredOutputUsed?: boolean;
    readonly reviewAssuranceLevel?: string;
  }[];
  readonly attempts: readonly AttemptRefinementShape[];
  readonly dispatches: readonly {
    readonly dispatchId: string;
    readonly attemptId: string;
    readonly obligationId: string;
    readonly hostCallId: string;
    readonly canonicalPromptDigest: string;
    readonly dispatchStatus: string;
    readonly completedAt?: string;
  }[];
}

/** Frozen material must belong to the same subject as its obligation. */
export function refineReviewMaterialSubject(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  if (
    !obligation.reviewMaterial ||
    obligation.reviewMaterial.subjectDigest === obligation.subjectDigest
  ) {
    return;
  }
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['reviewMaterial', 'subjectDigest'],
    message: 'Review obligation reviewMaterial.subjectDigest must match obligation.subjectDigest.',
  });
}

/** Standalone review obligations require a frozen, digest-matching subject. */
export function refineStandaloneSubject(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  if (obligation.obligationType !== 'review') return;
  if (!obligation.reviewSubject) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewSubject'],
      message: 'Standalone review obligations require a frozen reviewSubject.',
    });
    return;
  }
  if (obligation.subjectDigest !== obligation.reviewSubject.subjectDigest) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subjectDigest'],
      message: 'Standalone review obligation subjectDigest must match reviewSubject.subjectDigest.',
    });
  }
}

/** Frozen repository authorities must be structurally consistent. */
export function refineAuthorityStructure(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  // Subject-scope coherence is part of the same authority-structure boundary:
  // a modern implementation scope must bind to the obligation subject digest.
  refineImplementationScopeSubjectCoherence(obligation, context);
  if (!obligation.repositoryAuthority) return;
  const structural = verifyFrozenRepositoryAuthority(obligation.repositoryAuthority);
  if (structural) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryAuthority'],
      message: `Invalid frozen repository authority: ${structural}`,
    });
  }
}

/** Structural equality for a frozen repository identity. */
function sameRepositoryIdentity(a: RepositoryIdentityValue, b: RepositoryIdentityValue): boolean {
  if ('kind' in a) return 'kind' in b && a.rootCommitDigest === b.rootCommitDigest;
  return !('kind' in b) && a.host === b.host && a.owner === b.owner && a.name === b.name;
}

/**
 * Obligation type ↔ frozen repository authority coherence.
 *
 * The repository authority union is shared by every obligation type, so the
 * schema must never rely on "the writer passes the right kind". Exactly one
 * relation is legal:
 *
 *   implement          → candidate_pair only
 *   plan/architecture  → context only (presence mirrors the freeze outcome)
 *   review + content   → no repository authority
 *   review + repository_change → candidate_pair | fork_pair, EXACTLY equal to
 *                                the frozen reviewSubject (identities + SHAs)
 *
 * A structurally valid authority that disagrees with the frozen reviewSubject
 * is a split-brain state: review material could describe repository A while
 * repository observations are authorized against repository B.
 */
export function refineObligationRepositoryAuthorityCoherence(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  const authority = obligation.repositoryAuthority;
  const obligationType = obligation.obligationType;
  if (obligationType === 'plan' || obligationType === 'architecture') {
    if (authority && authority.kind !== 'context') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repositoryAuthority'],
        message:
          'plan/architecture obligations may only carry a frozen repository context authority',
      });
    }
    return;
  }
  if (obligationType === 'implement') {
    if (authority && authority.kind !== 'candidate_pair') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repositoryAuthority'],
        message:
          'implement obligations may only carry a frozen candidate-pair repository authority',
      });
    }
    return;
  }
  if (obligationType !== 'review') return;
  const subject = obligation.reviewSubject;
  if (!subject || subject.kind === 'content') {
    if (authority) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repositoryAuthority'],
        message: 'content review obligations must not carry repository authority',
      });
    }
    return;
  }
  if (subject.kind !== 'repository_change') return;
  if (!authority) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryAuthority'],
      message: 'repository_change review obligations require frozen repository authority',
    });
    return;
  }
  if (authority.kind === 'context') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryAuthority'],
      message:
        'repository_change review obligations require a candidate-pair or fork-pair repository authority',
    });
    return;
  }
  const expectedHeadIdentity = subject.headRepository ?? subject.baseRepository;
  if (!subject.baseRepository || !expectedHeadIdentity) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewSubject'],
      message: 'repository_change review subjects require base repository identity',
    });
    return;
  }
  const mismatch =
    !sameRepositoryIdentity(authority.base.repositoryIdentity, subject.baseRepository) ||
    !sameRepositoryIdentity(authority.head.repositoryIdentity, expectedHeadIdentity) ||
    authority.base.objectSha !== subject.baseSha ||
    authority.head.objectSha !== subject.headSha;
  if (mismatch) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryAuthority'],
      message:
        'frozen repository authority must exactly match the frozen reviewSubject (identity and SHA)',
    });
  }
}

/**
 * Durable audit coherence: the persisted freeze outcome must agree with the
 * actual frozen repository authority — and plan/architecture obligations MUST
 * carry the record (no third state, no legacy exception).
 *
 *   obligationType ∈ {plan, architecture}
 *     ⇒ repositoryEvidenceFreeze MUST exist
 *   freeze.kind === 'available'   ⇔ repositoryAuthority present
 *   freeze.kind === 'unavailable' ⇔ repositoryAuthority absent
 *
 * Review/implement obligations never run the context freeze and must not
 * carry the record.
 */
export function refineRepositoryEvidenceFreezeCoherence(
  obligation: ObligationRefinementShape,
  context: z.RefinementCtx,
): void {
  const freeze = obligation.repositoryEvidenceFreeze;
  const contextFreezeObligation =
    obligation.obligationType === 'plan' || obligation.obligationType === 'architecture';
  if (!freeze) {
    if (contextFreezeObligation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repositoryEvidenceFreeze'],
        message: 'plan/architecture obligations require a repository evidence freeze outcome',
      });
    }
    return;
  }
  if (!contextFreezeObligation) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryEvidenceFreeze'],
      message: 'only plan/architecture obligations carry a repository evidence freeze outcome',
    });
    return;
  }
  if (freeze.kind === 'available' && !obligation.repositoryAuthority) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryEvidenceFreeze'],
      message:
        'repositoryEvidenceFreeze claims an available repository freeze but the obligation carries no frozen repository authority',
    });
    return;
  }
  if (freeze.kind === 'unavailable' && obligation.repositoryAuthority) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repositoryEvidenceFreeze'],
      message:
        'repositoryEvidenceFreeze records an unavailable repository freeze but the obligation carries a frozen repository authority',
    });
  }
}

/** An attempt's Discovery variant must match its obligation's frozen governance. */
export function refineAssuranceDiscoveryCoherence(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): void {
  const obligationsById = new Map(
    assurance.obligations.map((obligation) => [obligation.obligationId, obligation]),
  );
  for (const attempt of assurance.attempts) {
    if (attempt.repositoryDiscovery.kind === 'repository' && !attempt.observationCapability) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `repository-governed attempt ${attempt.attemptId} requires an observation capability`,
      });
      return;
    }
    if (attempt.repositoryDiscovery.kind !== 'repository' && attempt.observationCapability) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `non-repository attempt ${attempt.attemptId} must not carry an observation capability`,
      });
      return;
    }
    const obligation = obligationsById.get(attempt.obligationId);
    if (!obligation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `attempt ${attempt.attemptId} references unknown obligation ${attempt.obligationId}`,
      });
      return;
    }
    const repositoryGoverned = hasFrozenRepositoryAuthority(obligation);
    if (repositoryGoverned && attempt.repositoryDiscovery.kind !== 'repository') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `attempt ${attempt.attemptId} must carry a repository Discovery snapshot for a repository-governed obligation`,
      });
      return;
    }
    if (!repositoryGoverned && attempt.repositoryDiscovery.kind !== 'not_applicable') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `attempt ${attempt.attemptId} must carry not_applicable Discovery for a non-repository-governed obligation`,
      });
      return;
    }
  }
}

/**
 * Canonical linkage coherence (CE2): when an obligation's canonical linkage
 * points at an invocation, the invocation must back-reference the SAME
 * obligation on both sides of the relation (`obligationId` AND
 * `obligationType`). Identifier equality alone is not a relation — an
 * invocation whose back-references disagree with the linked obligation is an
 * invalid state, not legacy data.
 */
export function refineAssuranceInvocationLinkageCoherence(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): void {
  for (const invocation of assurance.invocations) {
    // Provenance is derived from HOW the reviewer was invoked; a state whose
    // transport, visibility, corroboration, or output provenance disagrees
    // with the invocation mode claims more assurance than was observed.
    const hostObserved =
      invocation.invocationMode === 'host_subagent_task' ||
      invocation.invocationMode === 'sdk_session_prompt';
    const agentSubmitted =
      invocation.invocationMode === 'manual_attested' ||
      invocation.invocationMode === 'native_subagent_attested';
    const expectedMode = hostObserved
      ? 'structured_output'
      : agentSubmitted
        ? 'agent_submitted_structured'
        : null;
    const expectedLevel =
      expectedMode === 'structured_output'
        ? 'structured_high'
        : expectedMode === 'agent_submitted_structured'
          ? 'structured_submitted'
          : null;
    const expectedSource = hostObserved
      ? 'host-orchestrated'
      : agentSubmitted
        ? 'agent-submitted-attested'
        : null;
    const expectedHostVisible = invocation.invocationMode === 'host_subagent_task';
    const hostCaptureConsistent =
      invocation.invocationMode === 'native_subagent_attested'
        ? Boolean(
            invocation.hostCapturedAgentId &&
            invocation.hostCapturedAgentType &&
            invocation.hostCaptureSource,
          )
        : !invocation.hostCapturedAgentId &&
          !invocation.hostCapturedAgentType &&
          !invocation.hostCaptureSource;
    if (
      expectedMode === null ||
      invocation.reviewOutputMode !== expectedMode ||
      invocation.reviewAssuranceLevel !== expectedLevel ||
      invocation.structuredOutputUsed !== (expectedMode === 'structured_output') ||
      invocation.source !== expectedSource ||
      invocation.hostVisible !== expectedHostVisible ||
      !hostCaptureConsistent
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: 'Review invocation evidence requires consistent invocation provenance.',
      });
      return;
    }
    // A host-task invocation is the evidence side of exactly one durable
    // dispatch: the dispatch must exist for the same attempt and be closed as
    // completed on the same host call with the same canonical prompt.
    if (invocation.invocationMode === 'host_subagent_task') {
      const dispatch = assurance.dispatches.find(
        (record) => record.attemptId === invocation.attemptId,
      );
      if (
        !invocation.hostTaskCallId ||
        !invocation.canonicalPromptDigest ||
        !dispatch ||
        dispatch.dispatchStatus !== 'completed' ||
        dispatch.hostCallId !== invocation.hostTaskCallId ||
        dispatch.canonicalPromptDigest !== invocation.canonicalPromptDigest
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['invocations'],
          message: `host-task invocation ${invocation.invocationId} requires a completed matching dispatch`,
        });
        return;
      }
    } else if (invocation.hostTaskCallId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `non-host-task invocation ${invocation.invocationId} must not carry a host task call id`,
      });
      return;
    }
  }
  const attemptsByAttemptId = new Map(
    assurance.attempts.map((attempt) => [attempt.attemptId, attempt]),
  );
  for (const invocation of assurance.invocations) {
    const attemptId = invocation.attemptId;
    if (!attemptId) continue;
    const attempt = attemptsByAttemptId.get(attemptId);
    if (!attempt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `invocation ${invocation.invocationId} references unknown attempt ${invocation.attemptId}`,
      });
      return;
    }
    if (
      attempt.obligationId !== invocation.obligationId ||
      attempt.obligationType !== invocation.obligationType
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `invocation ${invocation.invocationId} attempt ${attempt.attemptId} belongs to a different obligation`,
      });
      return;
    }
    // The invocation records that the attempt held reviewer evidence. A later
    // coherence rejection may revoke acceptance (`rejected`) without erasing
    // that lineage; `created`/`stale`/`expired` attempts never hold evidence.
    if (
      attempt.status !== 'bound' &&
      attempt.status !== 'captured' &&
      attempt.status !== 'rejected'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `invocation ${invocation.invocationId} attempt ${attempt.attemptId} has no bound lifecycle`,
      });
      return;
    }
    if (attempt.childSessionId !== invocation.childSessionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `invocation ${invocation.invocationId} child session does not match the bound attempt`,
      });
      return;
    }
    if (!attempt.completedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `invocation ${invocation.invocationId} bound attempt is missing completedAt`,
      });
      return;
    }
  }
  const invocationsByInvocationId = new Map(
    assurance.invocations.map((invocation) => [invocation.invocationId, invocation]),
  );
  for (const obligation of assurance.obligations) {
    if (obligation.invocationId) {
      const linked = invocationsByInvocationId.get(obligation.invocationId);
      if (!linked) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['obligations'],
          message: `obligation ${obligation.obligationId} references unknown invocation ${obligation.invocationId}`,
        });
        return;
      }
      if (
        linked.obligationId !== obligation.obligationId ||
        linked.obligationType !== obligation.obligationType
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['invocations'],
          message: `invocation ${linked.invocationId} is the canonical linkage of obligation ${obligation.obligationId} but back-references obligation ${linked.obligationId} (type ${linked.obligationType})`,
        });
        return;
      }
    }
    if (
      (obligation.status === 'fulfilled' || obligation.status === 'consumed') &&
      (!obligation.invocationId || !obligation.fulfilledAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['obligations'],
        message: `obligation ${obligation.obligationId} is ${obligation.status} without invocation lineage and fulfilledAt`,
      });
      return;
    }
    if (obligation.status === 'consumed' && !obligation.consumedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['obligations'],
        message: `consumed obligation ${obligation.obligationId} is missing consumedAt`,
      });
      return;
    }
  }
  for (const invocation of assurance.invocations) {
    // Consumption is self-referential: an invocation that was consumed must
    // name its OWN obligation, never an arbitrary (even existing) one.
    if (
      invocation.consumedByObligationId != null &&
      invocation.consumedByObligationId !== invocation.obligationId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `invocation ${invocation.invocationId} consumedByObligationId must equal its own obligationId`,
      });
      return;
    }
  }
}

/**
 * Canonical identity uniqueness (CE2 hardening): identifiers are only
 * canonical when they are unique. Duplicate `obligationId`s let one invocation
 * appear to canonically support several review subjects; duplicate
 * `invocationId`s let a `.find()` pick an arbitrary row as the authority;
 * duplicate `attemptId`s corrupt attempt binding. All three are invalid
 * states, not legacy data.
 */
export function refineAssuranceIdentityUniqueness(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): void {
  const obligationIds = new Set<string>();
  for (const obligation of assurance.obligations) {
    if (obligationIds.has(obligation.obligationId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['obligations'],
        message: `duplicate obligationId ${obligation.obligationId} — an obligation identity must be unique across the assurance state`,
      });
      return;
    }
    obligationIds.add(obligation.obligationId);
  }
  const invocationIds = new Set<string>();
  for (const invocation of assurance.invocations) {
    if (invocationIds.has(invocation.invocationId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `duplicate invocationId ${invocation.invocationId} — an invocation identity must be unique across the assurance state`,
      });
      return;
    }
    invocationIds.add(invocation.invocationId);
  }
  const attemptIds = new Set<string>();
  for (const attempt of assurance.attempts) {
    if (attemptIds.has(attempt.attemptId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `duplicate attemptId ${attempt.attemptId} — an attempt identity must be unique across the assurance state`,
      });
      return;
    }
    attemptIds.add(attempt.attemptId);
  }
}

/**
 * A persisted provenance projection must equal the canonical derivation from
 * frozen authority. Divergent projections are authority drift, not legacy data.
 */
export function refineAssuranceProvenanceCoherence(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): void {
  for (const obligation of assurance.obligations) {
    if (!obligation.repositoryAuthority) continue;
    const derived = deriveRepositoryRevisionProvenance(obligation);
    if (derived.kind === 'unavailable') continue;
    const persisted = obligation.repositoryRevisionProvenance as ProvenanceValue | undefined;
    if (
      persisted &&
      (persisted.kind !== 'available' ||
        persisted.headSha !== derived.headSha ||
        persisted.baseSha !== derived.baseSha)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['obligations'],
        message: `obligation ${obligation.obligationId} carries a provenance projection that diverges from its frozen repository authority`,
      });
      return;
    }
  }
}
