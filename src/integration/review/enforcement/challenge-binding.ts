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
import { canonicalJsonStringify } from '../../../shared/canonical-json.js';

// eslint-disable-next-line complexity -- intentional identity key per ref-type
function referenceIdentity(reference: unknown): string | null {
  if (typeof reference !== 'object' || reference === null || Array.isArray(reference)) return null;
  const ref = reference as Record<string, unknown>;
  switch (ref.kind) {
    case 'plan_adr_section': {
      if (
        typeof ref.artifactKind !== 'string' ||
        typeof ref.artifactDigest !== 'string' ||
        !Array.isArray(ref.sectionPath)
      )
        return null;
      const stablePath = ref.sectionPath.map((part) => {
        if (typeof part !== 'object' || part === null || Array.isArray(part)) return part;
        const segment = part as Record<string, unknown>;
        return { headingDepth: segment.headingDepth, siblingIndex: segment.siblingIndex };
      });
      return canonicalJsonStringify({
        kind: ref.kind,
        artifactKind: ref.artifactKind,
        artifactDigest: ref.artifactDigest,
        sectionPath: stablePath,
      });
    }
    case 'implementation':
      return typeof ref.implementationDigest === 'string'
        ? canonicalJsonStringify({ kind: ref.kind, implementationDigest: ref.implementationDigest })
        : null;
    case 'validation_attempt':
      return typeof ref.attemptId === 'string'
        ? canonicalJsonStringify({ kind: ref.kind, attemptId: ref.attemptId })
        : null;
    case 'content':
      return typeof ref.digest === 'string'
        ? canonicalJsonStringify({ kind: ref.kind, digest: ref.digest })
        : null;
    default:
      return null;
  }
}

function bindCanonicalEvidenceRefs(
  challenges: readonly Record<string, unknown>[],
  allowedEvidenceRefs: readonly unknown[] | undefined,
  obligationId: string,
  childSessionId: string,
): { challenges: Record<string, unknown>[] } | HostTaskBindResult {
  if (!allowedEvidenceRefs) return { challenges: [...challenges] };
  const canonicalByIdentity = new Map<string, unknown>();
  for (const reference of allowedEvidenceRefs) {
    const identity = referenceIdentity(reference);
    if (identity) canonicalByIdentity.set(identity, reference);
  }
  const bound: Record<string, unknown>[] = [];
  for (let challengeIndex = 0; challengeIndex < challenges.length; challengeIndex += 1) {
    const challenge = challenges[challengeIndex]!;
    const refs = Array.isArray(challenge.evidenceRefs) ? challenge.evidenceRefs : [];
    const canonicalRefs: unknown[] = [];
    for (let referenceIndex = 0; referenceIndex < refs.length; referenceIndex += 1) {
      const reference = refs[referenceIndex];
      const identity = referenceIdentity(reference);
      const canonical = identity ? canonicalByIdentity.get(identity) : undefined;
      if (canonical === undefined) {
        return {
          evidence: null,
          bindOutcome: 'challenge_evidence_unknown',
          diagnostic: {
            childSessionId,
            obligationId,
            challengeIndex,
            referenceIndex,
            message:
              'Reviewer challenge references evidence outside the host-authoritative challenge contract.',
          },
        };
      }
      canonicalRefs.push(canonical);
    }
    bound.push({ ...challenge, evidenceRefs: canonicalRefs });
  }
  return { challenges: bound };
}

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
  allowedEvidenceRefs?: readonly unknown[],
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
  const canonical = bindCanonicalEvidenceRefs(
    normalized.challenges,
    allowedEvidenceRefs,
    obligationId,
    childSessionId,
  );
  if ('bindOutcome' in canonical) return canonical;
  return { findings: { ...findings, challenges: canonical.challenges } };
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
