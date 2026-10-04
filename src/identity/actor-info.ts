/**
 * @module identity/actor-info
 * @description Canonical actor identity comparison utilities.
 *
 * Actor assurance vocabulary, schema, and ordering are owned solely by
 * `shared/actor-assurance.ts`. This module no longer defines or re-exports
 * them: production consumers import the authority directly.
 *
 * @version v2
 */

export interface ActorIdentityComparable {
  readonly actorId?: string | null;
}

export type ActorIdentityComparison = 'same' | 'different' | 'uncomparable';

export function normalizeActorId(actorId: string | null | undefined): string | null {
  // NFC intentionally covers canonical equivalence without broad confusable folding.
  const normalized = actorId?.trim().normalize('NFC').toLowerCase();
  return normalized ? normalized : null;
}

export function compareActorIdentity(
  left: ActorIdentityComparable | null | undefined,
  right: ActorIdentityComparable | null | undefined,
): ActorIdentityComparison {
  const leftActorId = normalizeActorId(left?.actorId);
  const rightActorId = normalizeActorId(right?.actorId);
  if (!leftActorId || !rightActorId) return 'uncomparable';
  return leftActorId === rightActorId ? 'same' : 'different';
}

export function sameActorIdentity(
  left: ActorIdentityComparable | null | undefined,
  right: ActorIdentityComparable | null | undefined,
): boolean | null {
  const comparison = compareActorIdentity(left, right);
  if (comparison === 'uncomparable') return null;
  return comparison === 'same';
}
