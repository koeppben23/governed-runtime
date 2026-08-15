/**
 * @module adapters/implementation-base-authority
 * @description Adapter-layer authority for the frozen pre-mutation
 *              implementation base and the single IMPLEMENTATION-entry
 *              finalizer.
 *
 * Ownership moved from `rails/repository-authority.ts` (rail-side freeze
 * point) into the adapter layer so the invariant
 *
 *   ANY state transition X → IMPLEMENTATION
 *   ⇒ implementationBaseAuthority is frozen
 *
 * is enforced at the single persistence boundary instead of per-rail.
 * `finalizeImplementationEntry` performs the freeze (idempotent, fail-closed);
 * the pure persistence-side guard `assertImplementationEntryFrozen` lives in
 * `implementation-entry-guard.ts` (dependency-free so the persistence module
 * can import it without creating an import cycle with the git adapter).
 *
 * Fail-closed semantics: an implementation review governs repository work, so
 * a session that cannot freeze its base must not persist an IMPLEMENTATION
 * state. The surfaced code is the canonical reason
 * `REVIEW_IMPLEMENTATION_BASE_FREEZE_FAILED` (registry:
 * `src/config/reasons-validation-observation.ts`).
 *
 * @version v1
 */

import { headCommitFull } from './git.js';
import { FrozenRepositoryError, freezeRepositoryIdentity } from './frozen-repository.js';
import { IMPLEMENTATION_BASE_FREEZE_FAILED_CODE } from './implementation-entry-guard.js';
import type { SessionState } from '../state/schema.js';
import type { FrozenRepositoryRevisionTarget } from '../state/evidence.js';

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
 * Freeze the pre-mutation implementation base. Runs at the transition INTO
 * `IMPLEMENTATION`, before any governed mutation. Throws
 * {@link FrozenRepositoryError} on failure — callers must block fail-closed.
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
 * Idempotently ensure the pre-mutation implementation base is frozen on the
 * session state. Re-entries (CHANGES_REQUESTED loops, CHECK_FAILED routes)
 * preserve the original base. Throws {@link FrozenRepositoryError} when the
 * freeze fails.
 */
export async function ensureImplementationBase(
  state: SessionState,
  worktree: string,
): Promise<SessionState> {
  if (state.implementationBaseAuthority) return state;
  const base = await freezeImplementationBaseAuthority(worktree);
  return { ...state, implementationBaseAuthority: base };
}

/**
 * Single transition finalizer for entering IMPLEMENTATION. Invoked by the
 * governed persistence path BEFORE any state serialization; idempotent and a
 * no-op for every other phase. On freeze failure it throws an error carrying
 * the canonical reason code so tool boundaries render the registered recovery
 * guidance.
 */
export async function finalizeImplementationEntry(state: SessionState): Promise<SessionState> {
  if (state.phase !== 'IMPLEMENTATION' || state.implementationBaseAuthority) return state;
  try {
    return await ensureImplementationBase(state, state.binding.worktree);
  } catch (err) {
    if (err instanceof FrozenRepositoryError) {
      throw Object.assign(new Error(err.message), {
        code: IMPLEMENTATION_BASE_FREEZE_FAILED_CODE,
      });
    }
    throw err;
  }
}
