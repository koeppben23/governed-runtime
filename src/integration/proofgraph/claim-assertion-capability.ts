/** Positive and adversarial declarations use the same provider capability boundary. */
import type { AssertionIdentity } from '../../state/assertion-identity.js';
import type { VerificationCandidate } from '../../state/discovery-schemas.js';
import type { CounterexampleRequirement } from '../../state/proofgraph.js';
import {
  AGGREGATE_FORMATS_BY_PROVIDER,
  ASSERTION_CODEC_BY_PROVIDER,
  ASSERTION_FORMATS_BY_PROVIDER,
} from '../../providers/registry.js';

/** Public field plus actionable detail for an unreachable assertion. */
export interface AssertionCapabilityFailure {
  /** Counterexample-relative field; positive callers remap to their own field. */
  readonly field: string;
  readonly detail: string;
}

export function assertionCapabilityFailure(
  candidate: VerificationCandidate | undefined,
  assertion: AssertionIdentity,
): AssertionCapabilityFailure | null {
  if (!candidate)
    return {
      field: 'counterexampleRequirement.checkId',
      detail: 'the declared check has no active verification candidate',
    };
  if (candidate.assertionCapability !== 'structured')
    return {
      field: 'counterexampleRequirement.checkId',
      detail: `check '${candidate.kind}' has assertionCapability='${candidate.assertionCapability}', cannot produce assertion evidence for provider '${assertion.providerId}'`,
    };
  const report = candidate.assertionReport;
  if (!report)
    return {
      field: 'counterexampleRequirement',
      detail: `check '${candidate.kind}' is structured but has no assertionReport`,
    };
  if (report.providerId !== assertion.providerId)
    return {
      field: 'counterexampleRequirement.assertion.providerId',
      detail: `check produces assertions from '${report.providerId}', claim requires '${assertion.providerId}'`,
    };
  if (!ASSERTION_FORMATS_BY_PROVIDER.get(assertion.providerId)?.has(report.format))
    return {
      field: 'counterexampleRequirement.assertion.providerId',
      detail: `format '${report.format}' from provider '${assertion.providerId}' is not assertion-binding-capable`,
    };
  const codec = ASSERTION_CODEC_BY_PROVIDER.get(assertion.providerId);
  if (!codec)
    return {
      field: 'counterexampleRequirement.assertion.providerId',
      detail: `provider '${assertion.providerId}' has no registered identity codec`,
    };
  return codec.validateLocalId(assertion.localId)
    ? null
    : {
        field: 'counterexampleRequirement.assertion.localId',
        detail: `'${assertion.localId}' is not a valid assertion identity for provider '${assertion.providerId}'`,
      };
}

function aggregateCapabilityFailure(
  requirement: Extract<CounterexampleRequirement, { kind: 'aggregate_check' }>,
  candidate: VerificationCandidate,
  aggregateFormatsByProvider: ReadonlyMap<string, ReadonlySet<string>>,
): AssertionCapabilityFailure | null {
  if (candidate.assertionCapability !== 'structured')
    return {
      field: 'counterexampleRequirement.checkId',
      detail: `check '${requirement.checkId}' has assertionCapability='${candidate.assertionCapability}', cannot produce aggregate evidence`,
    };
  const report = candidate.assertionReport;
  const formats = report && aggregateFormatsByProvider.get(report.providerId);
  if (report && formats?.has(report.format) && candidate.fullCheckScopeAttestation === 'full_check')
    return null;
  if (report && formats?.has(report.format))
    return {
      field: 'counterexampleRequirement',
      detail: `check '${requirement.checkId}' has aggregate parsing capability but no explicit full-check scope completeness attestation`,
    };
  return {
    field: 'counterexampleRequirement',
    detail: `check '${requirement.checkId}' has no registered aggregate counterexample capability for its assertion report provider and format`,
  };
}

/** One capability decision shared by admission and binding. */
export function counterexampleCapabilityFailure(input: {
  readonly requirement: CounterexampleRequirement;
  readonly candidate: VerificationCandidate | undefined;
  readonly aggregateFormatsByProvider?: ReadonlyMap<string, ReadonlySet<string>>;
}): AssertionCapabilityFailure | null {
  const { requirement, candidate } = input;
  if (!candidate)
    return {
      field: 'counterexampleRequirement.checkId',
      detail: `counterexample check '${requirement.checkId}' is not in active verification candidates`,
    };
  if (requirement.kind === 'aggregate_check')
    return aggregateCapabilityFailure(
      requirement,
      candidate,
      input.aggregateFormatsByProvider ?? AGGREGATE_FORMATS_BY_PROVIDER,
    );
  return assertionCapabilityFailure(candidate, requirement.assertion);
}
