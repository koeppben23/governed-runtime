/**
 * @module integration/tools/reduced-ceremony-attestation
 * @description Integration-boundary worktree re-attestation for
 * reduced-ceremony approvals and export.
 *
 * The machine and rails stay filesystem-free: this helper re-enumerates the
 * frozen governed implementation bytes, recomputes the canonical digest and
 * returns a structural outcome the rails can check. It returns null when the
 * session is not a reduced-ceremony case (no waiver in play).
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import { reattestImplementationSubject } from '../../verification/implementation-subject.js';

export type ReducedCeremonySubjectAttestation =
  | { readonly kind: 'ok'; readonly digest: string }
  | { readonly kind: 'subject_changed'; readonly expected: string; readonly actual: string };

export async function attestReducedCeremonySubject(input: {
  readonly state: SessionState;
  readonly worktree: string;
  readonly digest: (text: string) => string;
}): Promise<ReducedCeremonySubjectAttestation | null> {
  const { state } = input;
  const implementation = state.implementation;
  if (implementation === null) return null;
  if (state.implReview !== null || state.reducedCeremony === null) return null;

  const result = await reattestImplementationSubject({
    worktree: input.worktree,
    frozenFiles: implementation.changedFiles,
    expectedDigest: implementation.digest,
    baseline: state.implementationBaseline,
    digest: input.digest,
  });
  return result.kind === 'ok'
    ? { kind: 'ok', digest: result.digest }
    : { kind: 'subject_changed', expected: result.expected, actual: result.actual };
}
