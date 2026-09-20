/**
 * @module schema
 * @description Core state model — Phase enum, Event enum, Transition, and SessionState.
 *              SessionState's evidence, configuration, and discovery field groups
 *              live in the `session-state-*-shape.ts` siblings. Single Zod schema
 *              validated on every atomic write.
 *
 * Design decisions (Lead-reviewed):
 * - No updatedAt at top-level (redundant — evidences have own timestamps)
 * - transition field (auditor sees last transition without parsing JSONL)
 * - plan with version history (compliance requirement for banks)
 * - activeChecks as closed enum (no silent typos)
 * - error field (fail-closed error state with recovery info)
 *
 * @version v1
 */

import { z } from 'zod';
import { ActorInfoSchema, BindingInfo, ErrorInfo, ImplementationRework } from './evidence.js';
import { enforceMutationEpisodeInvariants } from './evidence-mutation-episode.js';
import { ExportCompletionEvidence } from './evidence-export.js';
import { SystemWorkOperation } from './system-work.js';
import { DiscoveryHealthGate } from './discovery-schemas.js';
import { resolveAuthoritativePeerReviewTask } from './peer-review.js';
import { SessionStateConfigShape } from './session-state-config-shape.js';
import { SessionStateDiscoveryShape } from './session-state-discovery-shape.js';
import {
  SessionStateEvidenceShape,
  SessionStateReviewEvidenceShape,
} from './session-state-evidence-shape.js';

/** Immutable compatibility contract for executable session authority. */
export const CURRENT_ASSURANCE_EPOCH = 'assurance-epoch.v3' as const;
export const CURRENT_SESSION_STATE_SCHEMA_VERSION = 'v6' as const;
export const CURRENT_STATE_DIGEST_FORMAT = 'state-digest.v2' as const;
export const CURRENT_AUDIT_CHAIN_FORMAT = 'audit-chain.v3' as const;

// ─── Phase ────────────────────────────────────────────────────────────────────

/**
 * The 18 FlowGuard phases across 3 standalone flows; init() is a
 * function (bootstrap, workspace, binding, discovery) — not a phase.
 *
 * After /hydrate, the session starts at READY — a routing phase
 * where the user selects one of 3 standalone flows:
 *
 * Ticket flow (full development lifecycle):
 *   READY → TICKET → PLAN → PLAN_REVIEW → VALIDATION → IMPLEMENTATION → IMPL_REVIEW → EVIDENCE_REVIEW → EXPORT_READY → COMPLETE
 *   Reduced ceremony: IMPLEMENTATION → EVIDENCE_REVIEW only with explicit reducedCeremony evidence.
 *
 * Architecture flow (ADR creation):
 *   READY → ARCHITECTURE → ARCH_REVIEW → ARCH_COMPLETE
 *
 * Peer review flow (peer review report):
 *   READY → PEER_REVIEW → PEER_REVIEW_COMPLETE
 *
 * Backward transitions:
 *   PLAN_REVIEW --changes_requested--> PLAN
 *   PLAN_REVIEW --reject--> REJECTED
 *   EVIDENCE_REVIEW --changes_requested--> IMPLEMENTATION
 *   EVIDENCE_REVIEW --reject--> REJECTED
 *   ARCH_REVIEW --changes_requested--> ARCHITECTURE
 *   ARCH_REVIEW --reject--> REJECTED
 */
export const Phase = z.enum([
  'READY',
  'TICKET',
  'PLAN',
  'PLAN_REVIEW',
  'VALIDATION',
  'IMPLEMENTATION',
  'IMPL_VALIDATION',
  'IMPL_REVIEW',
  'EVIDENCE_REVIEW',
  'EXPORT_READY',
  'COMPLETE',
  'ARCHITECTURE',
  'ARCH_REVIEW',
  'ARCH_COMPLETE',
  'PEER_REVIEW',
  'PEER_REVIEW_COMPLETE',
  'REJECTED',
  'ABORTED',
]);
export type Phase = z.infer<typeof Phase>;

// ─── Task Risk Classification ────────────────────────────────────────────────

/**
 * Agent-claimed task class. This is only an operator/agent claim, never the
 * runtime truth. The runtime computes a minimum class per gate check.
 */
export const TaskClass = z.enum(['TRIVIAL', 'STANDARD', 'HIGH-RISK']);
export type TaskClass = z.infer<typeof TaskClass>;

