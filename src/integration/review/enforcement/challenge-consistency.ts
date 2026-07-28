/**
 * @module integration/review/enforcement/challenge-consistency
 * @description Canonical, dependency-free authority for challenge requirement,
 * evidence, distinctness, outcome, and resolution-verdict coherence (#747).
 *
 * This is the SOLE authority for challenge/resolution consistency. It is
 * deliberately separate from `findings-consistency.ts`, which owns ONLY the
 * verdict/blocking-issues coherence rule (F12). #747 requires these two
 * authorities to stay distinct; the architecture guard
 * `challenge-consistency-authority-ssot.test.ts` pins that separation.
 *
 * Dependency-free by design: only canonical JSON. Callers translate
 * `ChallengeConsistencyResult` into their own blocked format.
 */

import { canonicalJsonStringify } from '../../../shared/canonical-json.js';

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
  /**
   * The IDs of challenges from the immediately preceding review iteration that
   * are STILL OPEN (unresolved) and therefore require a reviewer resolution
   * verdict in the current findings. This is the genuinely-open set — NOT the
   * set of challenges the author has already recorded resolutions for.
   */
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
  // A design/content challenge whose falsification SUCCEEDED (the artifact is
  // contradicted) cannot accompany acceptance. Previously the outcome of these
  // kinds was never checked, so a reviewer could collect a "contradicted"
  // falsification signal and still return `accept` with no blocking issue — the
  // signal was silently ignored (finding B4). Force a non-accept verdict.
  if (
    (challenge.kind === 'design_challenge' || challenge.kind === 'content_challenge') &&
    input.overallVerdict === 'accept' &&
    challenge.outcome === 'contradicted'
  ) {
    return {
      ok: false,
      code: 'SUBAGENT_CHALLENGE_CONTRADICTED',
      details: { kind: challenge.kind, outcome: challenge.outcome },
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
 * challenges (or N empty placeholders) satisfy a HIGH-RISK requirement. Two
 * guards close that:
 *  - Distinctness: no two challenges may share a `challengeId`, and no two may
 *    share the same substance signature (kind + scenario + claim + locations +
 *    evidenceRefs, normalized). Copying a challenge and only regenerating its
 *    random UUID is therefore rejected. Two DIFFERENT falsification scenarios
 *    that test the same claim/locations/evidence are NOT duplicates — `scenario`
 *    is part of the signature (#747 treats scenario as a first-class property).
 *  - Placeholder floor: required string fields must be non-empty and not
 *    whitespace-only. This is a structural emptiness guard, NOT a length- or
 *    quality-based policy: challenge coverage requirements are owned by the
 *    frozen policy matrix (#747), never by this consistency authority.
 */
function validateChallengeSubstance(challenges: readonly Challenge[]): ChallengeConsistencyResult {
  const floor = validateChallengeFloor(challenges);
  if (!floor.ok) return floor;
  if (challenges.length < 2) return { ok: true };

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

/**
 * Structural anti-placeholder guard: a present required field must not be empty
 * or whitespace-only. No length threshold and no content policy — those belong
 * to the approved policy matrix, not to this consistency authority. Fields are
 * only checked when present (the input type makes them optional for reduced
 * callers/fixtures).
 */
function validateChallengeFloor(challenges: readonly Challenge[]): ChallengeConsistencyResult {
  for (const challenge of challenges) {
    const emptyField = firstEmptyRequiredField(challenge);
    if (emptyField !== null) {
      return {
        ok: false,
        code: 'SUBAGENT_CHALLENGE_INSUBSTANTIAL',
        details: { reason: 'empty_field', field: emptyField },
      };
    }
  }
  return { ok: true };
}

function isBlank(value: string | undefined): boolean {
  return value !== undefined && value.trim().length === 0;
}

function firstEmptyRequiredField(challenge: Challenge): string | null {
  if (isBlank(challenge.claim)) return 'claim';
  if (isBlank(challenge.scenario)) return 'scenario';
  if (challenge.locations !== undefined) {
    if (challenge.locations.length === 0) return 'locations';
    if (challenge.locations.some((location) => location.trim().length === 0)) return 'locations';
  }
  return null;
}

/**
 * Substance signature keyed on the meaning of the challenge, not its identity.
 * `scenario` and `claim` are normalized (trimmed + lowercased), `locations`
 * sorted, and `evidenceRefs` reduced to a canonical sorted set, so trivial
 * reordering or casing cannot defeat duplicate detection. `challengeId` is
 * intentionally excluded — regenerating only the UUID must not defeat the check.
 * `scenario` IS included: two distinct falsification scenarios against the same
 * claim/locations/evidence are legitimately different challenges.
 */
function challengeSubstanceSignature(challenge: Challenge): string {
  const scenario = (challenge.scenario ?? '').trim().toLowerCase();
  const claim = (challenge.claim ?? '').trim().toLowerCase();
  const locations = [...(challenge.locations ?? [])].map((l) => l.trim().toLowerCase()).sort();
  const evidence = [...(challenge.evidenceRefs ?? [])].map(canonicalJsonStringify).sort();
  return canonicalJsonStringify({ kind: challenge.kind, scenario, claim, locations, evidence });
}

/**
 * Validate that each supplied resolution verdict references a known open
 * challenge exactly once. Returns a typed failure, or `null` when all supplied
 * verdicts are well-formed.
 */
function validateSuppliedVerdictShape(
  supplied: NonNullable<ChallengeConsistencyInput['resolutionVerdicts']>,
  openIds: ReadonlySet<string>,
): ChallengeConsistencyResult | null {
  const seen = new Set<string>();
  for (const item of supplied) {
    if (seen.has(item.challengeId)) {
      return {
        ok: false,
        code: 'SUBAGENT_RESOLUTION_VERDICT_DUPLICATE',
        details: { challengeId: item.challengeId },
      };
    }
    seen.add(item.challengeId);
    if (!openIds.has(item.challengeId)) {
      return {
        ok: false,
        code: 'SUBAGENT_RESOLUTION_VERDICT_UNKNOWN',
        details: { challengeId: item.challengeId },
      };
    }
  }
  return null;
}

/**
 * Resolution-verdict gating (#747). Every supplied resolution verdict must bind
 * to exactly one genuinely-open challenge from the preceding iteration; unknown,
 * duplicate, out-of-scope, or unexpected verdicts are rejected with a typed
 * reason. `unable_to_review` may omit verdicts (no acceptance occurs) but any
 * verdicts it does supply must still reference known, unique open IDs.
 */
function validateResolutionVerdicts(input: ChallengeConsistencyInput): ChallengeConsistencyResult {
  const unresolvedIds = input.unresolvedImplementationChallengeIds ?? [];
  const supplied = input.resolutionVerdicts ?? [];
  const openIds = new Set(unresolvedIds);

  // 1. No open challenges → no resolution verdicts may be supplied. Checked
  //    before per-item validation so the diagnosis is the specific "unexpected"
  //    signal rather than a generic "unknown id".
  if (openIds.size === 0) {
    if (supplied.length > 0) {
      return {
        ok: false,
        code: 'SUBAGENT_RESOLUTION_VERDICT_UNEXPECTED',
        details: { supplied: supplied.length },
      };
    }
    return { ok: true };
  }

  // 2. Every supplied verdict must reference a known open challenge, exactly once.
  const shapeFailure = validateSuppliedVerdictShape(supplied, openIds);
  if (shapeFailure) return shapeFailure;

  // 3. unable_to_review: no acceptance is happening. Prior unresolved challenges
  //    remain open and must not block the honest fail-closed result. Supplied
  //    verdicts were already validated for known/unique IDs above.
  if (input.overallVerdict === 'unable_to_review') {
    return { ok: true };
  }

  // 4. Every open challenge must carry exactly one verdict, with the correct
  //    value for the overall verdict.
  const verdicts = new Map(supplied.map((item) => [item.challengeId, item.verdict]));
  for (const id of openIds) {
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
