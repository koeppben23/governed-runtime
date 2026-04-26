/**
 * @module integration/review-orchestrator
 * @description Deterministic review subagent invocation via OpenCode SDK.
 *
 * Problem: The primary agent decides whether to call the reviewer subagent
 * based on text instructions in the tool response `next` field. This is
 * probabilistic — the LLM may ignore the instruction, fabricate findings,
 * or skip the call entirely.
 *
 * Solution: This module provides programmatic invocation of the reviewer
 * subagent via the OpenCode SDK client. The plugin's tool.execute.after
 * hook calls this orchestrator when a FlowGuard tool response signals
 * INDEPENDENT_REVIEW_REQUIRED. The orchestrator:
 *
 * 1. Builds a structured prompt with plan/implementation text and context
 * 2. Creates a child session via client.session.create()
 * 3. Sends the prompt to the flowguard-reviewer agent via client.session.prompt()
 * 4. Parses the reviewer's JSON ReviewFindings response
 * 5. Returns the findings for the plugin to inject into the tool output
 *
 * Graceful degradation: If any step fails, returns null. If the reviewer
 * responds but the response is not parseable as structured ReviewFindings,
 * the orchestrator signals failure (null mutation) — fail-closed. The
 * plugin preserves the original tool output with INDEPENDENT_REVIEW_REQUIRED,
 * falling back to the probabilistic flow where the LLM calls the Task tool
 * manually. Enforcement (L1-L4) still gates the verdict submission.
 *
 * Contract: INDEPENDENT_REVIEW_COMPLETED is only signaled when structured
 * ReviewFindings (with overallVerdict + blockingIssues) are available.
 * Unparseable reviewer responses never produce COMPLETED.
 *
 * Conformance: Uses documented OpenCode SDK client API
 * per https://opencode.ai/docs/plugins
 *
 * @version v1
 */

import { REVIEW_REQUIRED_PREFIX, REVIEWER_SUBAGENT_TYPE } from './review-enforcement.js';
import { TOOL_FLOWGUARD_PLAN } from './tool-names.js';

export const REVIEW_FINDINGS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    iteration: { type: 'integer', minimum: 0 },
    planVersion: { type: 'integer', minimum: 1 },
    reviewMode: { type: 'string', enum: ['subagent', 'self'] },
    overallVerdict: { type: 'string', enum: ['approve', 'changes_requested'] },
    blockingIssues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          category: {
            type: 'string',
            enum: ['completeness', 'correctness', 'feasibility', 'risk', 'quality'],
          },
          message: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['severity', 'category', 'message'],
      },
    },
    majorRisks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          category: {
            type: 'string',
            enum: ['completeness', 'correctness', 'feasibility', 'risk', 'quality'],
          },
          message: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['severity', 'category', 'message'],
      },
    },
    missingVerification: { type: 'array', items: { type: 'string' } },
    scopeCreep: { type: 'array', items: { type: 'string' } },
    unknowns: { type: 'array', items: { type: 'string' } },
    reviewedBy: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        actorId: { type: 'string' },
        actorSource: { type: 'string', enum: ['env', 'git', 'claim', 'unknown'] },
        actorAssurance: {
          type: 'string',
          enum: ['best_effort', 'claim_validated', 'idp_verified'],
        },
      },
      required: ['sessionId'],
    },
    reviewedAt: { type: 'string' },
    attestation: {
      type: 'object',
      properties: {
        mandateDigest: { type: 'string' },
        criteriaVersion: { type: 'string' },
        toolObligationId: { type: 'string' },
        iteration: { type: 'integer', minimum: 0 },
        planVersion: { type: 'integer', minimum: 1 },
        reviewedBy: { type: 'string', const: REVIEWER_SUBAGENT_TYPE },
      },
      required: [
        'mandateDigest',
        'criteriaVersion',
        'toolObligationId',
        'iteration',
        'planVersion',
        'reviewedBy',
      ],
    },
  },
  required: [
    'iteration',
    'planVersion',
    'reviewMode',
    'overallVerdict',
    'blockingIssues',
    'majorRisks',
    'missingVerification',
    'scopeCreep',
    'unknowns',
    'reviewedBy',
    'reviewedAt',
    'attestation',
  ],
  additionalProperties: false,
} as const;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal SDK client interface for the orchestrator.
 *
 * Mirrors the subset of OpencodeClient used by this module.
 * Defined as an interface (not imported from SDK) so this module
 * has zero runtime SDK dependency — testable with plain mocks.
 */
