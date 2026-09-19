/**
 * @module session-state-evidence-shape
 * @description SessionState evidence-slot schema group: ticket, plan,
 *              architecture, validation, mutation, review, and ProofGraph
 *              evidence slots.
 *
 * @version v1
 */

import { z } from 'zod';
import {
  ArchitectureDecision,
  ChallengeResolution,
  FrozenRepositoryRevisionTarget,
  ImplEvidence,
  ImplReviewResult,
  MutationAttempt,
  PlanRecord,
  ReviewAssuranceState,
  ReviewCycles,
  ReviewDecision,
  ReviewFindings,
  SelfReviewLoop,
  TicketEvidence,
  ValidationAttempt,
  ValidationResult,
} from './evidence.js';
import { MutationEpisode, MutationEpisodeResolution } from './evidence-mutation-episode.js';
import { RuntimeLease } from './runtime-lease.js';
import { PeerReviewEvidence } from './peer-review.js';
import { ProofGraphProjection } from './proofgraph.js';
import { ProofContract, ProofContractCoverage } from './proofgraph-contract.js';

/**
 * Evidence-slot fields of {@link SessionState}.
 * Spread into the canonical SessionState object shape.
 */
export const SessionStateEvidenceShape = {
  /** Ticket/task evidence from /ticket. */
  ticket: TicketEvidence.nullable(),

  /** Architecture Decision Record from /architecture. */
  architecture: ArchitectureDecision.nullable(),

  /** Plan record with version history from /plan. */
  plan: PlanRecord.nullable(),

  /** Self-review loop state (PLAN phase, digest-stop). */
  selfReview: SelfReviewLoop.nullable(),

  /** Validation check results (VALIDATION phase, N checks in one phase). */
  validation: z.array(ValidationResult),

  /**
   * Append-only execution ledger. Unlike the current per-check projections above,
   * this preserves every successful validation-result persistence for audit.
   */
  validationAttempts: z.array(ValidationAttempt),

  /**
   * Append-only mutation-attempt ledger (#762). Records every FlowGuard-attested
   * mutation report observation, with implementation binding, artifact/projection
   * digests, and reproducibility metadata. Produced by flowguard_record_mutation_evidence.
   */
  mutationAttempts: z.array(MutationAttempt),

  /** Durable host-mutation dispatch and completion ledger. */
  mutationEpisodes: z.array(MutationEpisode),

  /** Append-only unknown-outcome resolution authority for host mutation episodes. */
  mutationEpisodeResolutions: z.array(MutationEpisodeResolution),

  /**
   * Fencing lease naming the single runtime instance governing this session.
   * Held here, not in a file of its own, so the generation advances in the
   * same atomic write as the episode that binds it. Null before any host
   * mutation has been authorized.
   */
  runtimeLease: RuntimeLease.nullable(),

  /** Advisory challenge-resolution evidence; defaults for legacy sessions. */
  challengeResolutions: z.array(ChallengeResolution),

  /**
   * Post-implementation validation check results (IMPL_VALIDATION phase). Kept
   * separate from `validation` (the pre-implementation baseline run) so the audit
   * trail retains both the baseline and the re-run of checks against the fixed code.
   * Defaulted to [] for backward compatibility with pre-IMPL_VALIDATION sessions.
   */
  implValidation: z.array(ValidationResult),

  /** Implementation evidence from /implement. */
  implementation: ImplEvidence.nullable(),

  /**
   * Pre-mutation frozen implementation base (commit-kind frozen repository
   * revision target). Frozen at the transition INTO `IMPLEMENTATION`, before
   * any governed mutation; the implementation review candidate pair resolves
   * `revision:'base'` against this target. Absent for sessions that entered
   * IMPLEMENTATION before the frozen-repository-authority generation — such
   * sessions have no repository evidence authority.
   */
  implementationBaseAuthority: FrozenRepositoryRevisionTarget.optional(),
};

/**
 * Review-evidence fields of {@link SessionState}.
 * Spread into the canonical SessionState object shape.
 */
export const SessionStateReviewEvidenceShape = {
  /** Implementation review iteration result (IMPL_REVIEW phase, digest-stop). */
  implReview: ImplReviewResult.nullable(),

  /** Human review-cycle counters for the governed loops; REQUIRED — see `review-cycles.ts`. */
  reviewCycles: ReviewCycles,

  /** Independent review findings for /implement (parallel, NOT mixed with ImplEvidence). */
  implReviewFindings: z.array(ReviewFindings).optional(),

  /** Independent review findings for standalone /review, retained append-only for audit. */
  peerReviewFindings: z.array(ReviewFindings).optional(),

  /** P35 strict independent-review obligations and invocation evidence. */
  reviewAssurance: ReviewAssuranceState.optional(),

  /** Human review decision at PLAN_REVIEW, EVIDENCE_REVIEW, or ARCH_REVIEW. */
  reviewDecision: ReviewDecision.nullable(),

  /** Absolute path to the generated review report file (PEER_REVIEW phase, P8b). */
  reviewReportPath: z.string().nullable(),

  /** Append-only deterministic task preparation and completion evidence for /review. */
  peerReviewEvidence: z.array(PeerReviewEvidence),

  /**
   * Thin ProofGraph contract declaration (advisory; #762).
   *
   * Declaration-only: names the claims a change asserts and their approved
   * sources. Additive/`.optional()`; never a runtime authority. The evaluator
   * derives `proofGraph` from these claims plus executed evidence.
   */
  proofContract: ProofContract.optional(),

  /** Cause-specific gaps from the most recent approved-plan materialization. */
  proofContractCoverage: z.array(ProofContractCoverage).optional(),

  /**
   * Compact ProofGraph projection (advisory; #762).
   *
   * Additive and `.optional()` for backward compatibility: sessions created
   * before ProofGraph have no projection, and its absence is treated as "no
   * graph". It never gates a workflow on its own — blocking eligibility is a
   * policy-layer decision. Large provider artifacts live outside session state.
   */
  proofGraph: ProofGraphProjection.optional(),

  /** Next auto-generated ADR sequence number for /architecture. */
  nextAdrNumber: z.number().int().positive(),
};
