/**
 * @module session-state-config-shape
 * @description SessionState configuration and session-identity schema group:
 *              active profile/checks, policy snapshot, and initiator/actor
 *              identity.
 *
 * @version v1
 */

import { z } from 'zod';
import {
  ActorInfoSchema,
  CheckId,
  DecisionIdentitySchema,
  PolicySnapshotSchema,
} from './evidence.js';

/**
 * Configuration and session-identity fields of {@link SessionState}.
 * Spread into the canonical SessionState object shape.
 */
export const SessionStateConfigShape = {
  /**
   * Active profile information — resolved at hydrate time.
   * Contains the profile ID, name, and LLM rule content.
   * The ruleContent is the stack-specific guidance text injected into
   * tool responses when commands reference "profile rules".
   * phaseRuleContent maps Phase values to additional phase-specific text
   * that is appended to ruleContent when the session is in that phase.
   * Null only if no profile was resolved (should not happen — baseline is always available).
   */
  activeProfile: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      ruleContent: z.string(),
      phaseRuleContent: z.record(z.string(), z.string()).optional(),
    })
    .nullable(),

  /**
   * Active validation checks for this session.
   * Derived from verificationCandidates at hydrate-time (unique kinds).
   * Empty if no verification commands were discovered.
   */
  activeChecks: z.array(CheckId),

  /**
   * Immutable policy snapshot — frozen at session creation.
   * Records which FlowGuard rules governed this session.
   * Its digest supports integrity comparison against a trusted reference.
   */
  policySnapshot: PolicySnapshotSchema,

  /**
   * Identity of the session initiator (author).
   * Set once at hydrate time, never mutated.
   * Used for regulated approval four-eyes enforcement:
   * initiatedBy !== reviewDecision.decisionIdentity.actorId (approve path).
   *
   * P30: For regulated sessions, this MUST be a known actor identity,
   * not the technical session ID. Use initiatedByIdentity for full provenance.
   */
  initiatedBy: z.string().min(1),

  /**
   * Structured initiator identity for regulated approval (P30).
   * Persists actor identity at session creation for four-eyes proof.
   * Required for regulated mode.
   */
  initiatedByIdentity: DecisionIdentitySchema.optional(),

  /**
   * Resolved actor identity at hydrate time (P27).
   * Best-effort operator identity — NOT an authentication claim.
   * Absent when no actor identity was resolved; null is not a valid state value.
   */
  actorInfo: ActorInfoSchema.optional(),
};