export interface OrchestratorClient {
  session: {
    create(opts: {
      body?: { parentID?: string; title?: string };
    }): Promise<{ data?: { id: string } | undefined; error?: unknown }>;
    prompt(opts: {
      path: { id: string };
      body: {
        agent?: string;
        parts: Array<{ type: string; text: string }>;
        format?: {
          type: 'json_schema';
          schema: Record<string, unknown>;
        };
      };
    }): Promise<{
      data?:
        | {
            parts?: Array<{ type?: string; text?: string }>;
            info?: {
              structured_output?: unknown;
              error?: { name: string; message: string };
            };
          }
        | undefined;
      error?: unknown;
    }>;
  };
}

/** Options for building a plan review prompt. */
export interface PlanReviewPromptOpts {
  /** The plan text to review. */
  readonly planText: string;
  /** The ticket text for context. */
  readonly ticketText: string;
  /** The current self-review iteration (0-based). */
  readonly iteration: number;
  /** The plan version number. */
  readonly planVersion: number;
  /** Strict review obligation identifier. */
  readonly obligationId: string;
  /** Strict criteria version string. */
  readonly criteriaVersion: string;
  /** Strict mandate digest. */
  readonly mandateDigest: string;
}

/** Options for building an implementation review prompt. */
export interface ImplReviewPromptOpts {
  /** List of changed files. */
  readonly changedFiles: string[];
  /** The approved plan text. */
  readonly planText: string;
  /** The ticket text for context. */
  readonly ticketText: string;
  /** The current review iteration (1-based). */
  readonly iteration: number;
  /** The plan version number. */
  readonly planVersion: number;
  /** Strict review obligation identifier. */
  readonly obligationId: string;
  /** Strict criteria version string. */
  readonly criteriaVersion: string;
  /** Strict mandate digest. */
  readonly mandateDigest: string;
}

/** Result of a successful reviewer invocation. */
export interface ReviewerResult {
  /** The child session ID used for the review. */
  readonly sessionId: string;
  /** The raw response text from the reviewer. */
  readonly rawResponse: string;
  /** Parsed ReviewFindings JSON, or null if parsing failed. */
  readonly findings: Record<string, unknown> | null;
}

