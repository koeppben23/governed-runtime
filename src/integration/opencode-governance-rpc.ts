/** Public native RPC contract. Transport input never supplies actor or provenance. */
import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';
import { POLICY_DIGEST_PATTERN } from '../state/evidence-identifiers.js';
import { PolicyModeSchema } from '../state/policy-mode.js';

export const AutonomousStartRequest = z
  .object({
    sessionID: z.string().min(1),
    worktreeRoot: z.string().min(1),
    policyDigest: z.string().regex(POLICY_DIGEST_PATTERN),
    policyMode: PolicyModeSchema.optional(),
  })
  .strict();
export type AutonomousStartRequest = z.infer<typeof AutonomousStartRequest>;

export const AutonomousStartResult = z.union([
  z
    .object({
      kind: z.enum(['activated', 'already_active']),
      activationId: z.string().uuid(),
    })
    .strict(),
  z.object({ kind: z.literal('blocked'), code: z.string(), reason: z.string() }).strict(),
]);

export const FlowGuardGovernance = Rpc.define({
  id: 'flowguard-governance',
  methods: {
    StartGovernance: {
      input: AutonomousStartRequest,
      output: AutonomousStartResult,
      errors: {},
    },
  },
  events: {},
});
