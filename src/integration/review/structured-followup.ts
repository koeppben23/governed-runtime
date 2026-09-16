/**
 * @module integration/review/structured-followup
 * @description Schema-constrained serialization of an already-completed native
 *              reviewer Task in the SAME visible child session.
 *
 * The native OpenCode Task transport owns execution visibility, child-session
 * identity, navigation, and permission isolation. OpenCode 1.18.30 does not
 * expose json_schema format on Task itself, so FlowGuard performs a second
 * prompt in that exact child session whose sole purpose is serialization.
 *
 * The Task text is never findings authority. Only `info.structured` from this
 * follow-up, validated against ReviewerFindingsInput, can proceed to evidence
 * binding.
 */

import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import { ReviewerFindingsInput } from '../../state/evidence-review-input.js';
import { REVIEW_FINDINGS_JSON_SCHEMA } from './findings-schema.js';
import { resolveReviewerAgent } from './agent-resolution.js';
import type { OrchestratorClient } from './types.js';

export type StructuredFollowupResult =
  | {
      readonly kind: 'ok';
      readonly findings: Record<string, unknown>;
      readonly invokedAt: string;
      readonly fulfilledAt: string;
    }
  | {
      readonly kind: 'blocked';
      readonly code:
        | 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE'
        | 'STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE'
        | 'HOST_STRUCTURED_OUTPUT_REQUIRED'
        | 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION';
      readonly reason: string;
    };

function serializationPrompt(obligationId: string): string {
  return [
    'The independent FlowGuard review in this child session is complete.',
    'Do NOT inspect additional files, call tools, or change your conclusions.',
    'Serialize exactly the findings you concluded in the immediately preceding review as one ReviewerFindingsInput.',
    `Set attestation.toolObligationId exactly to "${obligationId}".`,
    'Preserve the original overallVerdict, findings, relations, evidence locations, missing verification, challenges, and challenge-resolution verdicts.',
    'If the completed review cannot be represented faithfully, use overallVerdict="unable_to_review" rather than inventing or repairing evidence.',
    'This prompt is serialization only; it is not a second review.',
  ].join('\n');
}

function classifyInfoError(error: unknown): StructuredFollowupResult | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as Record<string, unknown>;
  const data =
    value.data && typeof value.data === 'object' ? (value.data as Record<string, unknown>) : undefined;
  const text = `${typeof value.message === 'string' ? value.message : ''} ${
    typeof data?.message === 'string' ? data.message : ''
  }`.toLowerCase();
  if (text.includes('thinking mode does not support this tool_choice')) {
    return {
      kind: 'blocked',
      code: 'STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE',
      reason:
        `The visible ${REVIEWER_SUBAGENT_TYPE} child cannot serialize structured findings while its current reasoning mode conflicts with the host structured-output tool.`,
    };
  }
  if (
    text.includes('does not support') &&
    ['tool_choice', 'tools', 'function calling', 'structured output'].some((term) => text.includes(term))
  ) {
    return {
      kind: 'blocked',
      code: 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
      reason: `The visible ${REVIEWER_SUBAGENT_TYPE} child model does not support the required structured-output serialization.`,
    };
  }
  return null;
}

/** Serialize findings from an existing visible reviewer child. Never creates a child. */
export async function captureStructuredFindingsFromVisibleChild(
  client: OrchestratorClient,
  input: { readonly childSessionId: string; readonly obligationId: string },
): Promise<StructuredFollowupResult> {
  let agent: string;
  try {
    agent = await resolveReviewerAgent(client);
  } catch (error) {
    return {
      kind: 'blocked',
      code: 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE',
      reason: `The required ${REVIEWER_SUBAGENT_TYPE} agent is unavailable for same-child structured serialization: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const invokedAt = new Date().toISOString();
  const response = await client.session.prompt({
    path: { id: input.childSessionId },
    body: {
      agent,
      parts: [{ type: 'text', text: serializationPrompt(input.obligationId) }],
      format: { type: 'json_schema', schema: REVIEW_FINDINGS_JSON_SCHEMA, retryCount: 1 },
    },
  });

  if (response.error || !response.data) {
    return {
      kind: 'blocked',
      code: 'HOST_STRUCTURED_OUTPUT_REQUIRED',
      reason: `OpenCode did not return structured findings from the visible reviewer child: ${
        response.error instanceof Error ? response.error.message : String(response.error ?? 'missing response')
      }`,
    };
  }

  if (response.data.info?.error?.name === 'StructuredOutputError') {
    return {
      kind: 'blocked',
      code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
      reason: 'OpenCode rejected the reviewer structured-output serialization after its schema retry budget.',
    };
  }
  const classified = classifyInfoError(response.data.info?.error);
  if (classified) return classified;

  const structured = response.data.info?.structured;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
    return {
      kind: 'blocked',
      code: 'HOST_STRUCTURED_OUTPUT_REQUIRED',
      reason: 'OpenCode completed the reviewer follow-up without host-validated structured output.',
    };
  }
  const parsed = ReviewerFindingsInput.safeParse(structured);
  if (!parsed.success) {
    return {
      kind: 'blocked',
      code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
      reason: `OpenCode returned structured reviewer output outside the canonical ReviewerFindingsInput contract: ${parsed.error.message}`,
    };
  }

  return {
    kind: 'ok',
    findings: parsed.data as Record<string, unknown>,
    invokedAt,
    fulfilledAt: new Date().toISOString(),
  };
}
