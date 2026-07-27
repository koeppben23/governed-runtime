/**
 * @module integration/review/enforcement/findings-consistency
 * @description Canonical, dependency-free consistency invariant for review findings.
 *
 * SSOT for the verdict/blocking-issues coherence rule (F12). This is the ONLY
 * implementation of the rule; every boundary that ingests reviewer findings
 * MUST call this function rather than re-deriving the rule, so a later refactor
 * cannot silently diverge the two enforcement sites.
 *
 * Rule (strict emptiness): an `accept` verdict is incoherent with ANY blocking
 * issue. The rule intentionally keys on the presence of blocking issues, not on
 * their severity: the current `ReviewFindings` schema does not constrain which
 * severities may appear in `blockingIssues`, and the field name is the contract.
 * A minor advisory note misfiled into `blockingIssues` therefore also blocks an
 * `accept` — the reviewer must return a non-accept verdict or reclassify the
 * finding. Severity-aware separation is deferred to a schema change (F13) where
 * it becomes structurally guaranteed rather than interpreted at runtime.
 *
 * The runtime is deliberately stricter than the reviewer mandate prose
 * (which permits `accept` with minor-only blocking issues). Failing closed on a
 * self-contradictory finding does not weaken the security contract.
 *
 * Dependency-free by design: no `formatBlocked`, no rail/enforcement result
 * types. Callers translate `ReviewFindingsConsistencyResult` into their own
 * blocked format.
 */

import { canonicalJsonStringify } from '../../../shared/canonical-json.js';

/** Boundary-neutral result of the canonical consistency check. */
export type ReviewFindingsConsistencyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT';
      readonly details: {
        readonly overallVerdict: 'accept';
        readonly blockingIssueCount: number;
      };
    };

/**
 * Minimal shape required to evaluate the coherence rule.
 *
 * Both ingestion boundaries can satisfy this:
 * - Verdict-submission boundary passes `blockingIssues.length`.
 * - Enforcement/binding boundary passes the captured `blockingIssuesCount`.
 */
export interface ReviewFindingsConsistencyInput {
  readonly overallVerdict: string;
  readonly blockingIssueCount: number;
}

/**
 * Dependency-free challenge coverage invariant. It accepts structural data so it
 * can be used at schema, SDK, and host-capture boundaries without dependencies.
 */
export interface ChallengeConsistencyInput {
  readonly overallVerdict: 'accept' | 'changes_requested' | 'unable_to_review';
  readonly requiredChallengeCount: number;
  readonly requiredChallengeKind:
    'design_challenge' | 'implementation_challenge' | 'content_challenge';
  readonly challenges:
    | readonly {
        readonly obligationId?: string;
        readonly kind: string;
        readonly evidenceRefs?: readonly unknown[];
        readonly outcome?: string;
        readonly challengeId?: string;
        readonly claim?: string;
        readonly scenario?: string;
        readonly locations?: readonly string[];
      }[]
    | undefined;
  readonly expectedObligationId?: string;
  readonly allowedEvidenceRefs?: readonly unknown[];
  readonly unresolvedImplementationChallengeIds?: readonly string[];
  readonly resolutionVerdicts?: readonly {
    readonly challengeId: string;
    readonly verdict: string;
  }[];
}

export type ChallengeConsistencyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly details: Record<string, unknown> };

type Challenge = NonNullable<ChallengeConsistencyInput['challenges']>[number];

