/**
 * @module audit/proofgraph/assertion-evidence-binding
 * @description Single authority for assertion evidence binding decisions.
 *
 * Evaluates whether a validation result's structured assertion extraction
 * satisfies a specific CounterexampleRequirement. Separates identity/capability
 * binding from freshness evaluation — freshness is decided by the caller using
 * isFresh() / ProofProviderBinding after a successful bind.
 *
 * Fail-closed: any mismatch or missing capability returns a typed rejection.
 * check_only evidence can never bind assertion-level requirements.
 *
 * @version v1
 */

import type { CounterexampleRequirement } from '../../state/proofgraph.js';
import type { AssertionExtractionResult } from '../../state/evidence-validation.js';
import type { AssertionIdentity, ProviderId } from '../../state/assertion-identity.js';
import type { StructuredAssertionEvidence } from '../../state/evidence-validation.js';

// ─── Decision Types ─────────────────────────────────────────────────────────

export type AssertionBindingDecision =
  | {
      readonly status: 'bound';
      readonly assertion: StructuredAssertionEvidence;
      readonly attemptId: string;
      readonly bindingCapability: 'assertion';
    }
  | {
      readonly status: 'missing';
      readonly reason: 'evidence_missing' | 'check_only_evidence';
    }
  | {
      readonly status: 'provider_mismatch';
      readonly required: ProviderId;
      readonly actual: ProviderId;
    }
  | {
      readonly status: 'assertion_mismatch';
      readonly required: AssertionIdentity;
      readonly found: readonly string[];
    }
  | {
      readonly status: 'check_mismatch';
      readonly required: string;
      readonly actual: string;
    }
  | {
      readonly status: 'invalid';
      readonly reason: string;
    };

// ─── Public API ──────────────────────────────────────────────────────────────

export function bindAssertionEvidence(
  requirement: CounterexampleRequirement,
  extraction: AssertionExtractionResult,
  attemptId: string,
): AssertionBindingDecision {
  if (extraction.status !== 'extracted') {
    return { status: 'missing', reason: 'evidence_missing' };
  }

  if (extraction.bindingCapability !== 'assertion') {
    return { status: 'missing', reason: 'check_only_evidence' };
  }

  if (extraction.providerId !== requirement.assertion.providerId) {
    return {
      status: 'provider_mismatch',
      required: requirement.assertion.providerId,
      actual: extraction.providerId,
    };
  }

  const assertion = extraction.assertions.find(
    (a) => a.assertion.localId === requirement.assertion.localId,
  );

  if (!assertion) {
    return {
      status: 'assertion_mismatch',
      required: requirement.assertion,
      found: extraction.assertions.map((a) => a.assertion.localId),
    };
  }

  if (assertion.providerId !== requirement.assertion.providerId) {
    return {
      status: 'provider_mismatch',
      required: requirement.assertion.providerId,
      actual: assertion.providerId,
    };
  }

  return {
    status: 'bound',
    assertion,
    attemptId,
    bindingCapability: extraction.bindingCapability,
  };
}
