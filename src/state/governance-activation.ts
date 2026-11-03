/** Durable opt-in authority, independent of workflow state and host SDK shapes. */
import { z } from 'zod';
import { HostCallIdentity, HostCallIdentitySchema } from './host-identity.js';
import { ActorAssuranceSchema } from '../shared/actor-assurance.js';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const GovernanceActivationStatus = z.enum(['activating', 'active', 'ending', 'inactive']);

/**
 * Channel through which an activation decision reached FlowGuard. It records how
 * the decision arrived, never who a human is: `host_command` is a native host
 * command callback, which cannot distinguish UI input from an SDK or agent caller;
 * `autonomous` is an explicitly permitted nonhuman start; `delegation` is a child
 * enrollment inheriting its root decision.
 */
export const GovernanceDecisionSource = z.enum(['host_command', 'autonomous', 'delegation']);
export type GovernanceDecisionSource = z.infer<typeof GovernanceDecisionSource>;

/**
 * Canonically resolved decision actor (same vocabulary as `DecisionIdentity`),
 * stored as plain JSON in host storage: every field is present, absence is `null`.
 */
export const GovernanceDecisionActor = z
  .object({
    actorId: z.string().trim().min(1),
    actorEmail: z.string().nullable(),
    actorDisplayName: z.string().nullable(),
    actorSource: z.enum(['env', 'git', 'claim', 'oidc', 'unknown']),
    actorAssurance: ActorAssuranceSchema,
  })
  .strict()
  .readonly();
export type GovernanceDecisionActor = z.infer<typeof GovernanceDecisionActor>;
export const GovernanceActivationRevision = z
  .object({
    schemaVersion: z.literal(2),
    sessionId: z.string().min(1),
    rootSessionId: z.string().min(1),
    activationId: z.string().uuid(),
    generation: z.number().int().positive(),
    revision: z.number().int().positive(),
    status: GovernanceActivationStatus,
    directory: z.string().min(1),
    worktreeRoot: z.string().min(1),
    policyDigest: Digest,
    decisionId: z.string().min(1),
    decisionSource: GovernanceDecisionSource,
    /** Canonically resolved actor of the decision; its assurance is not raised by the source. */
    decisionActor: GovernanceDecisionActor,
    previousDigest: Digest.nullable(),
    parentDispatch: HostCallIdentity.nullable(),
  })
  .strict()
  .readonly();
export type GovernanceActivationRevision = z.infer<typeof GovernanceActivationRevision>;

export const GovernanceActivationHead = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().min(1),
    revision: z.number().int().positive(),
    digest: Digest,
  })
  .strict()
  .readonly();
export type GovernanceActivationHead = z.infer<typeof GovernanceActivationHead>;

/** Never removed by EndGovernance. Independent of the revision namespace so
 * loss of an entire session journal cannot masquerade as initial absence. */
export const GovernanceEnrollment = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().min(1),
    firstActivationId: z.string().uuid(),
  })
  .strict()
  .readonly();
export type GovernanceEnrollment = z.infer<typeof GovernanceEnrollment>;

export type GovernanceActivationAction = 'start' | 'activate' | 'begin_end' | 'end' | 'enroll';

/** A dispatch is an authorization, not a claim that the child has completed. */
export const GovernanceDelegationDispatch = HostCallIdentitySchema.extend({
  schemaVersion: z.literal(1),
  rootSessionId: z.string().min(1),
  activationId: z.string().uuid(),
  generation: z.number().int().positive(),
  agent: z.string().min(1),
  requestedChildSessionId: z.string().min(1).nullable(),
})
  .strict()
  .readonly();
export type GovernanceDelegationDispatch = z.infer<typeof GovernanceDelegationDispatch>;