/**
 * Membership predicate over the canonical task-class vocabulary.
 *
 * Boundary-neutral: accepts any value so untyped transport input
 * (`claimedTaskClass: string`) can be narrowed at the authority instead of
 * re-enumerating the vocabulary at each consumer.
 */
export function isTaskClass(value: unknown): value is TaskClass {
  return TaskClass.safeParse(value).success;
}

/** Specific authority affected by a HIGH-RISK implementation change. */
export const RiskTrigger = z.enum([
  'state_integrity',
  'audit_authority',
  'identity_boundary',
  'approval_authority',
  'policy_authority',
  'migration',
  'distribution_integrity',
  'command_contract',
  'ceremony_only',
]);
export type RiskTrigger = z.infer<typeof RiskTrigger>;

/** Runtime decision that implementation review ceremony was explicitly reduced. */
export const ReducedCeremonyDecision = z
  .object({
    profile: z.literal('reduced'),
    reason: z.string().min(1),
    claimedTaskClass: TaskClass,
    computedMinimumTaskClass: TaskClass,
    touchedSurfaces: z.array(z.string()),
    decidedAt: z.string().datetime(),
  })
  .readonly();
export type ReducedCeremonyDecision = z.infer<typeof ReducedCeremonyDecision>;

/**
 * Risk classification bound to the exact implementation revision it describes.
 *
 * Persisted so gate rails can consult it without importing the integration-layer
 * classifier. The `implementationDigest` binding is the invariant: an assessment
 * whose digest no longer matches the current implementation is superseded and
 * must never justify a gate decision (#762).
 */
export const ImplementationRiskAssessment = z
  .object({
    computedMinimumTaskClass: TaskClass,
    touchedSurfaces: z.array(z.string()),
    // Optional for sessions written before #762 Change 2. Consumers must treat
    // its absence as superseded rather than silently inferring a trigger.
    riskTriggers: z.array(RiskTrigger).optional(),
    assessedFrom: z.literal('implementation_changed_files'),
    assessedFileCount: z.number().int().nonnegative(),
    implementationDigest: z.string().min(1),
  })
  .readonly();
export type ImplementationRiskAssessment = z.infer<typeof ImplementationRiskAssessment>;

/** Persistent risk gate state. A blocked gate must stop the next mutating tool. */
export const RiskGate = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('clear'),
    lastDecisionId: z.string().min(1).optional(),
    clearedAt: z.string().datetime().optional(),
  }),
  z.object({
    status: z.literal('blocked'),
    code: z.string().min(1),
    message: z.string().min(1),
    blockedAt: z.string().datetime(),
    lastDecisionId: z.string().min(1),
  }),
]);
export type RiskGate = z.infer<typeof RiskGate>;

/**
 * Discovery health gate vocabulary. Canonically owned by discovery-schemas.ts
 * (discovery-derived data embedded in SessionState); re-exported here because
 * SessionState is the surface consumers import it from.
 */
export {
  DiscoveryDriftAssessment,
  DiscoveryHealthGateCode,
  DiscoveryHealthGate,
} from './discovery-schemas.js';

// ─── Event ────────────────────────────────────────────────────────────────────

/**
 * Machine-internal events that drive transitions.
 * Commands are user inputs; events are what the machine acts on.
 * Mapping: command → rail → state mutation → evaluate() → event → transition.
 */
export const Event = z.enum([
  // READY → flow selection
  'TICKET_SELECTED',
  'ARCHITECTURE_SELECTED',
  'PEER_REVIEW_SELECTED',

  // TICKET → PLAN
  'PLAN_READY',

  // PLAN self-review loop
  'SELF_REVIEW_MET',
  'SELF_REVIEW_PENDING',

  // User Gate decisions (PLAN_REVIEW, EVIDENCE_REVIEW, ARCH_REVIEW)
  'APPROVE',
  'CHANGES_REQUESTED',
  'REJECT',

  // VALIDATION
  'ALL_PASSED',
  'CHECK_FAILED',

  // VALIDATION execution error (timeout / command-not-found): retry, do NOT re-plan
  'CHECK_ERRORED',

  // IMPLEMENTATION → IMPL_REVIEW
  'IMPL_COMPLETE',

  // IMPLEMENTATION → EVIDENCE_REVIEW when policy-gated reduced ceremony is proven
  'REDUCED_CEREMONY',

  // IMPL_REVIEW loop
  'REVIEW_MET',
  'REVIEW_PENDING',

  // Peer review flow → PEER_REVIEW_COMPLETE
  'PEER_REVIEW_DONE',

  // IMPL_REVIEW → EVIDENCE_REVIEW when the review budget is exhausted with
  // changes requested; the final gate becomes a governance override gate.
  'REVIEW_EXHAUSTED',

  // EXPORT_READY → COMPLETE after a verifiable package is materialized.
  'EXPORT_MATERIALIZED',

  // Error recovery (non-user-gate, non-terminal phases)
  'ERROR',

  // Emergency termination — explicitly transitions every non-terminal phase to ABORTED.
  'ABORT',
]);
export type Event = z.infer<typeof Event>;

