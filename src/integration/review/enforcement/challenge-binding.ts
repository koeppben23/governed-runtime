/**
 * @module integration/review-enforcement-challenge-binding
 * @description Bind-time rules for reviewer challenges.
 *
 * Two rules decide whether reviewer challenges may become evidence:
 *
 * 1. Identity is host-owned. The canonical reviewer prompt asks for a
 *    `clientReference` slug and never for a `challengeId`, so the host mints the
 *    canonical identity before the schema gate — which requires it.
 * 2. The obligation's frozen challenge contract is enforced here rather than
 *    only at verdict time, so evidence that can never satisfy it does not
 *    consume the obligation's single bindable attempt.
 *
 * @version v1
 */

import type { ReviewObligation } from '../../../state/evidence.js';
import type { HostTaskBindResult } from './types.js';
import { normalizeChallenges } from './normalize.js';

/**
 * Map reviewer challenge slugs onto host-minted canonical identities.
 *
 * Returns the findings with host-authoritative `challengeId` / `obligationId`
 * stamped on every challenge, or a rejection when the reviewer reused a single
 * `clientReference` twice — which would make the slug-to-identity mapping
 * ambiguous in the audit trail.
 */
export function normalizeFindingsChallenges(
  findings: Record<string, unknown>,
  obligationId: string,
  childSessionId: string,
): { findings: Record<string, unknown> } | HostTaskBindResult {
  const raw = findings.challenges;
  if (!Array.isArray(raw)) return { findings };

  const normalized = normalizeChallenges(raw, obligationId);
  if (!normalized.ok) {
    return {
      evidence: null,
      bindOutcome: 'client_reference_invalid',
      diagnostic: {
        childSessionId,
        obligationId,
        clientReference: normalized.clientReference,
        challengeIndex: normalized.index,
        message: `Duplicate clientReference "${normalized.clientReference}" in reviewer challenges. Each challenge needs a unique reference.`,
      },
    };
  }
  return { findings: { ...findings, challenges: normalized.challenges } };
}

/**
 * Enforce the obligation's frozen challenge contract at binding time.
 *
 * The same count rule is enforced again when the verdict is submitted. Checking
 * it here as well is what keeps a failure recoverable: a rejected bind leaves
 * the attempt re-armable, whereas evidence that binds and only fails later has
 * already spent the obligation's single bindable attempt.
 */
export function checkChallengeContract(
  findings: Record<string, unknown>,
  obligation: ReviewObligation,
  childSessionId: string,
): HostTaskBindResult | null {
  const required = obligation.requiredChallengeCount;
  if (required === undefined) return null;

  const challenges = Array.isArray(findings.challenges) ? findings.challenges : [];
  if (challenges.length === required) return null;

  return {
    evidence: null,
    bindOutcome: 'challenge_contract_violation',
    diagnostic: {
      childSessionId,
      obligationId: obligation.obligationId,
      required,
      actual: challenges.length,
      requiredChallengeKind: obligation.requiredChallengeKind,
      message: `Reviewer supplied ${challenges.length} challenge(s) but the obligation requires exactly ${required}.`,
    },
  };
}