/** Result of the full orchestration (including output mutation). */
export interface OrchestrationResult {
  /** Whether the orchestration succeeded and output was mutated. */
  readonly success: boolean;
  /** The reviewer result, if invocation succeeded. */
  readonly reviewerResult: ReviewerResult | null;
  /** The mutated output JSON string, if successful. */
  readonly mutatedOutput: string | null;
  /** Error message if orchestration failed. */
  readonly error: string | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Prefix used in the mutated output to indicate review was completed by plugin. */
export const REVIEW_COMPLETED_PREFIX = 'INDEPENDENT_REVIEW_COMPLETED';

/** Title for the reviewer child session. */
const REVIEWER_SESSION_TITLE = 'FlowGuard Independent Review';

// ─── Prompt Builders ─────────────────────────────────────────────────────────

/**
 * Build a prompt for plan review by the flowguard-reviewer subagent.
 *
 * The prompt includes all context needed for a meaningful review:
 * plan text, ticket text, iteration, and planVersion. These values
 * are also used by Level 3 (Prompt Integrity) enforcement.
 *
 * @param opts - Plan review context
 * @returns Prompt text string
 */
export function buildPlanReviewPrompt(opts: PlanReviewPromptOpts): string {
  const {
    planText,
    ticketText,
    iteration,
    planVersion,
    obligationId,
    criteriaVersion,
    mandateDigest,
  } = opts;
  return [
    `You are reviewing a plan for iteration=${iteration}, planVersion=${planVersion}.`,
    '',
    '## Ticket',
    '',
    ticketText,
    '',
    '## Plan to Review',
    '',
    planText,
    '',
    '## Instructions',
    '',
    'Review this plan against the ticket requirements. Follow your review criteria',
    'for plans. Return your findings as a single JSON object matching the',
    'ReviewFindings schema. Use the exact iteration and planVersion values above.',
    `Set iteration=${iteration} and planVersion=${planVersion} in your response.`,
    `Set attestation.toolObligationId=${obligationId}.`,
    `Set attestation.criteriaVersion=${criteriaVersion}.`,
    `Set attestation.mandateDigest=${mandateDigest}.`,
    'Set attestation.reviewedBy="flowguard-reviewer".',
  ].join('\n');
}

/**
 * Build a prompt for implementation review by the flowguard-reviewer subagent.
 *
 * @param opts - Implementation review context
 * @returns Prompt text string
 */
export function buildImplReviewPrompt(opts: ImplReviewPromptOpts): string {
  const {
    changedFiles,
    planText,
    ticketText,
    iteration,
    planVersion,
    obligationId,
    criteriaVersion,
    mandateDigest,
  } = opts;
  return [
    `You are reviewing an implementation for iteration=${iteration}, planVersion=${planVersion}.`,
    '',
    '## Ticket',
    '',
    ticketText,
    '',
    '## Approved Plan',
    '',
    planText,
    '',
    '## Changed Files',
    '',
    changedFiles.map((f) => `- ${f}`).join('\n'),
    '',
    '## Instructions',
    '',
    'Review this implementation against the approved plan and ticket.',
    'Read the changed files using the read/glob/grep tools to verify correctness.',
    'Follow your review criteria for implementations.',
    'Return your findings as a single JSON object matching the ReviewFindings schema.',
    `Set iteration=${iteration} and planVersion=${planVersion} in your response.`,
    `Set attestation.toolObligationId=${obligationId}.`,
    `Set attestation.criteriaVersion=${criteriaVersion}.`,
    `Set attestation.mandateDigest=${mandateDigest}.`,
    'Set attestation.reviewedBy="flowguard-reviewer".',
  ].join('\n');
}

// ─── SDK Invocation ──────────────────────────────────────────────────────────

/**
 * Invoke the flowguard-reviewer subagent via the OpenCode SDK client.
 *
 * Creates a child session, sends the prompt to the reviewer agent,
 * waits for the response, and extracts the text content.
 *
 * @param client - OpenCode SDK client (from plugin context)
 * @param prompt - The review prompt text
 * @param parentSessionId - Parent session ID for child session linkage
 * @returns ReviewerResult on success, null on failure
 */
export async function invokeReviewer(
  client: OrchestratorClient,
  prompt: string,
  parentSessionId: string,
): Promise<ReviewerResult | null> {
  // 1. Create a child session linked to the parent
  const createResult = await client.session.create({
    body: {
      parentID: parentSessionId,
      title: REVIEWER_SESSION_TITLE,
    },
  });

  if (createResult.error || !createResult.data?.id) {
    return null;
  }

  const childSessionId = createResult.data.id;

  // 2. Send the prompt to the reviewer agent and wait for response
  const promptResult = await client.session.prompt({
    path: { id: childSessionId },
    body: {
      agent: REVIEWER_SUBAGENT_TYPE,
      parts: [{ type: 'text', text: prompt }],
      format: { type: 'json_schema', schema: REVIEW_FINDINGS_JSON_SCHEMA },
    },
  });

  if (promptResult.error || !promptResult.data) {
    return null;
  }

  const info = promptResult.data.info;

  if (info?.error && info.error.name === 'StructuredOutputError') {
    return null;
  }

  if (!info?.structured_output) {
    return null;
  }

  return {
    sessionId: childSessionId,
    rawResponse: JSON.stringify(info.structured_output),
    findings: info.structured_output as Record<string, unknown>,
  };
}

// ─── Response Parsing ────────────────────────────────────────────────────────

/**
 * Extract text content from response parts array.
 *
 * The SDK returns an array of Part objects. We concatenate all text
 * parts to get the full response. Handles various Part shapes defensively.
 *
 * @param parts - Response parts array from SDK
 * @returns Concatenated text content, or null if no text found
 */
export function extractResponseText(
  parts: Array<{ type?: string; text?: string }> | undefined | null,
): string | null {
  if (!parts || !Array.isArray(parts)) return null;

  const textParts: string[] = [];
  for (const part of parts) {
    if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      textParts.push(part.text);
    }
  }

  const combined = textParts.join('').trim();
  return combined.length > 0 ? combined : null;
}

/**
 * Parse ReviewFindings JSON from the reviewer's response text.
 *
 * The reviewer is instructed to return exactly one JSON object.
 * However, the response might contain surrounding text. We try:
 * 1. Direct JSON parse of the full text
 * 2. Find and parse the first JSON block containing overallVerdict
 *
 * @param responseText - Raw response text from the reviewer
 * @returns Parsed findings object, or null if parsing fails
 */
