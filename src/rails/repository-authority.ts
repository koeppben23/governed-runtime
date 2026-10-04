/**
 * @module rails/repository-authority
 * @description Freeze-time repository authority construction for
 *              repository-governed review obligations.
 *
 * The single rail-side authority for creating frozen repository revision
 * targets. Every function here runs at a FREEZE point (candidate creation or
 * phase entry) and never again afterwards — mutable revision resolution after
 * the freeze is forbidden by the architecture guard.
 *
 * Fail-closed semantics:
 * - plan/architecture context freezing tolerates a missing repository
 *   (content-only reviews remain legitimate) by returning a typed
 *   {@link RepositoryAuthorityFreezeResult} whose `unavailable` variant
 *   carries the exact reason and diagnostic; repository evidence is then
 *   permanently `evidence_unavailable`, and the outcome is frozen onto the
 *   obligation as durable audit evidence.
 * - the implementation base freeze and the IMPLEMENTATION-entry invariant
 *   live in the adapter-layer authority
 *   `adapters/implementation-base-authority.ts` and are enforced at the
 *   persistence boundary — rails no longer duplicate that enforcement.
 *
 * @version v2
 */

import { GitError, headCommitFullStrict } from '../adapters/git.js';
import { FrozenRepositoryError, freezeWorktreeCandidate } from '../adapters/frozen-repository.js';
import type { SessionState } from '../state/schema.js';
import type { FrozenRepositoryAuthority } from '../state/evidence.js';
import type {
  RepositoryEvidenceFreeze,
  RepositoryEvidenceFreezeReason,
} from '../state/evidence-review-freeze.js';

// Single source of truth for commit-kind revision targets and the
// pre-mutation implementation-base freeze: the adapter-layer authority
// `adapters/implementation-base-authority.ts`, which also hosts the
// IMPLEMENTATION-entry finalizer. Rails re-export the revision-target freeze
// so context freezes (plan/architecture) keep a single definition; the
// implementation-entry enforcement itself lives exclusively at the
// persistence boundary.
export { freezeCommitRevisionTarget } from '../adapters/implementation-base-authority.js';
import { freezeCommitRevisionTarget } from '../adapters/implementation-base-authority.js';

/** Why a plan/architecture repository context could not be frozen. */
export type RepositoryAuthorityFreezeReason = RepositoryEvidenceFreezeReason;

/**
 * Typed freeze outcome for plan/architecture repository context. `unavailable`
 * never blocks the artifact review itself — repository evidence simply becomes
 * unavailable — but the cause is explicit, observable in responses, and
 * durable once frozen onto the obligation.
 */
export type RepositoryAuthorityFreezeResult =
  | { readonly kind: 'available'; readonly authority: FrozenRepositoryAuthority }
  | {
      readonly kind: 'unavailable';
      readonly reason: RepositoryAuthorityFreezeReason;
      readonly diagnostic?: string;
    };

/** Extract the frozen authority from a typed freeze result, if available. */
export function frozenAuthorityOrUndefined(
  result: RepositoryAuthorityFreezeResult,
): FrozenRepositoryAuthority | undefined {
  return result.kind === 'available' ? result.authority : undefined;
}

/**
 * Durable obligation record of a freeze outcome: the exact cause of a
 * degradation is persisted, not only rendered into the immediate response.
 */
export function freezeOutcomeRecord(
  result: RepositoryAuthorityFreezeResult,
): RepositoryEvidenceFreeze {
  if (result.kind === 'available') return { kind: 'available' };
  return {
    kind: 'unavailable',
    reason: result.reason,
    ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
  };
}

/**
 * Freeze a single-context repository authority (plan / architecture
 * obligations). `revision:'head'` resolves against the context; `'base'` is
 * unavailable. Degradation is typed and audit-friendly: the review itself is
 * never blocked, but the absence of repository evidence is explicit.
 */
export function freezeContextAuthority(
  worktree: string,
  objectSha: string,
): RepositoryAuthorityFreezeResult {
  try {
    return {
      kind: 'available',
      authority: {
        kind: 'context',
        context: freezeCommitRevisionTarget(worktree, objectSha),
      },
    };
  } catch (err) {
    const identityFailure =
      err instanceof FrozenRepositoryError && err.code === 'IDENTITY_UNAVAILABLE';
    return {
      kind: 'unavailable',
      reason: identityFailure ? 'repository_identity_unavailable' : 'freeze_failed',
      diagnostic: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Freeze-time resolution of the CURRENT commit as a plan/architecture
 * repository context. This is the ONLY sanctioned place outside the adapter
 * layer that resolves the mutable HEAD — it is the freeze point itself.
 * Returns a typed `unavailable` result when the repository, its HEAD, or the
 * immutable identity cannot be frozen (repository evidence becomes
 * unavailable; the artifact review itself remains legitimate).
 */
export async function freezeContextAuthorityAtHead(
  worktree: string,
): Promise<RepositoryAuthorityFreezeResult> {
  try {
    const objectSha = await headCommitFullStrict(worktree);
    if (objectSha) return freezeContextAuthority(worktree, objectSha);
    return {
      kind: 'unavailable',
      reason: 'head_unavailable',
      diagnostic: 'No resolvable HEAD commit exists in the repository.',
    };
  } catch (err) {
    if (err instanceof GitError && err.code === 'NOT_GIT_REPO') {
      return {
        kind: 'unavailable',
        reason: 'repository_unavailable',
        diagnostic: 'Workspace is not a Git repository.',
      };
    }
    return {
      kind: 'unavailable',
      reason: 'freeze_failed',
      diagnostic: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Freeze the implementation candidate pair: the persisted pre-mutation base
 * plus a content-addressed worktree candidate head materialized through an
 * isolated index. Returns `undefined` when the base authority is missing or
 * the candidate cannot be frozen — repository evidence becomes unavailable,
 * never approximated from mutable state.
 */
export async function freezeCandidatePairAuthority(
  state: SessionState,
  worktree: string,
): Promise<FrozenRepositoryAuthority | undefined> {
  const base = state.implementationBaseAuthority;
  if (!base) return undefined;
  try {
    const treeSha = await freezeWorktreeCandidate(worktree, base.objectSha);
    return {
      kind: 'candidate_pair',
      base,
      head: {
        kind: 'tree',
        repositoryIdentity: base.repositoryIdentity,
        objectSha: treeSha,
      },
    };
  } catch {
    return undefined;
  }
}
