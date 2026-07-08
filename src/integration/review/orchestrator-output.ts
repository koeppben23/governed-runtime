/**
 * @module integration/review/orchestrator-output
 * @description Output mutation helpers — inject reviewer findings into
 *              tool output for plan/implement/architecture and standalone
 *              /review responses.
 *
 * Extracted from orchestrator.ts. Leaf module — no dependency on
 * orchestrator.ts or orchestrator-detection.ts.
 *
 * @version v1
 */

import { REVIEW_COMPLETED_PREFIX } from './orchestrator-constants.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import { parseToolResult } from '../plugin-helpers.js';

/** Subset of ReviewerSuccessResult needed for output mutation. */
interface ReviewerOutputInput {
  readonly findings: unknown;
  readonly sessionId: string;
  readonly reviewOutputMode: string;
  readonly structuredOutputUsed: boolean;
  readonly reviewAssuranceLevel: string;
  readonly extractionMethod?: string;
  readonly modelCapabilityError?: string;
}

export function buildMutatedOutput(
  originalOutput: string,
  reviewerResult: ReviewerOutputInput,
): string | null {
  if (!reviewerResult.findings) return null;

  const parsed = parseToolResult(originalOutput);
  if (!parsed || Array.isArray(parsed)) return null;

  parsed.next =
    `${REVIEW_COMPLETED_PREFIX}: The FlowGuard plugin has automatically invoked the ` +
    `${REVIEWER_SUBAGENT_TYPE} subagent. Review findings are included in ` +
    `pluginReviewFindings. Submit your reviewVerdict based on the ` +
    `overallVerdict, and include the reviewFindings object from ` +
    `pluginReviewFindings in your flowguard_plan, flowguard_architecture, or flowguard_review_implementation call.`;

  parsed.pluginReviewFindings = reviewerResult.findings;
  parsed._pluginReviewSessionId = reviewerResult.sessionId;
  parsed.pluginReviewOutput = {
    reviewOutputMode: reviewerResult.reviewOutputMode,
    structuredOutputUsed: reviewerResult.structuredOutputUsed,
    reviewAssuranceLevel: reviewerResult.reviewAssuranceLevel,
    ...(reviewerResult.extractionMethod
      ? { extractionMethod: reviewerResult.extractionMethod }
      : {}),
    ...(reviewerResult.modelCapabilityError
      ? { modelCapabilityError: reviewerResult.modelCapabilityError }
      : {}),
  };

  return JSON.stringify(parsed);
}

export function buildReviewContentMutatedOutput(
  originalOutput: string,
  reviewerResult: ReviewerOutputInput,
): string | null {
  if (!reviewerResult.findings) return null;

  const parsed = parseToolResult(originalOutput);
  if (!parsed || Array.isArray(parsed)) return null;

  parsed.next =
    `PLUGIN_REVIEW_COMPLETED: The FlowGuard plugin has automatically invoked the ` +
    `${REVIEWER_SUBAGENT_TYPE} subagent. Review findings are included in ` +
    `pluginReviewFindings. Call flowguard_review again with the same content ` +
    `input (prNumber/branch/url/text) and set reviewFindings to the ` +
    `complete pluginReviewFindings object. Do NOT modify or map the findings. ` +
    `Include attestation.toolObligationId from requiredReviewAttestation.`;

  parsed.pluginReviewFindings = reviewerResult.findings;
  parsed._pluginReviewSessionId = reviewerResult.sessionId;
  parsed.pluginReviewOutput = {
    reviewOutputMode: reviewerResult.reviewOutputMode,
    structuredOutputUsed: reviewerResult.structuredOutputUsed,
    reviewAssuranceLevel: reviewerResult.reviewAssuranceLevel,
    ...(reviewerResult.extractionMethod
      ? { extractionMethod: reviewerResult.extractionMethod }
      : {}),
    ...(reviewerResult.modelCapabilityError
      ? { modelCapabilityError: reviewerResult.modelCapabilityError }
      : {}),
  };

  return JSON.stringify(parsed);
}
