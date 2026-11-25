/**
 * @module integration/opencode-governance-dispatch-cache
 * @description In-memory dispatch lifecycle: pending selection and retirement.
 * The durable activation store, not these maps, remains the anti-replay authority.
 */
import type { GovernanceDelegationDispatch } from '../state/governance-activation.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';

type LinkedDispatch = { readonly dispatchKey: string; readonly operation: Promise<void> };

/** Bounded identities only; the durable activation store remains anti-replay
 * authority, so old tombstones can be evicted after a safe cap. */
export const MAX_ENROLLED_REVIEWER_BINDINGS = 4_096;

export interface NativeDispatchMemory {
  readonly dispatches: Map<string, GovernanceDelegationDispatch>;
  readonly dispatchChildren: Map<string, string>;
  readonly linking: Map<string, LinkedDispatch>;
  readonly settledReviewerDispatches: Set<string>;
  /** Reviewer dispatch identities whose child enrollment must stay bindable. */
  readonly enrolledReviewerDispatchKeys: Set<string>;
}

function rememberBounded(set: Set<string>, key: string): void {
  set.delete(key);
  set.add(key);
  while (set.size > MAX_ENROLLED_REVIEWER_BINDINGS) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

export function hasPendingDispatchInMemory(
  memory: NativeDispatchMemory,
  parentId: string,
): boolean {
  for (const [key, dispatch] of memory.dispatches) {
    if (dispatch.sessionId === parentId && !memory.settledReviewerDispatches.has(key)) return true;
  }
  return false;
}

/** Settled reviewer identities remain authoritative but consume no pending slots. */
// prettier-ignore
export function pendingDispatchCountInMemory(
  memory: NativeDispatchMemory,
  rootId: string,
): number {
  return [...memory.dispatches.entries()].filter(
    ([key, dispatch]) =>
      dispatch.rootSessionId === rootId && !memory.settledReviewerDispatches.has(key),
  ).length;
}

export function pendingContinuationInMemory(
  memory: NativeDispatchMemory,
  childId: string,
): string | undefined {
  for (const [key, dispatch] of memory.dispatches) {
    if (
      dispatch.requestedChildSessionId === childId &&
      !memory.settledReviewerDispatches.has(key)
    ) {
      return key;
    }
  }
  return undefined;
}

/** Remove a quarantined reviewer intent from every in-memory projection. */
export function quarantineReviewerDispatchMemory(
  memory: NativeDispatchMemory,
  dispatchKey: string,
): void {
  const dispatch = memory.dispatches.get(dispatchKey);
  const reviewer =
    dispatch?.agent === REVIEWER_SUBAGENT_TYPE ||
    memory.enrolledReviewerDispatchKeys.has(dispatchKey);
  if (!reviewer) return;
  memory.dispatches.delete(dispatchKey);
  memory.dispatchChildren.delete(dispatchKey);
  memory.settledReviewerDispatches.delete(dispatchKey);
  memory.enrolledReviewerDispatchKeys.delete(dispatchKey);
}

/** Do not retire reviewer identity while its enrolled child is governed.
 * Ordinary and failed attempts release immediately; persistent replay checks
 * remain intact independent of process lifetime. */
export function retireSettledDispatch(
  memory: NativeDispatchMemory,
  dispatchKey: string,
  childId: string,
  enrolled: boolean,
): void {
  const dispatch = memory.dispatches.get(dispatchKey);
  if (enrolled && dispatch?.agent === REVIEWER_SUBAGENT_TYPE) {
    // Keep only the identity needed to prove the enrolled child's dispatch
    // binding. The full dispatch body and durable anti-replay record are not
    // duplicated in memory.
    rememberBounded(memory.settledReviewerDispatches, dispatchKey);
    rememberBounded(memory.enrolledReviewerDispatchKeys, dispatchKey);
    memory.dispatches.delete(dispatchKey);
  } else {
    memory.dispatches.delete(dispatchKey);
    memory.settledReviewerDispatches.delete(dispatchKey);
    memory.enrolledReviewerDispatchKeys.delete(dispatchKey);
  }
  memory.dispatchChildren.delete(dispatchKey);
  if (memory.linking.get(childId)?.dispatchKey === dispatchKey) memory.linking.delete(childId);
}