export type { ExportCompletionEvidence } from './evidence-export.js';

// ─── Transition ───────────────────────────────────────────────────────────────

/**
 * Last transition record.
 * Embedded in state so auditors can see the most recent transition
 * without parsing the JSONL audit trail.
 */
export const Transition = z.object({
  from: Phase,
  to: Phase,
  event: Event,
  at: z.string().datetime(),
});
export type Transition = z.infer<typeof Transition>;

/**
 * Durable hand-off from an atomic state mutation to the append-only audit
 * authority. The operation ID becomes the transition audit-event ID, so a
 * restart can acknowledge an already-appended event without duplicating it.
 */
const PendingAuditOperationBase = z.object({
  operationId: z.string().uuid(),
  preStateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  mutationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  postStateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  auditEventDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['state_committed', 'audit_committed', 'reconciled']),
});

/** A phase transition commits its state↔audit binding through this operation. */
const PendingTransitionAuditOperation = PendingAuditOperationBase.extend({
  kind: z.literal('transition'),
  transition: Transition.extend({
    chainIndex: z.number().int().nonnegative(),
    autoAdvanced: z.boolean(),
  }),
});

/** A non-transition authority write commits one durable state↔audit binding. */
const PendingStateWriteAuditOperation = PendingAuditOperationBase.extend({
  kind: z.literal('state_write'),
  stateWrite: z.object({
    phase: Phase,
    at: z.string().datetime(),
  }),
});

/** A semantic event committed atomically with the authority state it describes. */
const PendingSemanticAuditOperation = PendingAuditOperationBase.extend({
  kind: z.literal('semantic'),
  semantic: z.object({
    phase: Phase,
    event: z.string().min(1),
    occurredAt: z.string().datetime(),
    actor: z.string().min(1).optional(),
    actorInfo: ActorInfoSchema.optional(),
    detail: z.record(z.string(), z.unknown()),
  }),
});

export const PendingAuditOperation = z
  .union([
    PendingTransitionAuditOperation,
    PendingStateWriteAuditOperation,
    PendingSemanticAuditOperation,
  ])
  .readonly();
export type PendingAuditOperation = z.infer<typeof PendingAuditOperation>;

// ─── Session State ────────────────────────────────────────────────────────────

/**
 * The complete FlowGuard session state.
 * Single JSON document, atomically persisted, Zod-validated on every write.
 *
 * Slot pattern: each evidence field is nullable.
 * - null = not yet produced (phase hasn't been reached)
 * - present = evidence exists (phase was executed)
 *
 * The evaluator reads these slots to determine which guards pass.
 */