// eslint-disable-next-line complexity -- explicit fail-closed challenge checks
function validateChallenge(
  input: ChallengeConsistencyInput,
  challenge: Challenge,
  allowedRefs: ReadonlySet<string> | undefined,
): ChallengeConsistencyResult {
  if (
    input.expectedObligationId !== undefined &&
    challenge.obligationId !== input.expectedObligationId
  ) {
    return {
      ok: false,
      code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
      details: { kind: challenge.kind, reason: 'obligation_mismatch' },
    };
  }
  if (input.requiredChallengeCount > 0 && challenge.kind !== input.requiredChallengeKind) {
    return {
      ok: false,
      code: 'SUBAGENT_CHALLENGE_KIND_INCOHERENT',
      details: { required: input.requiredChallengeKind, actual: challenge.kind },
    };
  }
  if (!challenge.evidenceRefs || challenge.evidenceRefs.length === 0) {
    return {
      ok: false,
      code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
      details: { kind: challenge.kind },
    };
  }
  if (
    allowedRefs &&
    challenge.evidenceRefs.some((ref) => !allowedRefs.has(canonicalJsonStringify(ref)))
  ) {
    return {
      ok: false,
      code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
      details: { kind: challenge.kind, reason: 'evidence_mismatch' },
    };
  }
  if (
    challenge.kind === 'implementation_challenge' &&
    challenge.outcome === 'pass' &&
    !challenge.evidenceRefs.some(
      (reference) =>
        typeof reference === 'object' &&
        reference !== null &&
        'kind' in reference &&
        reference.kind === 'validation_attempt',
    )
  ) {
    return {
      ok: false,
      code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
      details: { kind: challenge.kind, required: 'validation_attempt' },
    };
  }
  if (
    challenge.kind === 'implementation_challenge' &&
    input.overallVerdict === 'accept' &&
    (challenge.outcome === 'fail' || challenge.outcome === 'not_verified')
  ) {
    return {
      ok: false,
      code: 'SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED',
      details: { outcome: challenge.outcome },
    };
  }
  return { ok: true };
}

export function validateChallengeConsistency(
  input: ChallengeConsistencyInput,
): ChallengeConsistencyResult {
  const challenges = input.challenges ?? [];
  // unable_to_review is a fail-closed honest signal that no assessment
  // could be completed. It must not be rejected because challenges are
  // missing — the reviewer cannot fabricate evidence-bound challenges
  // when no canonical evidence is available.
  if (input.overallVerdict === 'unable_to_review') {
    return validateChallengeCountFlexible(input, challenges);
  }
  if (challenges.length !== input.requiredChallengeCount) {
    return {
      ok: false,
      code: 'SUBAGENT_CHALLENGE_COUNT_INCOHERENT',
      details: { required: input.requiredChallengeCount, actual: challenges.length },
    };
  }
  return validateChallengeCountFlexible(input, challenges);
}

function validateChallengeCountFlexible(
  input: ChallengeConsistencyInput,
  challenges: readonly Challenge[],
): ChallengeConsistencyResult {
  const distinctness = validateChallengeSubstance(challenges);
  if (!distinctness.ok) return distinctness;
  const allowedRefs = input.allowedEvidenceRefs
    ? new Set(input.allowedEvidenceRefs.map(canonicalJsonStringify))
    : undefined;
  for (const challenge of challenges) {
    const result = validateChallenge(input, challenge, allowedRefs);
    if (!result.ok) return result;
  }
  return validateResolutionVerdicts(input);
}

/**
 * Anti-gaming invariant across the N required challenges (findings B1/B2).
 *
 * The count check alone is purely quantitative: without this, N byte-identical
 * challenges (or N one-character placeholders) satisfy a HIGH-RISK requirement.
 * Two guards close that:
 *  - Distinctness: no two challenges may share a `challengeId`, and no two may
 *    share the same substance signature (claim + locations + evidenceRefs,
 *    normalized). Copying a challenge and only regenerating its random UUID is
 *    therefore rejected.
 *  - Substance floor: `claim` must clear a deliberately LOW non-whitespace
 *    length bar. This is an anti-placeholder guard ("x", "n/a"), NOT a quality
 *    judgement — a genuine falsification claim always clears it. Only applied
 *    when the field is present (the input type makes it optional for reduced
 *    callers/fixtures).
 */
