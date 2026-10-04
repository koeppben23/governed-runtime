/**
 * @module presentation/human-verification
 * @description Single vocabulary authority for ProofGraph verification states.
 *
 * Maps six canonical ClaimVerificationState values to five human-readable
 * status labels. UNPROVEN and NOT_VERIFIED compress to "Not verified" in the
 * default surface but remain diagnostically distinct. Only PROVEN maps to
 * "Verified"; all other states are explicitly non-verified.
 *
 * This is the sole module that may define canonical-state→human-label
 * mappings (enforced by the architecture SSOT guard). No renderer may
 * duplicate this vocabulary.
 *
 * @version v1
 */

import type { ClaimVerificationState } from '../state/proofgraph-primitives.js';

export type HumanVerificationStatus =
  'verified' | 'not_verified' | 'failed' | 'needs_recheck' | 'blocked';

interface HumanVerificationCopy {
  readonly label: string;
  readonly defaultExplanation: string;
}

const HUMAN_VERIFICATION_COPY: Readonly<Record<ClaimVerificationState, HumanVerificationCopy>> = {
  PROVEN: {
    label: 'Verified',
    defaultExplanation: 'FlowGuard has sufficient current evidence to satisfy this claim.',
  },
  UNPROVEN: {
    label: 'Not verified',
    defaultExplanation: 'The current evidence does not establish this claim.',
  },
  NOT_VERIFIED: {
    label: 'Not verified',
    defaultExplanation: 'Required evidence or provenance is missing, unavailable, or unresolved.',
  },
  CONTRADICTED: {
    label: 'Failed',
    defaultExplanation: 'Observed evidence contradicts this claim.',
  },
  STALE: {
    label: 'Needs re-check',
    defaultExplanation:
      'The evidence for this claim is no longer current for the active verification subject.',
  },
  BLOCKED: {
    label: 'Blocked',
    defaultExplanation:
      'Verification could not complete because the required evidence provider or execution path failed.',
  },
} as const;

export function projectHumanVerificationStatus(
  canonical: ClaimVerificationState,
): HumanVerificationStatus {
  switch (canonical) {
    case 'PROVEN':
      return 'verified';
    case 'UNPROVEN':
    case 'NOT_VERIFIED':
      return 'not_verified';
    case 'CONTRADICTED':
      return 'failed';
    case 'STALE':
      return 'needs_recheck';
    case 'BLOCKED':
      return 'blocked';
  }
}

export function humanVerificationLabel(canonical: ClaimVerificationState): string {
  return HUMAN_VERIFICATION_COPY[canonical].label;
}

export function humanVerificationExplanation(canonical: ClaimVerificationState): string {
  return HUMAN_VERIFICATION_COPY[canonical].defaultExplanation;
}
