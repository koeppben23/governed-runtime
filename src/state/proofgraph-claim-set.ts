/** Claim-set identity, shared by source authorization, contract coverage and enforcement. */
type IdentifiedClaim = { readonly claimId: string };

/** A set is usable only when every declaration has its own identity. */
export function uniqueClaimIds(claims: readonly IdentifiedClaim[]): ReadonlySet<string> | null {
  const ids = new Set(claims.map((claim) => claim.claimId));
  return ids.size === claims.length ? ids : null;
}

/** Count the COMPLETE collection, before any eligibility/provenance/criticality filtering. */
export function claimOccurrences(claims: readonly IdentifiedClaim[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const claim of claims) counts.set(claim.claimId, (counts.get(claim.claimId) ?? 0) + 1);
  return counts;
}

export function claimsMatchDeclaredSet(
  claims: readonly IdentifiedClaim[],
  ids: ReadonlySet<string>,
): boolean {
  const counts = claimOccurrences(claims);
  for (const id of ids) if (counts.get(id) !== 1) return false;
  return true;
}
