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
import type { LocalRepositoryIdentity, RepositoryIdentity } from './evidence-review-subject.js';
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
 * `candidate_pair` — same-repository reviews (implementation, standalone
 *                    branch/PR): frozen pre-mutation/`base` and
 *                    content-addressed `head` targets sharing ONE repository
 *                    identity.
 * `fork_pair` — cross-repository PR reviews: `base` and `head` live in
 *                    distinct repositories (a fork). Both revisions must be
 *                    remote identities on the same host; neither side may be
 *                    silently re-pointed at the other repository.
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
      kind: z.literal('fork_pair'),
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
    /**
     * Host-visible identity of the session that EXECUTED the observation tool
     * call. Recorded at capture time from the tool context — never invented
     * later. The parent replay drops any capture whose captured session does
     * not equal the actual reviewer child session; a parent-side tool call can
     * therefore never become reviewer observation authority.
     */
    capturedSessionId: z.string().min(1),
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
 *
 * Structural invariants (enforced at the type level):
 * - `utf8_text` REQUIRES a `lineCount` (line citations are only admissible
 *   against it);
 * - `binary` FORBIDS `lineCount` (line citations against binary content fail
 *   closed);
 * - `resolvedObjectKind` carries the frozen target kind (commit | tree) so the
 *   evidence binder can compare the COMPLETE resolved target.
 */
const RepositoryObservationBase = {
  observationId: z.string().uuid(),
  obligationId: z.string().uuid(),
  attemptId: z.string().uuid(),
  observedBySessionId: z.string().min(1),
  path: RepositoryPathSchema,
  revision: z.enum(['base', 'head']),
  repositoryIdentity: ReviewRepositoryIdentity,
  resolvedObjectSha: GitSha,
  resolvedObjectKind: z.enum(['commit', 'tree']),
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative(),
  capturedAt: z.string().datetime(),
  boundAt: z.string().datetime(),
  acquisition: z
    .object({ kind: z.enum(['local_git_object', 'remote_commit_blob']) })
    .strict()
    .readonly(),
};

export const RepositoryObservation = z.discriminatedUnion('representation', [
  z
    .object({
      ...RepositoryObservationBase,
      representation: z.literal('utf8_text'),
      lineCount: z.number().int().nonnegative(),
    })
    .strict()
    .readonly(),
  z
    .object({
      ...RepositoryObservationBase,
      representation: z.literal('binary'),
    })
    .strict()
    .readonly(),
]);
export type RepositoryObservation = z.infer<typeof RepositoryObservation>;

// ─── Authority Predicates and Resolution ───────────────────────────────────────

/**
 * Minimal structural obligation shape the authority predicates operate on.
 * The property tolerates an explicit `undefined` because Zod-optional inputs
 * may materialize the key with an undefined value.
 */
export interface RepositoryAuthorityCarrier {
  readonly repositoryAuthority?: FrozenRepositoryAuthorityValue | undefined;
}

/** True when the carrier holds frozen repository authority of any kind. */
export function hasFrozenRepositoryAuthority(carrier: RepositoryAuthorityCarrier): boolean {
  return carrier.repositoryAuthority !== undefined;
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
    if (authority.kind === 'candidate_pair' || authority.kind === 'fork_pair') {
      return revision === 'base' ? authority.base : authority.head;
    }
    return revision === 'head' ? authority.context : null;
  }
  return null;
}

/**
 * Canonical derivation of the revision-provenance projection from frozen
 * authority. Provenance is a pure projection — never read from mutable runtime
 * state. When no frozen authority exists the derivation is
 * `unavailable`, which makes every repository evidence revision fail closed.
 */
export function deriveRepositoryRevisionProvenance(
  carrier: RepositoryAuthorityCarrier,
): ReviewRepositoryRevisionProvenanceValue {
  const authority = carrier.repositoryAuthority;
  if (authority?.kind === 'candidate_pair' || authority?.kind === 'fork_pair') {
    return {
      kind: 'available',
      headSha: authority.head.objectSha,
      baseSha: authority.base.objectSha,
    };
  }
  if (authority?.kind === 'context') {
    return { kind: 'available', headSha: authority.context.objectSha };
  }
  return { kind: 'unavailable', reason: 'frozen_repository_authority_missing' };
}

/**
 * Canonical verification that a FrozenRepositoryAuthority is structurally
 * consistent.
 *
 * `candidate_pair` revisions must share the same repository identity.
 * `fork_pair` revisions must be two DISTINCT remote repositories on the same
 * host — the explicit representation of a cross-repository PR. A same-identity
 * pair must be expressed as `candidate_pair`, and a local side can never be
 * part of a fork pair.
 */
export function verifyFrozenRepositoryAuthority(
  authority: FrozenRepositoryAuthorityValue,
): string | null {
  if (authority.kind === 'context') return null;
  const base = authority.base.repositoryIdentity;
  const head = authority.head.repositoryIdentity;
  const baseIsLocal = isLocalRepositoryIdentity(base);
  const headIsLocal = isLocalRepositoryIdentity(head);
  if (baseIsLocal !== headIsLocal) {
    return `${authority.kind} revisions must share one repository identity kind`;
  }
  return authority.kind === 'fork_pair'
    ? verifyForkPairAuthority(base, head)
    : verifyCandidatePairAuthority(base, head);
}

function isLocalRepositoryIdentity(
  identity: ReviewRepositoryIdentity,
): identity is LocalRepositoryIdentity {
  return 'kind' in identity && identity.kind === 'local';
}

function isRemoteRepositoryIdentity(
  identity: ReviewRepositoryIdentity,
): identity is RepositoryIdentity {
  return !('kind' in identity);
}

function verifyForkPairAuthority(
  base: ReviewRepositoryIdentity,
  head: ReviewRepositoryIdentity,
): string | null {
  if (!isRemoteRepositoryIdentity(base) || !isRemoteRepositoryIdentity(head)) {
    return 'fork_pair revisions must be remote repository identities';
  }
  if (base.host !== head.host) {
    return 'fork_pair revisions must share one remote host';
  }
  return base.owner === head.owner && base.name === head.name
    ? 'fork_pair revisions must name distinct repositories (use candidate_pair for one repository)'
    : null;
}

function verifyCandidatePairAuthority(
  base: ReviewRepositoryIdentity,
  head: ReviewRepositoryIdentity,
): string | null {
  if (isLocalRepositoryIdentity(base) && isLocalRepositoryIdentity(head)) {
    return base.rootCommitDigest === head.rootCommitDigest
      ? null
      : 'candidate_pair local identities must share one rootCommitDigest';
  }
  if (isRemoteRepositoryIdentity(base) && isRemoteRepositoryIdentity(head)) {
    return base.host === head.host && base.owner === head.owner && base.name === head.name
      ? null
      : 'candidate_pair revisions must share one remote repository identity';
  }
  return null;
}
