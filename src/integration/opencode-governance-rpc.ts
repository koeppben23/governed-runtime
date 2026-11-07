/** Public native RPC contract. Transport input never supplies actor or provenance. */
import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';
import { POLICY_DIGEST_PATTERN } from '../state/evidence-identifiers.js';
import { PolicyModeSchema } from '../state/policy-mode.js';
import { DecisionBinding } from './status/decision-binding.js';
import { NextActionRequest, NextActionResult } from './status/next-action-projection.js';
import {
  WorkbenchReviewRequest,
  WorkbenchReviewResult,
} from './status/workbench-review-projection.js';

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

export const NextActionDecisionRequest = z
  .object({
    sessionID: z.string().min(1),
    invocation: z.string().min(1),
    rationale: z.string().max(4_000).optional(),
    expected: DecisionBinding,
  })
  .strict();
export type NextActionDecisionRequest = z.infer<typeof NextActionDecisionRequest>;

export const NextActionDecisionResult = z.union([
  z.object({ kind: z.literal('applied'), invocation: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('blocked'), code: z.string().min(1), reason: z.string() }).strict(),
]);
export type NextActionDecisionResult = z.infer<typeof NextActionDecisionResult>;

export const FlowGuardGovernance = Rpc.define({
  id: 'flowguard-governance',
  methods: {
    StartGovernance: {
      input: AutonomousStartRequest,
      output: AutonomousStartResult,
      errors: {},
    },
    GetNextAction: {
      input: NextActionRequest,
      output: NextActionResult,
      errors: {},
    },
    GetWorkbenchReview: {
      input: WorkbenchReviewRequest,
      output: WorkbenchReviewResult,
      errors: {},
    },
    SubmitDecision: {
      input: NextActionDecisionRequest,
      output: NextActionDecisionResult,
      errors: {},
    },
  },
  events: {},
});
