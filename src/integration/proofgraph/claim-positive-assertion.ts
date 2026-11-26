/**
 * Structural reachability of a declared positive assertion.
 *
 * This is admission, never a verdict: a reachable assertion can still fail or
 * be semantically broader than the claim. The independent reviewer retains
 * that authority.
 */
import type { AssertionIdentity } from '../../state/assertion-identity.js';
import type { VerificationCandidate } from '../../state/discovery-schemas.js';
import {
  ASSERTION_CODEC_BY_PROVIDER,
  ASSERTION_FORMATS_BY_PROVIDER,
} from '../../providers/registry.js';

export interface PositiveAssertionFailure {
  readonly field: 'expectedAssertion';
  readonly detail: string;
}

function assertionFailure(
  candidate: VerificationCandidate,
  assertion: AssertionIdentity,
): string | null {
  if (candidate.assertionCapability !== 'structured')
    return `check '${candidate.kind}' has assertionCapability='${candidate.assertionCapability}', cannot produce assertion evidence for provider '${assertion.providerId}'`;
  const report = candidate.assertionReport;
  if (!report) return `check '${candidate.kind}' is structured but has no assertionReport`;
  if (report.providerId !== assertion.providerId)
    return `check '${candidate.kind}' produces assertions from '${report.providerId}', claim requires '${assertion.providerId}'`;
  if (!ASSERTION_FORMATS_BY_PROVIDER.get(assertion.providerId)?.has(report.format))
    return `format '${report.format}' from provider '${assertion.providerId}' is not assertion-binding-capable`;
  const codec = ASSERTION_CODEC_BY_PROVIDER.get(assertion.providerId);
  if (!codec) return `provider '${assertion.providerId}' has no registered identity codec`;
  if (!codec.validateLocalId(assertion.localId))
    return `'${assertion.localId}' is not a valid assertion identity for provider '${assertion.providerId}'`;
  return null;
}

/** The declared assertion must be reachable from at least one candidate of its positive check. */
export function positiveAssertionFailure(input: {
  readonly positiveCheckId: string;
  readonly expectedAssertion: AssertionIdentity;
  readonly verificationCandidates: readonly VerificationCandidate[];
}): PositiveAssertionFailure | null {
  const candidates = input.verificationCandidates.filter(
    (candidate) => candidate.kind === input.positiveCheckId,
  );
  if (candidates.length === 0)
    return {
      field: 'expectedAssertion',
      detail: `positive check '${input.positiveCheckId}' has no active verification candidate`,
    };
  const failures = candidates.map((candidate) =>
    assertionFailure(candidate, input.expectedAssertion),
  );
  if (failures.some((failure) => failure === null)) return null;
  return {
    field: 'expectedAssertion',
    detail: failures[0] ?? 'the declared positive assertion is unreachable',
  };
}
