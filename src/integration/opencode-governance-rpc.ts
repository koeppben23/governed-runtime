/** Public native RPC contract. Transport input never supplies actor or provenance. */
import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';
import { SystemWorkOperation } from '../state/system-work.js';
import { POLICY_DIGEST_PATTERN } from '../state/evidence-identifiers.js';
import { PolicyModeSchema } from '../state/policy-mode.js';
import { DecisionBinding } from './status/decision-binding.js';
import { NextActionRequest, NextActionResult } from './status/next-action-projection.js';
import {
  WorkbenchDiagnosticsRequest,
  WorkbenchDiagnosticsResult,
} from './status/workbench-diagnostics-projection.js';
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

export const PresentationEventSchema = z
  .object({
    id: z.string().min(1).max(128),
    operation: SystemWorkOperation,
    runID: z.string().uuid(),
    stage: z.enum(['starting', 'check_started', 'check_finished', 'finished']),
    sessionID: z.string().min(1),
    kind: z.literal('validation'),
    message: z.string().max(32768),
    phase: z.literal('VALIDATION').optional(),
    checks: z.array(z.string().max(128)).max(32).optional(),
    occurredAt: z.string().min(1).max(64),
  })
  .strict();
export type PresentationEvent = z.infer<typeof PresentationEventSchema>;

export const PresentationRequest = z
  .object({
    sessionID: z.string().min(1),
    after: z.string().min(1).max(128).optional(),
  })
  .strict();
export type PresentationRequest = z.infer<typeof PresentationRequest>;

export const PresentationResult = z
  .object({
    sessionID: z.string().min(1),
    events: z.array(PresentationEventSchema).max(64),
    cursor: z.string().max(128).nullable(),
  })
  .strict();
export type PresentationResult = z.infer<typeof PresentationResult>;

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
    GetWorkbenchDiagnostics: {
      input: WorkbenchDiagnosticsRequest,
      output: WorkbenchDiagnosticsResult,
      errors: {},
    },
    /** Read-only, ephemeral host presentation; never workflow or audit evidence. */
    GetPresentation: {
      input: PresentationRequest,
      output: PresentationResult,
      errors: {},
    },
    SubmitDecision: {
      input: NextActionDecisionRequest,
      output: NextActionDecisionResult,
      errors: {},
    },
  },
  events: {
    PresentationUpdated: { schema: z.object({ sessionID: z.string().min(1) }).strict() },
  },
});
