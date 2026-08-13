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
 *   (content-only reviews remain legitimate) by returning `undefined`, which
 *   makes repository evidence permanently `evidence_unavailable`.
 * - implementation base freezing THROWS: an implementation review governs
 *   repository work, so a session that cannot freeze its base cannot
 *   authoritatively enter implementation review.
 *
 * @version v1
 */

import { headCommitFull } from '../adapters/git.js';
import {
  FrozenRepositoryError,
  freezeRepositoryIdentity,
  freezeWorktreeCandidate,
} from '../adapters/frozen-repository.js';
import type { SessionState } from '../state/schema.js';
import type {
  FrozenRepositoryAuthority,
  FrozenRepositoryRevisionTarget,
} from '../state/evidence.js';

/**
 * Freeze a commit-kind revision target: exact object sha plus the repository
 * identity resolved AT freeze time. Throws {@link FrozenRepositoryError} when
 * the identity cannot be resolved immutably.
 */
export function freezeCommitRevisionTarget(
  worktree: string,
  objectSha: string,
): FrozenRepositoryRevisionTarget {
  return {
    kind: 'commit',
    repositoryIdentity: freezeRepositoryIdentity(worktree, objectSha),
    objectSha,
  };
}

/**
 * Freeze a single-context repository authority (plan / architecture
 * obligations). `revision:'head'` resolves against the context; `'base'` is
 * unavailable. Returns `undefined` when the repository identity cannot be
 * frozen — repository evidence becomes unavailable, the review itself is not
 * blocked.
 */
export function freezeContextAuthority(
  worktree: string,
  objectSha: string,
): FrozenRepositoryAuthority | undefined {
  try {
    return {
      kind: 'context',
      context: freezeCommitRevisionTarget(worktree, objectSha),
    };
  } catch {
    return undefined;
  }
}

/**
 * Freeze-time resolution of the CURRENT commit as a plan/architecture
 * repository context. This is the ONLY sanctioned place outside the adapter
 * layer that resolves the mutable HEAD — it is the freeze point itself.
 * Returns `undefined` when the commit or identity cannot be frozen
 * (repository evidence becomes unavailable).
 */
export async function freezeContextAuthorityAtHead(
  worktree: string,
): Promise<FrozenRepositoryAuthority | undefined> {
  const objectSha = await headCommitFull(worktree);
  if (!objectSha) return undefined;
  return freezeContextAuthority(worktree, objectSha);
}

/**
 * Freeze the pre-mutation implementation base. Runs at the transition INTO
 * `IMPLEMENTATION`, before any governed mutation. Throws
 * {@link FrozenRepositoryError} on failure — callers must block the
 * transition fail-closed.
 */
export async function freezeImplementationBaseAuthority(
  worktree: string,
): Promise<FrozenRepositoryRevisionTarget> {
  const objectSha = await headCommitFull(worktree);
  if (!objectSha) {
    throw new FrozenRepositoryError(
      'FREEZE_FAILED',
      'No commit exists to freeze as the pre-mutation implementation base',
    );
  }
  return freezeCommitRevisionTarget(worktree, objectSha);
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

/**
 * Idempotently ensure the pre-mutation implementation base is frozen on the
 * session state. Called at every rail that can transition INTO
 * `IMPLEMENTATION`; re-entries (CHANGES_REQUESTED loops) preserve the original
 * base. Throws {@link FrozenRepositoryError} when the freeze fails.
 */
export async function ensureImplementationBase(
  state: SessionState,
  worktree: string,
): Promise<SessionState> {
  if (state.implementationBaseAuthority) return state;
  const base = await freezeImplementationBaseAuthority(worktree);
  return { ...state, implementationBaseAuthority: base };
}
