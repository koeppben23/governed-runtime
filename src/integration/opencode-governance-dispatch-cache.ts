/**
 * @module integration/opencode-governance-dispatch-cache
 * @description In-memory dispatch lifecycle: pending selection and retirement.
 * The durable activation store, not these maps, remains the anti-replay authority.
 */
import type { GovernanceDelegationDispatch } from '../state/governance-activation.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';

type LinkedDispatch = { readonly dispatchKey: string; readonly operation: Promise<void> };

export interface NativeDispatchMemory {
  readonly dispatches: Map<string, GovernanceDelegationDispatch>;
  readonly dispatchChildren: Map<string, string>;
  readonly linking: Map<string, LinkedDispatch>;
  readonly settledReviewerDispatches: Set<string>;
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
    memory.settledReviewerDispatches.add(dispatchKey);
  } else {
    memory.dispatches.delete(dispatchKey);
    memory.settledReviewerDispatches.delete(dispatchKey);
  }
  memory.dispatchChildren.delete(dispatchKey);
  if (memory.linking.get(childId)?.dispatchKey === dispatchKey) memory.linking.delete(childId);
}