export function parseReviewerFindings(responseText: string): Record<string, unknown> | null {
  // Try 1: Direct JSON parse
  try {
    const parsed = JSON.parse(responseText) as unknown;
    if (isValidFindings(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Not clean JSON — try extraction
  }

  // Try 2: Find JSON block with overallVerdict
  const jsonMatch = responseText.match(/\{[^{}]*"overallVerdict"\s*:\s*"[^"]+"/);
  if (jsonMatch) {
    const startIdx = responseText.indexOf(jsonMatch[0]);
    const candidate = extractJsonBlock(responseText, startIdx);
    if (candidate) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (isValidFindings(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // Parse failed
      }
    }
  }

  return null;
}

// ─── Output Mutation ─────────────────────────────────────────────────────────

/**
 * Build mutated tool output with reviewer findings injected.
 *
 * Replaces the `next` field from INDEPENDENT_REVIEW_REQUIRED to
 * INDEPENDENT_REVIEW_COMPLETED and adds the structured findings data.
 *
 * Fail-closed: requires `reviewerResult.findings` to be non-null.
 * If findings are null (unparseable reviewer response), returns null.
 * The caller must NOT signal COMPLETED without structured ReviewFindings.
 *
 * @param originalOutput - Original tool output JSON string
 * @param reviewerResult - Successful reviewer invocation result (must have .findings)
 * @returns Mutated JSON string, or null if mutation fails or findings are missing
 */
export function buildMutatedOutput(
  originalOutput: string,
  reviewerResult: ReviewerResult,
): string | null {
  // Fail-closed: COMPLETED requires structured findings
  if (!reviewerResult.findings) return null;

  try {
    const parsed = JSON.parse(originalOutput) as Record<string, unknown>;

    // Replace the next field
    parsed.next =
      `${REVIEW_COMPLETED_PREFIX}: The FlowGuard plugin has automatically invoked the ` +
      `${REVIEWER_SUBAGENT_TYPE} subagent. Review findings are included in ` +
      `_pluginReviewFindings. Submit your selfReviewVerdict based on the ` +
      `overallVerdict, and include the reviewFindings object from ` +
      `_pluginReviewFindings in your flowguard_plan or flowguard_implement call.`;

    // Inject structured findings
    parsed._pluginReviewFindings = reviewerResult.findings;
    parsed._pluginReviewSessionId = reviewerResult.sessionId;

    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

// ─── Orchestration Entry Point ───────────────────────────────────────────────

/**
 * Determine if a tool output signals INDEPENDENT_REVIEW_REQUIRED.
 *
 * @param toolOutput - Raw tool output string
 * @returns true if the output contains the review-required signal
 */
export function isReviewRequired(toolOutput: string): boolean {
  try {
    const parsed = JSON.parse(toolOutput) as Record<string, unknown>;
    const next = typeof parsed.next === 'string' ? parsed.next : '';
    return next.startsWith(REVIEW_REQUIRED_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Extract review context from a FlowGuard tool response.
 *
 * Parses the iteration and planVersion from the `next` field,
 * and extracts other context needed for prompt building.
 *
 * @param toolName - 'flowguard_plan' or 'flowguard_implement'
 * @param toolOutput - Parsed tool output object
 * @returns Review context or null if extraction fails
 */
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
  const next = typeof toolOutput.next === 'string' ? toolOutput.next : '';

  // Prefer structured obligation fields (P1a). Fall back to regex extraction
  // from the next text for backward compatibility with non-structured outputs.
  const iteration = typeof toolOutput.reviewObligationIteration === 'number'
    ? toolOutput.reviewObligationIteration
    : (() => {
        const match = next.match(/iteration[=:\s]+(\d+)/i);
        return match ? parseInt(match[1]!, 10) : null;
      })();

  const planVersion = typeof toolOutput.reviewObligationPlanVersion === 'number'
    ? toolOutput.reviewObligationPlanVersion
    : (() => {
        const match = next.match(/planVersion[=:\s]+(\d+)/i);
        return match ? parseInt(match[1]!, 10) : null;
      })();

  if (iteration === null || planVersion === null) return null;

  const obligationId =
    typeof toolOutput.reviewObligationId === 'string' ? toolOutput.reviewObligationId : null;
  const criteriaVersion =
    typeof toolOutput.reviewCriteriaVersion === 'string' ? toolOutput.reviewCriteriaVersion : null;
  const mandateDigest =
    typeof toolOutput.reviewMandateDigest === 'string' ? toolOutput.reviewMandateDigest : null;
  if (!obligationId || !criteriaVersion || !mandateDigest) {
    return null;
  }

  // Validate against the tool response fields for consistency
  if (toolName === TOOL_FLOWGUARD_PLAN) {
    const selfReviewIteration = toolOutput.selfReviewIteration;
    if (typeof selfReviewIteration === 'number' && selfReviewIteration !== iteration) {
      return null; // Inconsistent — fail-closed
    }
  }

  return { iteration, planVersion, obligationId, criteriaVersion, mandateDigest };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Check if a parsed object looks like valid ReviewFindings. */
function isValidFindings(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const record = obj as Record<string, unknown>;
  return (
    typeof record.overallVerdict === 'string' &&
    (record.overallVerdict === 'approve' || record.overallVerdict === 'changes_requested') &&
    Array.isArray(record.blockingIssues)
  );
}

/**
 * Extract a complete JSON block starting from a given index.
 * Counts braces to find the matching closing brace.
 */
function extractJsonBlock(text: string, startIdx: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(startIdx, i + 1);
      }
    }
  }

  return null;
}
