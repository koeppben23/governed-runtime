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
 * Graceful degradation: If any step fails, returns null. The plugin
 * preserves the original tool output, falling back to the probabilistic
 * flow where the LLM calls the Task tool manually. Enforcement (L1-L4)
 * still gates the verdict submission.
 *
 * Conformance: Uses documented OpenCode SDK client API
 * per https://opencode.ai/docs/plugins
 *
 * @version v1
 */

import { REVIEW_REQUIRED_PREFIX, REVIEWER_SUBAGENT_TYPE } from './review-enforcement.js';

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
      };
    }): Promise<{
      data?: { parts?: Array<{ type?: string; text?: string }> } | undefined;
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
  const { planText, ticketText, iteration, planVersion } = opts;
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
  ].join('\n');
}

/**
 * Build a prompt for implementation review by the flowguard-reviewer subagent.
 *
 * @param opts - Implementation review context
 * @returns Prompt text string
 */
export function buildImplReviewPrompt(opts: ImplReviewPromptOpts): string {
  const { changedFiles, planText, ticketText, iteration, planVersion } = opts;
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
    },
  });

  if (promptResult.error || !promptResult.data) {
    return null;
  }

  // 3. Extract text content from response parts
  const rawResponse = extractResponseText(promptResult.data.parts);
  if (!rawResponse) {
    return null;
  }

  // 4. Attempt to parse the ReviewFindings JSON
  const findings = parseReviewerFindings(rawResponse);

  return {
    sessionId: childSessionId,
    rawResponse,
    findings,
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
 * INDEPENDENT_REVIEW_COMPLETED and adds the findings data.
 *
 * @param originalOutput - Original tool output JSON string
 * @param reviewerResult - Successful reviewer invocation result
 * @returns Mutated JSON string, or null if mutation fails
 */
export function buildMutatedOutput(
  originalOutput: string,
  reviewerResult: ReviewerResult,
): string | null {
  try {
    const parsed = JSON.parse(originalOutput) as Record<string, unknown>;

    // Replace the next field
    parsed.next =
      `${REVIEW_COMPLETED_PREFIX}: The FlowGuard plugin has automatically invoked the ` +
      `${REVIEWER_SUBAGENT_TYPE} subagent. Review findings are included in ` +
      `_pluginReviewFindings. Submit your selfReviewVerdict based on the ` +
      `overallVerdict, and include the reviewFindings object from ` +
      `_pluginReviewFindings in your flowguard_plan or flowguard_implement call.`;

    // Inject findings
    parsed._pluginReviewFindings = reviewerResult.findings ?? reviewerResult.rawResponse;
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
): { iteration: number; planVersion: number } | null {
  const next = typeof toolOutput.next === 'string' ? toolOutput.next : '';

  // Extract iteration from the next field
  const iterMatch = next.match(/iteration[=:\s]+(\d+)/i);
  if (!iterMatch) return null;
  const iteration = parseInt(iterMatch[1]!, 10);

  // Extract planVersion from the next field
  const versionMatch = next.match(/planVersion[=:\s]+(\d+)/i);
  if (!versionMatch) return null;
  const planVersion = parseInt(versionMatch[1]!, 10);

  // Validate against the tool response fields for consistency
  if (toolName === 'flowguard_plan') {
    const selfReviewIteration = toolOutput.selfReviewIteration;
    if (typeof selfReviewIteration === 'number' && selfReviewIteration !== iteration) {
      return null; // Inconsistent — fail-closed
    }
  }

  return { iteration, planVersion };
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
