/**
 * @module audit/proofgraph/assertion-evidence-binding
 * @description Single authority for assertion evidence binding decisions.
 *
 * Evaluates whether a validation result's structured assertion extraction
 * satisfies a specific CounterexampleRequirement. Handles all aspects of
 * the binding decision — checkId matching, provider matching, assertion
 * identity matching, explicit claim-statement coverage, and capability checking.
 *
 * @version v2
 */

import type { CounterexampleRequirement } from '../../state/proofgraph.js';
import type { AssertionExtractionResult } from '../../state/evidence-validation.js';
import type { StructuredAssertionEvidence } from '../../state/evidence-validation.js';
import type { AssertionBindingReasonCode } from '../../state/proofgraph.js';
import type { AssertionIdentity } from '../../state/assertion-identity.js';

export type { AssertionBindingReasonCode };

export type AssertionBindingDecision =
  | {
      readonly status: 'bound';
      readonly assertion: StructuredAssertionEvidence;
      readonly attemptId: string;
      readonly bindingCapability: 'assertion';
    }
  | {
      readonly status: 'rejected';
      readonly reasonCode: AssertionBindingReasonCode;
      readonly detail: string;
    };

export interface AssertionBindingRequest {
  readonly requirement: CounterexampleRequirement;
  readonly checkId: string;
  readonly extraction: AssertionExtractionResult | undefined;
  /** Claim statement that the provider-reported assertion must cover exactly. */
  readonly claimStatement?: string;
}

type AssertionRequirement = {
  readonly checkId: string;
  readonly assertion: AssertionIdentity;
};

function describeMissingExtraction(extraction: AssertionExtractionResult | undefined): string {
  if (!extraction) return 'no extraction result available';
  if (extraction.status === 'blocked')
    return `extraction blocked: ${'reason' in extraction ? extraction.reason : 'unknown'}`;
  if (extraction.status === 'inconclusive')
    return `extraction inconclusive: ${'reason' in extraction ? extraction.reason : 'unknown'}`;
  if (extraction.status === 'not_configured')
    return 'no structured assertion capability configured';
  return `extraction status: ${extraction.status}`;
}

function validatePreconditions(request: AssertionBindingRequest): AssertionBindingDecision | null {
  const { requirement, checkId, extraction } = request;

  // Legacy assertion requirements have no kind discriminator. Only the explicit
  // aggregate variant lacks an assertion identity and cannot bind here.
  if (!('assertion' in requirement)) {
    return {
      status: 'rejected',
      reasonCode: 'evidence_missing',
      detail: 'counterexample requirement does not bind a specific assertion',
    };
  }

  if (checkId !== requirement.checkId) {
    return {
      status: 'rejected',
      reasonCode: 'check_mismatch',
      detail: `expected check '${requirement.checkId}', got '${checkId}'`,
    };
  }

  if (!extraction || extraction.status !== 'extracted') {
    return {
      status: 'rejected',
      reasonCode: 'evidence_missing',
      detail: describeMissingExtraction(extraction),
    };
  }

  if (extraction.bindingCapability !== 'assertion') {
    return {
      status: 'rejected',
      reasonCode: 'check_only_evidence',
      detail: `check '${checkId}' only provides check-level evidence`,
    };
  }

  return null;
}

function matchAssertion(
  requirement: AssertionRequirement,
  extraction: AssertionExtractionResult & { status: 'extracted' },
  claimStatement: string | undefined,
): AssertionBindingDecision {
  if (extraction.providerId !== requirement.assertion.providerId) {
    return {
      status: 'rejected',
      reasonCode: 'provider_mismatch',
      detail: `required '${requirement.assertion.providerId}', got '${extraction.providerId}'`,
    };
  }

  const assertion = extraction.assertions.find(
    (a) => a.assertion.localId === requirement.assertion.localId,
  );

  if (!assertion) {
    const found = extraction.assertions.map((a) => a.assertion.localId);
    return {
      status: 'rejected',
      reasonCode: 'assertion_mismatch',
      detail: `required '${requirement.assertion.localId}' not found; found: ${found.join(', ') || 'none'}`,
    };
  }

  if (assertion.providerId !== requirement.assertion.providerId) {
    return {
      status: 'rejected',
      reasonCode: 'provider_mismatch',
      detail: `required '${requirement.assertion.providerId}', assertion belongs to '${assertion.providerId}'`,
    };
  }

  if (claimStatement !== undefined && assertion.testName !== claimStatement) {
    return {
      status: 'rejected',
      reasonCode: 'assertion_mismatch',
      detail:
        `assertion '${assertion.testName}' does not exactly cover claim statement ` +
        `'${claimStatement}'`,
    };
  }

  return {
    status: 'bound',
    assertion,
    attemptId: extraction.attemptId,
    bindingCapability: extraction.bindingCapability as 'assertion',
  };
}

export function bindAssertionEvidence(request: AssertionBindingRequest): AssertionBindingDecision {
  const precondition = validatePreconditions(request);
  if (precondition) return precondition;
  return matchAssertion(
    request.requirement as AssertionRequirement,
    request.extraction as AssertionExtractionResult & { status: 'extracted' },
    request.claimStatement,
  );
}
