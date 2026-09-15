/**
 * Read the host-issued attestation attached to a review-requirement signal.
 */
export function signalAttestationOf(
  parsed: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const topLevel = parsed.requiredReviewAttestation;
  if (topLevel && typeof topLevel === 'object' && !Array.isArray(topLevel)) {
    return topLevel as Record<string, unknown>;
  }
  const reviewInvocation = parsed.reviewInvocation;
  if (
    reviewInvocation &&
    typeof reviewInvocation === 'object' &&
    !Array.isArray(reviewInvocation)
  ) {
    const nested = (reviewInvocation as Record<string, unknown>).requiredReviewAttestation;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }
  return undefined;
}

/** Host-issued attestation constants, or null when the signal carried none. */
export function readHostAttestationConstants(
  attestation: Record<string, unknown> | undefined,
): { mandateDigest: string; criteriaVersion: string } | null {
  const mandateDigest = attestation?.mandateDigest;
  const criteriaVersion = attestation?.criteriaVersion;
  if (typeof mandateDigest !== 'string' || mandateDigest.length === 0) return null;
  if (typeof criteriaVersion !== 'string' || criteriaVersion.length === 0) return null;
  return { mandateDigest, criteriaVersion };
}
