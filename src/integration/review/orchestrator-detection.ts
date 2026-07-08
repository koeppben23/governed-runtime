/**
 * @module integration/review/orchestrator-detection
 * @description Review-required detection helpers — determine whether
 *              a tool output signals INDEPENDENT_REVIEW_REQUIRED and
 *              extract review context from FlowGuard tool responses.
 *
 * Extracted from orchestrator.ts. Leaf module — no dependency on
 * orchestrator.ts or orchestrator-output.ts.
 *
 * @version v1
 */

import { REVIEW_REQUIRED_PREFIX } from './enforcement/types.js';
import { TOOL_FLOWGUARD_PLAN, TOOL_FLOWGUARD_REVIEW } from '../tool-names.js';
import { parseToolResult } from '../plugin-helpers.js';

export function isReviewRequired(toolOutput: string, toolName?: string): boolean {
  const parsed = parseToolResult(toolOutput);
  if (!parsed || Array.isArray(parsed)) return false;
  const next = typeof parsed.next === 'string' ? parsed.next : '';
  if (next.startsWith(REVIEW_REQUIRED_PREFIX)) return true;
  if (
    toolName === TOOL_FLOWGUARD_REVIEW &&
    parsed.error === true &&
    parsed.code === 'CONTENT_ANALYSIS_REQUIRED' &&
    typeof parsed.requiredReviewAttestation === 'object'
  ) {
    return true;
  }
  return false;
}

export function extractReviewContext(
  toolName: string,
  toolOutput: Record<string, unknown>,
): {
  iteration: number;
  planVersion: number;
  obligationId: string;
  criteriaVersion: string;
  mandateDigest: string;
} | null {
  if (toolName === TOOL_FLOWGUARD_REVIEW) return extractStandaloneReviewContext(toolOutput);
  const obligation = extractReviewObligationFields(toolOutput);
  const next = typeof toolOutput.next === 'string' ? toolOutput.next : '';
  const iteration = obligation.iteration ?? numberFromNext(next, 'iteration');
  const planVersion = obligation.planVersion ?? numberFromNext(next, 'planVersion');
  if (!obligation.obligationId || !obligation.criteriaVersion || !obligation.mandateDigest)
    return null;
  if (iteration === null || planVersion === null) return null;
  if (!matchesPlanSelfReviewIteration(toolName, toolOutput, iteration)) return null;
  return {
    iteration,
    planVersion,
    obligationId: obligation.obligationId,
    criteriaVersion: obligation.criteriaVersion,
    mandateDigest: obligation.mandateDigest,
  };
}

// ─── Private Helpers ──────────────────────────────────────────────────────────

interface ExtractedReviewObligationFields {
  readonly obligationId: string | null;
  readonly criteriaVersion: string | null;
  readonly mandateDigest: string | null;
  readonly iteration: number | null;
  readonly planVersion: number | null;
}

function extractStandaloneReviewContext(
  toolOutput: Record<string, unknown>,
): ReturnType<typeof extractReviewContext> {
  const att = toolOutput.requiredReviewAttestation as Record<string, unknown> | undefined;
  const obligationId = stringValue(att?.toolObligationId);
  const mandateDigest = stringValue(att?.mandateDigest);
  const criteriaVersion = stringValue(att?.criteriaVersion);
  if (!obligationId || !mandateDigest || !criteriaVersion) return null;
  return { iteration: 1, planVersion: 1, obligationId, criteriaVersion, mandateDigest };
}

function extractReviewObligationFields(
  toolOutput: Record<string, unknown>,
): ExtractedReviewObligationFields {
  const obligation = reviewObligationObject(toolOutput);
  return {
    obligationId:
      stringValue(obligation?.obligationId) ?? stringValue(toolOutput.reviewObligationId),
    criteriaVersion:
      stringValue(obligation?.criteriaVersion) ?? stringValue(toolOutput.reviewCriteriaVersion),
    mandateDigest:
      stringValue(obligation?.mandateDigest) ?? stringValue(toolOutput.reviewMandateDigest),
    iteration:
      numberValue(obligation?.iteration) ?? numberValue(toolOutput.reviewObligationIteration),
    planVersion:
      numberValue(obligation?.planVersion) ?? numberValue(toolOutput.reviewObligationPlanVersion),
  };
}

function reviewObligationObject(
  toolOutput: Record<string, unknown>,
): Record<string, unknown> | null {
  const value = toolOutput.reviewObligation;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function numberFromNext(next: string, key: 'iteration' | 'planVersion'): number | null {
  const match = next.match(new RegExp(`${key}[=:\\s]+(\\d+)`, 'i'));
  return match ? parseInt(match[1]!, 10) : null;
}

function matchesPlanSelfReviewIteration(
  toolName: string,
  toolOutput: Record<string, unknown>,
  iteration: number,
): boolean {
  if (toolName !== TOOL_FLOWGUARD_PLAN) return true;
  const selfReviewIteration = toolOutput.selfReviewIteration;
  return typeof selfReviewIteration !== 'number' || selfReviewIteration === iteration;
}
