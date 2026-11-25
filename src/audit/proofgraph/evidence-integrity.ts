/**
 * Qualify a cached projection against its actual referenced assertion observations.
 * Invalid evidence is re-evaluated by the EXISTING evaluator; this module does
 * not assign verification states, execute providers or mutate historical state.
 */
import type { SessionState } from '../../state/schema.js';
import type {
  DeclaredClaim,
  ProofClaim,
  ProofGraphProjection,
  ProofProviderResult,
  AssertionBindingReasonCode,
} from '../../state/proofgraph.js';
import { assessAssertionEvidenceIntegrity } from '../../state/assertion-evidence-integrity.js';
import { evaluateProofGraph } from './evaluate.js';
import { bindCounterexamples } from './counterexample-binder.js';
import {
  EXECUTED_TEST_PROVIDER_ID,
  EXECUTED_TEST_PROVIDER_VERSION,
} from './executed-test-binder.js';

export type ProofEvidenceIntegrityInput = {
  readonly contract: SessionState['proofContract'];
  readonly validationAttempts: SessionState['validationAttempts'];
  readonly implementationDigest: string | undefined;
};

function integrityFailures(
  projection: ProofGraphProjection,
  input: ProofEvidenceIntegrityInput,
): ReadonlyMap<string, AssertionBindingReasonCode> {
  const failures = new Map<string, AssertionBindingReasonCode>();
  for (const claim of [...(input.contract?.claims ?? []), ...projection.claims]) {
    const references = new Set(
      [...claim.evidenceRefs, ...claim.counterexampleRefs]
        .filter((ref) => ref.kind === 'validation_attempt')
        .map((ref) => ref.attemptId),
    );
    for (const attempt of input.validationAttempts) {
      if (
        attempt.scope !== 'implementation' ||
        attempt.implementationDigest !== input.implementationDigest ||
        !references.has(attempt.attemptId)
      )
        continue;
      const result = assessAssertionEvidenceIntegrity(attempt.result.assertionExtraction);
      if (result.kind === 'invalid' && failures.get(claim.claimId) !== 'provider_mismatch') {
        failures.set(claim.claimId, result.code);
      }
    }
  }
  return failures;
}

function declarationOf(claim: ProofClaim): DeclaredClaim {
  const { verificationState: _state, freshness: _freshness, ...declaration } = claim;
  return declaration;
}

function rejectedProvider(claimId: string, evaluatedAt: string): ProofProviderResult {
  return {
    claimId,
    providerKind: 'executed_test',
    providerId: EXECUTED_TEST_PROVIDER_ID,
    providerVersion: EXECUTED_TEST_PROVIDER_VERSION,
    input: {},
    status: 'unavailable',
    attestation: 'flowguard_executed',
    executedAt: evaluatedAt,
    detail: 'referenced assertion evidence failed its identity-integrity contract',
  };
}

export function assessProofGraphEvidence(
  projection: ProofGraphProjection,
  input: ProofEvidenceIntegrityInput,
): {
  readonly projection: ProofGraphProjection;
  readonly identityDiagnostics: ReadonlyMap<string, AssertionBindingReasonCode>;
} {
  const failures = integrityFailures(projection, input);
  if (failures.size === 0) return { projection, identityDiagnostics: failures };
  const counterexamples = bindCounterexamples(
    {
      proofContract: input.contract,
      validationAttempts: input.validationAttempts,
      implementation:
        input.implementationDigest === undefined ? null : { digest: input.implementationDigest },
    },
    projection.evaluatedAt,
  ).counterexamples;
  return {
    identityDiagnostics: failures,
    projection: {
      ...projection,
      // Evaluate each occurrence: duplicate claim ids must never collapse into a first/last map entry.
      claims: projection.claims.flatMap((claim) =>
        failures.has(claim.claimId)
          ? evaluateProofGraph(
              {
                claims: [declarationOf(claim)],
                providerResults: [rejectedProvider(claim.claimId, projection.evaluatedAt)],
                counterexamples,
                currentImplementationDigest: input.implementationDigest ?? null,
              },
              projection.evaluatedAt,
            ).claims
          : [claim],
      ),
      claimDiagnostics: { ...projection.claimDiagnostics, ...Object.fromEntries(failures) },
    },
  };
}
