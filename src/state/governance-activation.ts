/** Durable opt-in authority, independent of workflow state and host SDK shapes. */
import { z } from 'zod';
import { HostCallIdentity, HostCallIdentitySchema } from './host-identity.js';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const GovernanceActivationStatus = z.enum(['activating', 'active', 'ending', 'inactive']);
export const GovernanceActivationRevision = z
  .object({
    schemaVersion: z.literal(1),
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
