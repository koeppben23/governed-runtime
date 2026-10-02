/**
 * @module integration/tools/architecture/architecture
 * @description FlowGuard architecture tool — public ToolDefinition facade.
 *
 * @version v2
 */

import { z } from 'zod';

import type { ToolDefinition } from '../helpers.js';
import { formatError } from '../error-format.js';
import { withMutableSessionTransaction } from '../helpers.js';

import { ArchitectureClaimDeclarationInput as ArchitectureClaimDeclarationSchema } from '../../../state/proofgraph-approval.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import {
  validateArchitectureCallShape,
  validateInitialSubmissionGate,
} from './architecture-shared.js';
import {
  routeArchitectureInitialSubmission,
  routeArchitectureTransportRecovery,
} from './architecture-restart.js';
import { classifyToolCallMode } from '../review-validation-mode.js';
import { handleAdrSubmission } from './architecture-submit.js';
import { handleAdrReview } from './architecture-review.js';

export const architecture: ToolDefinition = {
  description:
    'Submit an Architecture Decision Record (ADR) OR record the independent reviewer verdict. Two modes:\n' +
    'Mode A (submit ADR): provide title and adrText. ADR ID is auto-generated. Records the ADR and starts the review flow.\n' +
    "Mode B (review verdict): provide reviewVerdict only ('accept' or 'changes_requested'). " +
    "If 'changes_requested', also provide revised adrText.\n" +
    `Review is performed by the ${REVIEWER_SUBAGENT_TYPE} and the host captures its structured findings. ` +
    'FlowGuard resolves those captured findings automatically — submit the verdict only and never reviewer findings. ' +
    'There is no self-review fallback and reviewer unavailability always fails closed. ' +
    'On a technical reviewer transport/capture failure, submit reviewRecovery: "retry_transport" ' +
    'to re-arm the frozen ADR review obligation without creating a new ADR revision.\n' +
    'The review loop runs up to maxIterations (from policy). ' +
    'On convergence, advances to the ARCH_REVIEW human gate; reviewer acceptance is not user approval.\n' +
    'Only allowed in READY phase (starts the architecture flow) or ARCHITECTURE phase (re-submit after revision).',
  args: {
    title: z
      .string()
      .optional()
      .describe('Short title of the architecture decision. Required for Mode A.'),
    adrText: z
      .string()
      .optional()
      .describe(
        'Full ADR body in MADR Markdown format. ' +
          'Must include ## Context, ## Decision, and ## Consequences sections. ' +
          "Required for Mode A and when reviewVerdict is 'changes_requested'.",
      ),
    claims: z
      .array(ArchitectureClaimDeclarationSchema)
      .optional()
      .describe(
        'Pre-evidence claims made by this ADR version. Each identifies its governing ADR section and is bound into any human approval certificate. claimId is host-owned and must not be supplied.',
      ),
    reviewVerdict: z
      .enum(['accept', 'changes_requested'])
      .optional()
      .describe(
        "The INDEPENDENT REVIEWER's verdict on the ADR — NOT user approval. " +
          'Omit for initial ADR submission. ' +
          "'accept' = the reviewer accepts the ADR; the loop converges and advances to the " +
          'ARCH_REVIEW user gate (the user still approves via /review-decision). ' +
          "'changes_requested' = the ADR needs revision; provide updated adrText.",
      ),
    reviewerUnavailable: z
      .boolean()
      .optional()
      .describe(
        'Set to true ONLY after a real reviewer-subagent spawn failure (Task tool fails, agent ' +
          'unavailable). This is a fail-closed signal: FlowGuard blocks with SUBAGENT_UNABLE_TO_REVIEW ' +
          'and recovery guidance. It never enables self-review and never approves the ADR.',
      ),
    reviewRecovery: z
      .literal('retry_transport')
      .optional()
      .describe(
        'Typed transport-recovery intent. ONLY when the authorized native reviewer Task release ' +
          'was technically interrupted or yielded no bindable evidence: re-emits the pending ' +
          'review dispatch for the current attempt, or re-arms a fresh attempt on the SAME frozen ' +
          'ADR subject after a released dispatch. Never a verdict, never approval, and never a ' +
          'new ADR revision.',
      ),
    targetPaths: z
      .array(z.string())
      .optional()
      .describe(
        'Optional Mode A hint: file paths this architecture decision will touch. An ADR carries no ' +
          'diff, so challenge classification derives from the persisted discovery risk surfaces; ' +
          'these paths are UNIONED with those surfaces (never replace them) and can only raise the ' +
          'required challenge count, never lower it.',
      ),
  },
  async execute(args, context) {
    try {
      return await withMutableSessionTransaction(context, async (session) => {
        // Mode routing uses the canonical classifier (single authority).
        const mode = classifyToolCallMode('architecture', {
          text: args.adrText,
          reviewVerdict: args.reviewVerdict,
          reviewerUnavailable: args.reviewerUnavailable,
          reviewRecovery: args.reviewRecovery,
        });
        const isInitialSubmission = mode.kind === 'initial_submission';

        // Call-shape validation runs FIRST: mixed inputs are rejected before
        // any lifecycle routing can re-emit a review instruction.
        const shapeBlocked = validateArchitectureCallShape(args);
        if (shapeBlocked) return shapeBlocked;

        // Typed transport recovery re-emits or durably re-arms the pending
        // review on the SAME frozen ADR obligation; it never creates a new ADR
        // identity or revision.
        if (mode.kind === 'transport_recovery') {
          return routeArchitectureTransportRecovery(session);
        }

        if (isInitialSubmission) {
          // Re-invocation routing for an existing architecture obligation:
          // output-repair reissue, attempt re-emission, or review orchestration
          // restart/revision after a blocked obligation. Never a new ADR.
          const routed = await routeArchitectureInitialSubmission(args, session);
          if (routed !== null) return routed;
        }

        const gateBlocked = validateInitialSubmissionGate(args, session.state, isInitialSubmission);
        if (gateBlocked) return gateBlocked;

        if (isInitialSubmission) {
          return handleAdrSubmission(args, session);
        }
        return handleAdrReview(args, context, session);
      });
    } catch (err) {
      return formatError(err);
    }
  },
};