export const SessionState = z
  .object({
    /** Unique session identifier. */
    id: z.string().uuid(),

    /**
     * Explicit FlowGuard session identifier for the Assurance epoch.
     * Must equal `id` — the two fields are the same authority under an
     * unambiguous name (no host/FlowGuard identity conflation).
     */
    flowguardSessionId: z.string().uuid(),

    /** Schema version for the executable Assurance epoch. */
    schemaVersion: z.literal(CURRENT_SESSION_STATE_SCHEMA_VERSION),

    /** Hard-cut epoch; no prior or unknown epoch is executable authority. */
    assuranceEpoch: z.literal(CURRENT_ASSURANCE_EPOCH),

    /** Required state digest contract for this epoch. */
    stateDigestFormat: z.literal(CURRENT_STATE_DIGEST_FORMAT),

    /** Required audit-chain contract for this epoch. */
    auditChainFormat: z.literal(CURRENT_AUDIT_CHAIN_FORMAT),

    /** Current FlowGuard phase. */
    phase: Phase,
    /** Agent/operator risk-classification claim. Not runtime authority. */
    claimedTaskClass: TaskClass.optional(),
    /** Persistent runtime risk gate block state for mutating host tools. */
    riskGate: RiskGate.optional(),

    /**
     * Revision-bound risk classification of the recorded implementation (#762).
     * Optional for backward compatibility with sessions recorded before this field.
     */
    implementationRiskAssessment: ImplementationRiskAssessment.optional(),

    implementationRework: ImplementationRework.nullable(),
    /** Persistent Discovery health gate block state for mutating host tools (#399). */
    discoveryHealthGate: DiscoveryHealthGate.optional(),

    /** Workspace binding (OpenCode session <-> git worktree). */
    binding: BindingInfo,

    ...SessionStateEvidenceShape,

    /** Explicit runtime evidence for reducing implementation-review ceremony. */
    reducedCeremony: ReducedCeremonyDecision.nullable(),

    ...SessionStateReviewEvidenceShape,

    ...SessionStateConfigShape,

    ...SessionStateDiscoveryShape,

    // ── Metadata ────────────────────────────────────────────────
    /** Last transition (from → to via event). Null before first transition. */
    transition: Transition.nullable(),
    /**
     * State-owned audit outbox. Operations remain after reconciliation as
     * durable correlation evidence; their status is monotonic.
     */
    pendingAuditOperations: z.array(PendingAuditOperation),
    /** Error state. Non-null triggers ERROR event in guard evaluation. */
    error: ErrorInfo.nullable(),
    /** Session creation timestamp (set once by init()). */
    createdAt: z.string().datetime(),
    exportCompletionEvidence: ExportCompletionEvidence.nullable(),
    /** Pending system work (validation); atomic with the entering transition. */
    pendingSystemWork: SystemWorkOperation.nullable(),
    /** Removed persisted archive authority; old state must fail at this boundary. */
    archiveStatus: z.never().optional(),
    /** Lifecycle of the immutable raw-evidence package required at regulated completion. */
    regulatedArchiveStatus: z.enum(['pending', 'created', 'verified', 'failed']).nullable(),
    /** Purpose of the most recent user-requested archive export. */
    lastExportPackagePurpose: z.enum(['sharing', 'auditor']).nullable().optional(),
    /** Whether the most recent export contains the canonical evidence required for verification. */
    lastExportIntegrityCapability: z.enum(['verifiable', 'not_verifiable']).nullable().optional(),
    /** Verification outcome for the most recent user-requested archive export. */
    lastExportVerificationStatus: z.enum(['not_run', 'passed', 'failed']).nullable().optional(),
  })
  .strict()
  .superRefine((state, context) => {
    // Identity invariant: flowguardSessionId is the same authority as id
    // under an explicit name. Divergence would let two session identities
    // claim one state — the STATE itself is invalid.
    if (state.flowguardSessionId !== state.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flowguardSessionId'],
        message: `flowguardSessionId must equal id (${state.id})`,
      });
      return;
    }
    // Outbox identity invariant: pendingAuditOperations operationIds are the
    // transition audit-event identity authority. Duplicates would let
    // acknowledgement update multiple records through one identity, so the
    // STATE itself is invalid when duplicates exist.
    const seenOperationIds = new Set<string>();
    for (const operation of state.pendingAuditOperations) {
      if (seenOperationIds.has(operation.operationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pendingAuditOperations'],
          message: `duplicate pendingAuditOperations operationId: ${operation.operationId}`,
        });
        return;
      }
      seenOperationIds.add(operation.operationId);
    }
    // #852: mutation-episode identity + recovery-fencing invariants.
    if (
      enforceMutationEpisodeInvariants(
        state.mutationEpisodes,
        state.mutationEpisodeResolutions,
        context,
      )
    )
      return;
    // Peer-review lifecycle invariant: a structurally broken evidence
    // chain (dangling supersession, cycles, completions on superseded entries,
    // multiple authoritative incarnations) makes the STATE invalid — it must
    // fail closed at the schema boundary instead of silently collapsing to an
    // empty ProofGraph projection. The resolver is the single lifecycle
    // authority (state/peer-review.ts).
    const assurance = state.reviewAssurance;
    if (!assurance) return;
    for (const obligation of assurance.obligations) {
      if (obligation.obligationType !== 'review') continue;
      const resolved = resolveAuthoritativePeerReviewTask(
        state.peerReviewEvidence,
        obligation.obligationId,
      );
      if (resolved.kind === 'blocked') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['peerReviewEvidence'],
          message: `peer review lifecycle is invalid: ${resolved.reason}`,
        });
        return;
      }
    }
  });
export type SessionState = z.infer<typeof SessionState>;
