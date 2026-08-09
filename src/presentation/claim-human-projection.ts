/**
 * @module presentation/claim-human-projection
 * @description Human-facing claim projection and ProofGraph summary.
 *
 * Pure presentation layer: derives human status labels, explanations,
 * and evidence requirement copy from ClaimResolutionFacts. Defines
 * HumanProofSummary (counts + projected claims). Never inspects raw
 * evidence or recomputes satisfaction.
 *
 * @version v1
 */

import type { ClaimResolutionFacts, RequiredEvidenceProjection } from './claim-resolution.js';
import type { HumanVerificationStatus } from './human-verification.js';
import {
  projectHumanVerificationStatus,
  humanVerificationLabel,
  humanVerificationExplanation,
} from './human-verification.js';
import { BINDING_DIAGNOSTIC_COPY } from './claim-diagnostic-copy.js';
import type { AssertionBindingReasonCode } from '../state/proofgraph.js';
import {
  humanRequiredEvidenceText,
  humanCounterexampleRequirementText,
} from './proof-requirement-copy.js';

export interface ClaimHumanProjection {
  readonly claimId: string;
  readonly statement: string;
  readonly status: HumanVerificationStatus;
  readonly statusLabel: string;
  readonly critical: boolean;
  readonly explanation: string;
  readonly requiredEvidenceLabel?: string;
  readonly counterexampleRequirementLabel?: string;
  readonly diagnostic: ClaimDiagnosticProjection;
}

export interface ClaimDiagnosticProjection {
  readonly canonicalState: string;
  readonly bindingReason?: AssertionBindingReasonCode;
  readonly claimScope?: 'specific_behavior' | 'suite';
  readonly candidateId?: string;
  readonly freshness?: {
    readonly boundDigest: string;
    readonly evaluatedAt: string;
    readonly stale: boolean;
  };
  readonly requiredEvidence?: {
    readonly positive: readonly string[];
    readonly adversarial: readonly string[];
  };
}

export interface HumanProofSummary {
  readonly total: number;
  readonly verified: number;
  readonly notVerified: number;
  readonly failed: number;
  readonly needsRecheck: number;
  readonly blocked: number;
  readonly criticalTotal: number;
  readonly criticalVerified: number;
  readonly claims: readonly ClaimHumanProjection[];
}

function buildExplanation(facts: ClaimResolutionFacts): string {
  const stateExp = humanVerificationExplanation(facts.verificationState);
  if (facts.bindingDiagnostic && facts.verificationState !== 'PROVEN') {
    const diag = BINDING_DIAGNOSTIC_COPY[facts.bindingDiagnostic];
    if (diag) return diag.explanation;
  }
  return stateExp;
}

function extractRequiredEvidenceLabel(facts: ClaimResolutionFacts): string | undefined {
  if (!facts.requiredEvidence) return undefined;
  if (facts.requiredEvidence.positive.length === 0) return undefined;
  return humanRequiredEvidenceText(facts.requiredEvidence.positive);
}

function extractCandidateId(facts: ClaimResolutionFacts): string | undefined {
  const cr = facts.counterexampleRequirement;
  if (cr?.kind === 'aggregate_check' && cr.candidateId) {
    return cr.candidateId;
  }
  return undefined;
}

function toDiagnosticProjection(facts: ClaimResolutionFacts): ClaimDiagnosticProjection {
  const re: RequiredEvidenceProjection | undefined = facts.requiredEvidence;
  return {
    canonicalState: facts.verificationState,
    ...(facts.bindingDiagnostic !== undefined ? { bindingReason: facts.bindingDiagnostic } : {}),
    ...(facts.claimScope !== undefined ? { claimScope: facts.claimScope } : {}),
    ...(extractCandidateId(facts) !== undefined ? { candidateId: extractCandidateId(facts) } : {}),
    ...(facts.freshness !== undefined ? { freshness: facts.freshness } : {}),
    ...(re !== undefined
      ? { requiredEvidence: { positive: re.positive, adversarial: re.adversarial } }
      : {}),
  };
}

export function projectClaimHumanProjection(facts: ClaimResolutionFacts): ClaimHumanProjection {
  return {
    claimId: facts.claimId,
    statement: facts.statement,
    status: projectHumanVerificationStatus(facts.verificationState),
    statusLabel: humanVerificationLabel(facts.verificationState),
    critical: facts.critical,
    explanation: buildExplanation(facts),
    ...(extractRequiredEvidenceLabel(facts) !== undefined
      ? { requiredEvidenceLabel: extractRequiredEvidenceLabel(facts) }
      : {}),
    ...(facts.counterexampleRequirement !== undefined
      ? {
          counterexampleRequirementLabel: humanCounterexampleRequirementText(
            facts.counterexampleRequirement,
          ),
        }
      : {}),
    diagnostic: toDiagnosticProjection(facts),
  };
}

export function projectHumanProofSummary(
  facts: readonly ClaimResolutionFacts[],
): HumanProofSummary {
  const projected = facts.map(projectClaimHumanProjection);
  let verified = 0;
  let notVerified = 0;
  let failed = 0;
  let needsRecheck = 0;
  let blocked = 0;
  let criticalTotal = 0;
  let criticalVerified = 0;

  for (const p of projected) {
    if (p.critical) {
      criticalTotal += 1;
      if (p.status === 'verified') criticalVerified += 1;
    }
    switch (p.status) {
      case 'verified':
        verified += 1;
        break;
      case 'not_verified':
        notVerified += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      case 'needs_recheck':
        needsRecheck += 1;
        break;
      case 'blocked':
        blocked += 1;
        break;
    }
  }

  return {
    total: projected.length,
    verified,
    notVerified,
    failed,
    needsRecheck,
    blocked,
    criticalTotal,
    criticalVerified,
    claims: projected,
  };
}
