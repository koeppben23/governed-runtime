/**
 * @module evidence-review-authority
 * @description Canonical frozen repository authority for repository-governed
 *              review obligations.
 *
 * The authority model replaces mutable runtime state (worktree `HEAD`,
 * current branch, provider-latest) as the resolution source for review
 * evidence revisions:
 *
 * ```text
 * revision ('base' | 'head')
 *   → frozen repository object (commit or content-addressed tree)
 *   → exact blob at path
 * ```
 *
 * An obligation WITHOUT frozen repository authority cannot authorize any
 * repository evidence — absence must surface as `evidence_unavailable`, never
 * as a snapshot of current mutable state.
 *
 * @version v1
 */

import { z } from 'zod';
import { GitSha, ReviewRepositoryIdentity } from './evidence-review-subject.js';
import type { ReviewRepositoryIdentity as ReviewRepositoryIdentityValue } from './evidence-review-subject.js';
import type { ReviewRepositoryRevisionProvenance as ReviewRepositoryRevisionProvenanceValue } from './evidence-primitives.js';
import { RepositoryPathSchema } from './evidence-findings.js';

// ─── Frozen Revision Targets ──────────────────────────────────────────────────

/**
 * A frozen, content-addressed repository object that a review-evidence
 * revision resolves to.
 *
 * `commit` — an immutable commit in the frozen repository.
 * `tree` — a synthetically frozen, content-addressed worktree candidate
 *          (isolated-index `git write-tree`; never the live index).
 */
export const FrozenRepositoryRevisionTarget = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('commit'),
      repositoryIdentity: ReviewRepositoryIdentity,
      objectSha: GitSha,
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('tree'),
      repositoryIdentity: ReviewRepositoryIdentity,
      objectSha: GitSha,
    })
    .strict()
    .readonly(),
]);
export type FrozenRepositoryRevisionTarget = z.infer<typeof FrozenRepositoryRevisionTarget>;
export type FrozenRepositoryRevisionTargetValue = FrozenRepositoryRevisionTarget;

/**
 * Frozen repository authority carried by a repository-governed review
 * obligation.
 *
 * `candidate_pair` — implementation reviews: frozen pre-mutation `base` and
 *                    content-addressed worktree candidate `head`.
 * `context` — plan/architecture reviews: a single frozen repository context.
 *            `revision:'head'` resolves to the context; `revision:'base'` is
 *            unavailable (there is no frozen base side in a context).
 */
export const FrozenRepositoryAuthority = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('candidate_pair'),
      base: FrozenRepositoryRevisionTarget,
      head: FrozenRepositoryRevisionTarget,
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('context'),
      context: FrozenRepositoryRevisionTarget,
    })
    .strict()
    .readonly(),
]);
export type FrozenRepositoryAuthority = z.infer<typeof FrozenRepositoryAuthority>;
export type FrozenRepositoryAuthorityValue = FrozenRepositoryAuthority;

// ─── Observation Capability ────────────────────────────────────────────────────

/**
 * Opaque, host-minted observation capability bound to exactly one review
 * attempt. Carried to the reviewer via the canonical prompt and echoed back by
 * the sanctioned observation tool. The reviewer never chooses, edits, or
 * derives this value; it is routing, not reviewer authority.
 */
export const ObservationCapability = z
  .string()
  .regex(/^fgc_[a-f0-9]{64}$/)
  .readonly();
export type ObservationCapability = z.infer<typeof ObservationCapability>;

// ─── Observation Capture / Authoritative Observation ──────────────────────────

/** Hard size bound for a single repository observation (raw bytes). */
export const MAX_REPOSITORY_OBSERVATION_BYTES = 1024 * 1024;

/**
 * Child-side transport record appended to the capability-namespaced
 * observation ledger while the reviewer session runs. NOT governance
 * authority: the parent replay mints the authoritative `RepositoryObservation`
 * only after the completed reviewer child session is known.
 */
export const RepositoryObservationCapture = z
  .object({
    capabilityDigest: z.string().regex(/^[a-f0-9]{64}$/),
    path: RepositoryPathSchema,
    revision: z.enum(['base', 'head']),
    resolvedObjectSha: GitSha,
    repositoryIdentityDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    byteLength: z.number().int().nonnegative(),
    representation: z.enum(['utf8_text', 'binary']),
    acquisitionKind: z.enum(['local_git_object', 'remote_commit_blob']),
    responseDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    capturedAt: z.string().datetime(),
  })
  .strict()
  .readonly();
export type RepositoryObservationCapture = z.infer<typeof RepositoryObservationCapture>;

/**
 * Authoritative, attempt-bound repository observation. Minted EXCLUSIVELY by
 * the parent replay after the reviewer child session is known; a capture
 * alone never becomes authority.
 */