function validateChallengeSubstance(challenges: readonly Challenge[]): ChallengeConsistencyResult {
  if (challenges.length < 2) {
    // Still enforce the placeholder floor for a single challenge.
    return validateChallengeFloor(challenges);
  }
  const floor = validateChallengeFloor(challenges);
  if (!floor.ok) return floor;

  const seenIds = new Set<string>();
  const seenSignatures = new Set<string>();
  for (const challenge of challenges) {
    if (challenge.challengeId !== undefined) {
      if (seenIds.has(challenge.challengeId)) {
        return {
          ok: false,
          code: 'SUBAGENT_CHALLENGE_NOT_DISTINCT',
          details: { reason: 'duplicate_challenge_id', challengeId: challenge.challengeId },
        };
      }
      seenIds.add(challenge.challengeId);
    }
    const signature = challengeSubstanceSignature(challenge);
    if (seenSignatures.has(signature)) {
      return {
        ok: false,
        code: 'SUBAGENT_CHALLENGE_NOT_DISTINCT',
        details: { reason: 'duplicate_substance' },
      };
    }
    seenSignatures.add(signature);
  }
  return { ok: true };
}

/** Deliberately low anti-placeholder bar; a real falsification claim clears it. */
const MIN_CHALLENGE_CLAIM_CHARS = 12;

function validateChallengeFloor(challenges: readonly Challenge[]): ChallengeConsistencyResult {
  for (const challenge of challenges) {
    if (
      challenge.claim !== undefined &&
      challenge.claim.trim().length < MIN_CHALLENGE_CLAIM_CHARS
    ) {
      return {
        ok: false,
        code: 'SUBAGENT_CHALLENGE_INSUBSTANTIAL',
        details: { reason: 'claim_too_short', minChars: MIN_CHALLENGE_CLAIM_CHARS },
      };
    }
  }
  return { ok: true };
}

/**
 * Substance signature keyed on the meaning of the challenge, not its identity.
 * `claim` is normalized (trimmed + lowercased), `locations` sorted, and
 * `evidenceRefs` reduced to a canonical sorted set, so trivial reordering or
 * casing cannot defeat duplicate detection. `challengeId`/`scenario` are
 * intentionally excluded — the scenario prose can be varied while the substance
 * stays identical.
 */
function challengeSubstanceSignature(challenge: Challenge): string {
  const claim = (challenge.claim ?? '').trim().toLowerCase();
  const locations = [...(challenge.locations ?? [])].map((l) => l.trim().toLowerCase()).sort();
  const evidence = [...(challenge.evidenceRefs ?? [])].map(canonicalJsonStringify).sort();
  return canonicalJsonStringify({ kind: challenge.kind, claim, locations, evidence });
}

function validateResolutionVerdicts(input: ChallengeConsistencyInput): ChallengeConsistencyResult {
  const unresolvedIds = input.unresolvedImplementationChallengeIds ?? [];
  if (unresolvedIds.length === 0) return { ok: true };

  if (input.overallVerdict === 'unable_to_review') {
    // No acceptance is happening. Prior unresolved challenges remain open
    // and must not block the honest fail-closed result.
    return { ok: true };
  }

  const verdicts = new Map(
    (input.resolutionVerdicts ?? []).map((item) => [item.challengeId, item.verdict]),
  );

  for (const id of unresolvedIds) {
    const verdict = verdicts.get(id);
    if (verdict === undefined) {
      return {
        ok: false,
        code: 'SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED',
        details: { challengeId: id, reason: 'no resolution verdict' },
      };
    }
    if (input.overallVerdict === 'accept' && verdict !== 'resolved') {
      return {
        ok: false,
        code: 'SUBAGENT_IMPLEMENTATION_CHALLENGE_UNRESOLVED',
        details: { challengeId: id, verdict },
      };
    }
  }
  return { ok: true };
}

/**
 * Canonical coherence check. Returns `{ ok: true }` when the verdict is
 * consistent with the blocking-issue count, otherwise a typed failure that the
 * caller renders into its blocked format.
 */
export function validateReviewFindingsConsistency(
  input: ReviewFindingsConsistencyInput,
): ReviewFindingsConsistencyResult {
  if (input.overallVerdict === 'accept' && input.blockingIssueCount > 0) {
    return {
      ok: false,
      code: 'SUBAGENT_VERDICT_FINDINGS_INCOHERENT',
      details: {
        overallVerdict: 'accept',
        blockingIssueCount: input.blockingIssueCount,
      },
    };
  }
  return { ok: true };
}
