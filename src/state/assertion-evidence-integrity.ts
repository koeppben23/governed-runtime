/** Registry-free assertion integrity; no encoding, normalization, deduplication or observation mutation. */
import type { AssertionExtractionResult } from './evidence-validation.js';
import type { AssertionBindingReasonCode } from './proofgraph.js';

export type AssertionEvidenceIntegrity =
  | { readonly kind: 'valid' }
  | {
      readonly kind: 'invalid';
      readonly code: Extract<
        AssertionBindingReasonCode,
        'provider_mismatch' | 'assertion_identity_ambiguous'
      >;
      readonly detail: string;
    };

/** Only assertion-capable reports promise single-result identities; aggregate/check-only contracts are separate. */
export function assessAssertionEvidenceIntegrity(
  extraction: AssertionExtractionResult | undefined,
): AssertionEvidenceIntegrity {
  if (extraction === undefined) return { kind: 'valid' };
  const statusFailure = extractionStatusFailure(extraction);
  if (statusFailure !== undefined) return statusFailure;
  if (extraction.status !== 'extracted' || extraction.bindingCapability !== 'assertion') {
    return { kind: 'valid' };
  }
  return envelopeFailure(extraction) ?? duplicateIdentityFailure(extraction) ?? { kind: 'valid' };
}

type InvalidAssertionEvidence = Extract<AssertionEvidenceIntegrity, { kind: 'invalid' }>;
type ExtractedAssertionEvidence = Extract<AssertionExtractionResult, { status: 'extracted' }>;

function extractionStatusFailure(
  extraction: AssertionExtractionResult,
): InvalidAssertionEvidence | undefined {
  if (extraction.status !== 'inconclusive' && extraction.status !== 'blocked') {
    return undefined;
  }
  if (extraction.reasonCode === 'assertion_identity_ambiguous') {
    return { kind: 'invalid', code: 'assertion_identity_ambiguous', detail: extraction.reason };
  }
  if (extraction.reasonCode === 'assertion_provider_mismatch') {
    return { kind: 'invalid', code: 'provider_mismatch', detail: extraction.reason };
  }
  return undefined;
}

function envelopeFailure(
  extraction: ExtractedAssertionEvidence,
): InvalidAssertionEvidence | undefined {
  const envelope = extraction.assertions.find(
    (evidence) =>
      evidence.providerId !== extraction.providerId ||
      evidence.assertion.providerId !== extraction.providerId,
  );
  if (envelope === undefined) return undefined;
  return {
    kind: 'invalid',
    code: 'provider_mismatch',
    detail: `assertion '${envelope.assertion.localId}' belongs to provider '${envelope.assertion.providerId}' but extraction provider is '${extraction.providerId}'`,
  };
}

function duplicateIdentityFailure(
  extraction: ExtractedAssertionEvidence,
): InvalidAssertionEvidence | undefined {
  const identities = new Map<string, Set<string>>();
  for (const evidence of extraction.assertions) {
    const { providerId, localId } = evidence.assertion;
    const locals = identities.get(providerId) ?? new Set<string>();
    if (locals.has(localId)) {
      return {
        kind: 'invalid',
        code: 'assertion_identity_ambiguous',
        detail:
          'structured assertion extraction contains duplicate provider-scoped identities; no result may be selected by order',
      };
    }
    locals.add(localId);
    identities.set(providerId, locals);
  }
  return undefined;
}