export const RepositoryObservation = z
  .object({
    observationId: z.string().uuid(),
    obligationId: z.string().uuid(),
    attemptId: z.string().uuid(),
    observedBySessionId: z.string().min(1),
    path: RepositoryPathSchema,
    revision: z.enum(['base', 'head']),
    repositoryIdentity: ReviewRepositoryIdentity,
    resolvedObjectSha: GitSha,
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    byteLength: z.number().int().nonnegative(),
    representation: z.enum(['utf8_text', 'binary']),
    capturedAt: z.string().datetime(),
    boundAt: z.string().datetime(),
    acquisition: z
      .object({ kind: z.enum(['local_git_object', 'remote_commit_blob']) })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
export type RepositoryObservation = z.infer<typeof RepositoryObservation>;

// ─── Authority Predicates and Resolution ───────────────────────────────────────

/** Minimal structural obligation shape the authority predicates operate on. */
export interface RepositoryAuthorityCarrier {
  readonly repositoryAuthority?: FrozenRepositoryAuthorityValue;
  readonly reviewSubject?: {
    readonly kind?: string;
    readonly baseRepository?: ReviewRepositoryIdentityValue;
    readonly headRepository?: ReviewRepositoryIdentityValue | null;
    readonly baseSha?: string;
    readonly headSha?: string;
  } | null;
}

/** True when the carrier holds frozen repository authority of any kind. */
export function hasFrozenRepositoryAuthority(carrier: RepositoryAuthorityCarrier): boolean {
  if (carrier.repositoryAuthority) return true;
  return carrier.reviewSubject?.kind === 'repository_change';
}

/**
 * Resolve the frozen revision target for a repository evidence revision.
 * Returns null when the revision is not backed by frozen authority — the
 * canonical "repository evidence unavailable" signal.
 */
export function resolveFrozenRevisionTarget(
  carrier: RepositoryAuthorityCarrier,
  revision: 'base' | 'head',
): FrozenRepositoryRevisionTargetValue | null {
  const authority = carrier.repositoryAuthority;
  if (authority) {
    if (authority.kind === 'candidate_pair') {
      return revision === 'base' ? authority.base : authority.head;
    }
    return revision === 'head' ? authority.context : null;
  }
  const subject = carrier.reviewSubject;
  if (
    subject?.kind === 'repository_change' &&
    subject.baseRepository &&
    subject.baseSha &&
    subject.headSha
  ) {
    const headSha: string = subject.headSha;
    const baseSha: string = subject.baseSha;
    const identity: ReviewRepositoryIdentityValue =
      revision === 'head'
        ? (subject.headRepository ?? subject.baseRepository)
        : subject.baseRepository;
    return {
      kind: 'commit',
      repositoryIdentity: identity,
      objectSha: revision === 'head' ? headSha : baseSha,
    };
  }
  return null;
}

/**
 * Canonical derivation of the legacy revision-provenance projection from
 * frozen authority. Provenance is a pure projection — never read from mutable
 * runtime state. When no frozen authority exists the derivation is
 * `unavailable`, which makes every repository evidence revision fail closed.
 */
export function deriveRepositoryRevisionProvenance(
  carrier: RepositoryAuthorityCarrier,
): ReviewRepositoryRevisionProvenanceValue {
  const authority = carrier.repositoryAuthority;
  if (authority?.kind === 'candidate_pair') {
    return {
      kind: 'available',
      headSha: authority.head.objectSha,
      baseSha: authority.base.objectSha,
    };
  }
  if (authority?.kind === 'context') {
    return { kind: 'available', headSha: authority.context.objectSha };
  }
  const subject = carrier.reviewSubject;
  if (subject?.kind === 'repository_change' && subject.headSha && subject.baseSha) {
    return {
      kind: 'available',
      headSha: subject.headSha,
      baseSha: subject.baseSha,
    };
  }
  return { kind: 'unavailable', reason: 'frozen_repository_authority_missing' };
}

/**
 * Canonical verification that a FrozenRepositoryAuthority is structurally
 * consistent: candidate_pair revisions must share the same repository
 * identity, and object SHAs must be well-formed.
 */
export function verifyFrozenRepositoryAuthority(
  authority: FrozenRepositoryAuthorityValue,
): string | null {
  if (authority.kind !== 'candidate_pair') return null;
  const base = authority.base.repositoryIdentity;
  const head = authority.head.repositoryIdentity;
  const baseIsLocal = 'kind' in base && base.kind === 'local';
  const headIsLocal = 'kind' in head && head.kind === 'local';
  if (baseIsLocal !== headIsLocal) {
    return 'candidate_pair revisions must share one repository identity kind';
  }
  if (baseIsLocal && headIsLocal) {
    return base.rootCommitDigest === head.rootCommitDigest
      ? null
      : 'candidate_pair local identities must share one rootCommitDigest';
  }
  if (!baseIsLocal && !headIsLocal) {
    const remoteBase = base as {
      readonly host: string;
      readonly owner: string;
      readonly name: string;
    };
    const remoteHead = head as {
      readonly host: string;
      readonly owner: string;
      readonly name: string;
    };
    return remoteBase.host === remoteHead.host &&
      remoteBase.owner === remoteHead.owner &&
      remoteBase.name === remoteHead.name
      ? null
      : 'candidate_pair revisions must share one remote repository identity';
  }
  return null;
}
