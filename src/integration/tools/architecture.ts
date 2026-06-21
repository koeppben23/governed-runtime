/**
 * @module integration/tools/architecture
 * @description FlowGuard architecture tool — public ToolDefinition facade.
 *
 * @version v2
 */

import { z } from 'zod';

import type { ToolDefinition } from './helpers.js';
import { withMutableSessionTransaction, formatError } from './helpers.js';

import { ReviewFindings as ReviewFindingsSchema } from '../../state/evidence.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import { validateInitialSubmissionGate } from './architecture-shared.js';
import { handleAdrSubmission } from './architecture-submit.js';
import { handleAdrReview } from './architecture-review.js';

export const architecture: ToolDefinition = {
  description:
    'Submit an Architecture Decision Record (ADR) OR record a self-review verdict. Two modes:\n' +
    'Mode A (submit ADR): provide title and adrText. ADR ID is auto-generated. Records the ADR and starts the review flow.\n' +
    "Mode B (review verdict): provide reviewVerdict ('accept' or 'changes_requested'). " +
    "If 'changes_requested', also provide revised adrText.\n" +
    'When subagentEnabled=true (the default for all built-in policies), the review is performed ' +
    `by the ${REVIEWER_SUBAGENT_TYPE} subagent and the verdict submission MUST include reviewFindings ` +
    'returned by that subagent. When subagentEnabled=false, the legacy LLM-driven self-review path is used.\n' +
    'The review loop runs up to maxIterations (from policy). ' +
    'On convergence, auto-advances to ARCH_REVIEW.\n' +
    'Only allowed in READY phase (starts the architecture flow) or ARCHITECTURE phase (re-submit after revision).\n' +
    'Optionally accepts reviewFindings from an independent review agent.',
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
    reviewFindings: ReviewFindingsSchema.optional().describe(
      `The ${REVIEWER_SUBAGENT_TYPE} subagent's structured findings. SDK mode only — pass the ` +
        'reviewer output verbatim. In host-task mode do NOT submit reviewFindings: the plugin ' +
        'resolves them from captured evidence, and hand-edited or mismatched findings are rejected.',
    ),
    reviewerUnavailable: z
      .boolean()
      .optional()
      .describe(
        'Set to true ONLY after a real reviewer-subagent spawn failure (Task tool fails, agent ' +
          'unavailable). This is a fail-closed signal: FlowGuard blocks with SUBAGENT_UNABLE_TO_REVIEW ' +
          'and recovery guidance. It never enables self-review and never approves the ADR.',
      ),
  },
  async execute(args, context) {
    try {
      return await withMutableSessionTransaction(context, async (session) => {
        // BUG-21: Use typeof checks — `!== undefined` is true for null (which LLMs
        // may send for absent optional fields). Defense-in-depth.
        const hasVerdict = typeof args.reviewVerdict === 'string' && args.reviewVerdict.length > 0;
        const isInitialSubmission = !hasVerdict;

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
