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
 * 1. Builds a structured prompt with plan/architecture/implementation text and context
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
import { TOOL_FLOWGUARD_PLAN, TOOL_FLOWGUARD_REVIEW } from './tool-names.js';
import { parseToolResult } from './plugin-helpers.js';

export const REVIEW_FINDINGS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    iteration: { type: 'integer', minimum: 0 },
    planVersion: { type: 'integer', minimum: 1 },
    reviewMode: { type: 'string', const: 'subagent' },
    overallVerdict: { type: 'string', enum: ['approve', 'changes_requested', 'unable_to_review'] },
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
          enum: ['verified', 'best_effort', 'claim_validated', 'idp_verified'],
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
        toolObligationId: {
          type: 'string',
          // RFC 4122 UUID pattern. Must stay in sync with z.string().uuid() in
          // src/state/evidence.ts ReviewAttestation.toolObligationId.
          // Drift guard: src/integration/review-findings-schema-drift.test.ts.
          pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
        },
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
  app: {
    agents(): Promise<{ data?: Array<Record<string, unknown>> | undefined; error?: unknown }>;
  };
  session: {
    create(opts: {
      body?: { parentID?: string; title?: string };
    }): Promise<{ data?: { id: string } | undefined; error?: unknown }>;
    prompt(opts: {
      path: { id: string };
      body: {
        agent?: string;
        system?: string;
        parts: Array<{ type: string; text: string }>;
        format?: {
          type: 'json_schema';
          schema: Record<string, unknown>;
          retryCount?: number;
        };
      };
    }): Promise<{
      data?:
        | {
            parts?: Array<{ type?: string; text?: string }>;
            info?: {
              // SDK docs field name (canonical): info.structured_output
              structured_output?: unknown;
              // Possible server alias — kept for forward-compat
              structured?: unknown;
              error?: {
                name: string;
                // v1 shape
                message?: string;
                // v2 shape: StructuredOutputError wraps in data.message
                data?: { message?: string; retries?: number };
              };
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
  /** Active stack profile name (e.g. "backend-java", "angular-frontend"). P9c. */
  readonly profileName?: string;
  /** Phase-specific stack review rules for PLAN_REVIEW. P9c. */
  readonly profileRules?: string;
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
  /** Active stack profile name (e.g. "backend-java"). P9c. */
  readonly profileName?: string;
  /** Phase-specific stack review rules for IMPL_REVIEW. P9c. */
  readonly profileRules?: string;
}

/** Options for building an architecture (ADR) review prompt. F13 slice 6. */
export interface ArchitectureReviewPromptOpts {
  /** The ADR text to review (full MADR markdown body). */
  readonly adrText: string;
  /** Short title of the architecture decision. */
  readonly adrTitle: string;
  /** The ticket text for context. */
  readonly ticketText: string;
  /** The current self-review iteration (0-based). */
  readonly iteration: number;
  /**
   * The plan version number. For architecture obligations there is no plan
   * artifact; we use planVersion=1 for the initial submission and increment
   * for revisions, mirroring the plan/architecture/implement convention.
   */
  readonly planVersion: number;
  /** Strict review obligation identifier. */
  readonly obligationId: string;
  /** Strict criteria version string. */
  readonly criteriaVersion: string;
  /** Strict mandate digest. */
  readonly mandateDigest: string;
  /** Active stack profile name (e.g. "backend-java"). P9c. */
  readonly profileName?: string;
  /** Phase-specific stack review rules for ARCH_REVIEW. P9c. */
  readonly profileRules?: string;
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

// ─── Agent Resolution ────────────────────────────────────────────────────────

/**
 * Primary agent: 'flowguard-reviewer' — a custom subagent registered by the
 * FlowGuard installer in .opencode/agents/flowguard-reviewer.md.
 *
 * The installer writes this file and sets agent.build.permission.task
 * to allow only flowguard-reviewer. After OpenCode restart, the agent is
 * available via the registered agent name.
 */
export const REVIEWER_AGENT_PRIMARY = REVIEWER_SUBAGENT_TYPE; // 'flowguard-reviewer'

/**
 * Fallback agent: 'general' — used when the custom agent is not available
 * (e.g., before restart after install, or in environments without the agent file).
 * In fallback mode, REVIEWER_SYSTEM_DIRECTIVE is injected as system prompt.
 */
export const REVIEWER_AGENT_FALLBACK = 'general';

/**
 * System directive injected ONLY in fallback mode (agent: 'general').
 *
 * When 'flowguard-reviewer' is registered, its markdown prompt serves as the
 * system prompt — this directive is NOT sent to avoid conflict.
 * When falling back to 'general', this directive provides the reviewer persona.
 */
export const REVIEWER_SYSTEM_DIRECTIVE =
  'You are a governance reviewer subagent for FlowGuard. ' +
  'Your ONLY job is to review the provided content and return a SINGLE valid JSON object ' +
  'conforming to the ReviewFindings schema. ' +
  'Do NOT include markdown fences, commentary, explanations, or any text outside the JSON object. ' +
  'The JSON must contain: iteration, planVersion, reviewMode ("subagent"), overallVerdict, ' +
  'blockingIssues, majorRisks, missingVerification, scopeCreep, unknowns, reviewedBy, ' +
  'reviewedAt (ISO 8601), and attestation.';

/**
 * Cached result of the agent resolution probe. null = not yet probed.
 * Module-level cache: valid for the process lifetime (OpenCode loads agents
 * once at startup — registry changes require restart = new process = new cache).
 */
let cachedResolvedAgent: string | null = null;

/**
 * Lazily probe whether 'flowguard-reviewer' is registered in OpenCode's agent
 * registry. Result is cached for process lifetime.
 *
 * - If found: returns REVIEWER_AGENT_PRIMARY ('flowguard-reviewer')
 * - If not found or probe fails: returns REVIEWER_AGENT_FALLBACK ('general')
 *
 * Uses try/catch for maximum resilience — unknown API shape, network errors,
 * or SDK breaking changes must never block the review flow.
 */
export async function resolveReviewerAgent(client: OrchestratorClient): Promise<string> {
  if (cachedResolvedAgent !== null) return cachedResolvedAgent;

  try {
    const result = await client.app.agents();
    const agents = result.data ?? [];
    const found = agents.some(
      (a: Record<string, unknown>) =>
        a.id === REVIEWER_AGENT_PRIMARY || a.name === REVIEWER_AGENT_PRIMARY,
    );
    cachedResolvedAgent = found ? REVIEWER_AGENT_PRIMARY : REVIEWER_AGENT_FALLBACK;
  } catch {
    // Probe failure (network, unknown API shape, etc.) — degrade gracefully
    cachedResolvedAgent = REVIEWER_AGENT_FALLBACK;
  }

  return cachedResolvedAgent;
}

/**
 * Reset the agent resolution cache. Test-only utility.
 * @internal
 */
export function _resetAgentResolutionCache(): void {
  cachedResolvedAgent = null;
}

// ─── Text Extraction Utility ─────────────────────────────────────────────────

/**
 * Extract JSON from unstructured text response.
 *
 * Belt-and-suspenders fallback when info.structured_output is absent or the
 * provider does not support the format field.
 * Tries three strategies in order:
 * 1. Direct JSON.parse (response is pure JSON)
 * 2. Strip markdown code fences and parse
 * 3. Extract outermost brace-delimited block and parse
 *
 * Returns null if no valid JSON object can be extracted.
 */
export function extractJsonFromText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Strategy 1: direct parse
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // not pure JSON — try next strategy
  }

  // Strategy 2: strip markdown fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1]!.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // fence content not valid JSON
    }
  }

  // Strategy 3: outermost brace extraction
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace >= 0) {
    let depth = 0;
    let lastBrace = -1;
    for (let i = firstBrace; i < trimmed.length; i++) {
      if (trimmed[i] === '{') depth++;
      else if (trimmed[i] === '}') {
        depth--;
        if (depth === 0) {
          lastBrace = i;
          break;
        }
      }
    }
    if (lastBrace > firstBrace) {
      try {
        const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        // brace content not valid JSON
      }
    }
  }

  return null;
}

// ─── Prompt Builders ─────────────────────────────────────────────────────────

/**
 * Build a Stack Profile section for reviewer prompts.
 * Returns empty string if no profile data is available (null-safe).
 *
 * P9c: injects phase-specific stack guidance so the reviewer receives
 * stack review rules relevant to the current workflow phase.
 */
function buildStackProfileSection(
  profileName: string | undefined,
  profileRules: string | undefined,
): string {
  if (!profileName && !profileRules) return '';
  const lines: string[] = [];
  if (profileName) {
    lines.push('## Active Stack Profile', '', profileName, '');
  }
  if (profileRules) {
    lines.push('## Stack Review Rules', '', profileRules, '');
  }
  return lines.join('\n');
}

/**
 * Select phase-specific reviewer profile rules from the session state.
 *
 * P9c: mapping between workflow phases and phaseRuleContent slots ensures
 * each reviewer prompt gets the correct stack guidance for PLAN_REVIEW,
 * IMPL_REVIEW, ARCH_REVIEW, and REVIEW phases.
 */
export function selectReviewerProfileRules(
  activeProfile: { name: string; phaseRuleContent?: Record<string, string> } | null | undefined,
  phase: 'PLAN_REVIEW' | 'IMPL_REVIEW' | 'ARCH_REVIEW' | 'REVIEW',
): { profileName?: string; profileRules?: string } {
  if (!activeProfile) return {};
  return {
    profileName: activeProfile.name,
    profileRules: activeProfile.phaseRuleContent?.[phase],
  };
}

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
    profileName,
    profileRules,
  } = opts;
  const stackSection = buildStackProfileSection(profileName, profileRules);
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
    ...(stackSection ? [stackSection, ''] : []),
    '## Instructions',
    '',
    'Review this plan against the ticket requirements. Follow your review criteria',
    'for plans. Return your findings as a single JSON object matching the',
    'ReviewFindings schema. Use the exact iteration and planVersion values above.',
    `Set iteration=${iteration} and planVersion=${planVersion} in your response.`,
    `Set attestation.toolObligationId=${obligationId}.`,
    `Set attestation.criteriaVersion=${criteriaVersion}.`,
    `Set attestation.mandateDigest=${mandateDigest}.`,
    `Set attestation.iteration=${iteration}.`,
    `Set attestation.planVersion=${planVersion}.`,
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
    profileName,
    profileRules,
  } = opts;
  const stackSection = buildStackProfileSection(profileName, profileRules);
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
    ...(stackSection ? [stackSection, ''] : []),
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
    `Set attestation.iteration=${iteration}.`,
    `Set attestation.planVersion=${planVersion}.`,
    'Set attestation.reviewedBy="flowguard-reviewer".',
  ].join('\n');
}

/**
 * Build a prompt for architecture (ADR) review by the flowguard-reviewer subagent.
 *
 * F13 slice 6: parity with plan/impl review prompts. The prompt structure
 * mirrors buildPlanReviewPrompt (no changedFiles section, since an ADR is
 * a self-contained document) but instructs the subagent to apply the
 * "For Architecture Decisions (ADRs)" review-criteria section added to
 * REVIEWER_AGENT in F13 slice 4.
 *
 * The ticket text is included for scope-creep verification (Out-of-scope
 * clarity is a documented ADR review dimension).
 *
 * @param opts - Architecture review context
 * @returns Prompt text string
 */
export function buildArchitectureReviewPrompt(opts: ArchitectureReviewPromptOpts): string {
  const {
    adrText,
    adrTitle,
    ticketText,
    iteration,
    planVersion,
    obligationId,
    criteriaVersion,
    mandateDigest,
    profileName,
    profileRules,
  } = opts;
  const stackSection = buildStackProfileSection(profileName, profileRules);
  return [
    `You are reviewing an architecture decision (ADR) for iteration=${iteration}, planVersion=${planVersion}.`,
    '',
    '## Ticket',
    '',
    ticketText,
    '',
    `## ADR to Review: ${adrTitle}`,
    '',
    adrText,
    '',
    ...(stackSection ? [stackSection, ''] : []),
    '## Instructions',
    '',
    'Review this ADR against the ticket and your review criteria for Architecture',
    'Decisions (ADRs). Focus on problem framing, alternatives considered, decision',
    'rationale, consequences, reversibility, compatibility, out-of-scope clarity,',
    'and verification path. Use the read/glob/grep tools to verify any claims about',
    'existing files, schemas, or contracts referenced in the ADR.',
    'Return your findings as a single JSON object matching the ReviewFindings schema.',
    `Set iteration=${iteration} and planVersion=${planVersion} in your response.`,
    `Set attestation.toolObligationId=${obligationId}.`,
    `Set attestation.criteriaVersion=${criteriaVersion}.`,
    `Set attestation.mandateDigest=${mandateDigest}.`,
    `Set attestation.iteration=${iteration}.`,
    `Set attestation.planVersion=${planVersion}.`,
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
/** Options for controlling retry behavior of reviewer invocation. */
export interface InvokeReviewerOptions {
  /** Maximum number of retry attempts after the first failure (default: 2). */
  readonly maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000). */
  readonly baseDelayMs?: number;
  /**
   * Sleep function for backoff delays. Injected for testability.
   * @internal — consumers should not set this; used only in tests.
   */
  readonly _sleepFn?: (ms: number) => Promise<void>;
  /**
   * Diagnostic callback invoked on each attempt failure.
   * Provides the step that failed and error details for logging/debugging.
   * @internal — consumers wire this to their logger.
   */
  readonly _onAttemptFailed?: (info: {
    attempt: number;
    step:
      | 'agent_probe'
      | 'session_create'
      | 'session_prompt'
      | 'structured_output_error'
      | 'no_findings';
    error?: unknown;
    details?: Record<string, unknown>;
  }) => void;
}

/**
 * Sleep utility for retry backoff. Exported for testability.
 * @internal
 */
export function retrySleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default retry configuration. */
const DEFAULT_INVOKE_OPTIONS: Required<InvokeReviewerOptions> = {
  maxRetries: 2,
  baseDelayMs: 1000,
  _sleepFn: retrySleep,
  _onAttemptFailed: () => {},
};

export async function invokeReviewer(
  client: OrchestratorClient,
  prompt: string,
  parentSessionId: string,
  options?: InvokeReviewerOptions,
): Promise<ReviewerResult | null> {
  const {
    maxRetries,
    baseDelayMs,
    _sleepFn: sleep,
    _onAttemptFailed: onFailed,
  } = {
    ...DEFAULT_INVOKE_OPTIONS,
    ...options,
  };
  const maxAttempts = maxRetries + 1;

  // Lazy agent resolution (cached for process lifetime after first probe)
  const agent = await resolveReviewerAgent(client);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Exponential backoff before retry (not before first attempt)
    if (attempt > 1) {
      await sleep(baseDelayMs * Math.pow(2, attempt - 2));
    }

    // 1. Create a child session linked to the parent
    const createResult = await client.session.create({
      body: {
        parentID: parentSessionId,
        title: REVIEWER_SESSION_TITLE,
      },
    });

    if (createResult.error || !createResult.data?.id) {
      onFailed({
        attempt,
        step: 'session_create',
        error: createResult.error,
        details: { hasData: !!createResult.data },
      });
      if (attempt < maxAttempts) continue; // retry transient session creation failure
      return null;
    }

    const childSessionId = createResult.data.id;

    // 2. Build prompt body — dual-path:
    //    Primary: 'flowguard-reviewer' registered agent (has its own system prompt)
    //    Fallback: 'general' with injected system directive
    //
    // SDK TYPE LAG: @opencode-ai/sdk@1.14.41 (latest) does not include `format`
    // in SessionPromptData.body types, but the field IS documented in the official
    // OpenCode SDK docs: https://opencode.ai/docs/sdk/#structured-output
    // The server accepts and processes it correctly at runtime.
    // Track: SDK type definitions need update to include format field.
    const body = {
      agent,
      parts: [{ type: 'text' as const, text: prompt }],
      format: { type: 'json_schema' as const, schema: REVIEW_FINDINGS_JSON_SCHEMA, retryCount: 1 },
    };

    // Inject system directive only in fallback mode — the registered agent's
    // markdown prompt already provides the reviewer persona.
    if (agent === REVIEWER_AGENT_FALLBACK) {
      (body as { system?: string }).system = REVIEWER_SYSTEM_DIRECTIVE;
    }

    // NOTE: body.format passes TypeScript compilation because the body variable's
    // excess properties are not checked when passed as a pre-declared variable
    // (excess property checking only applies to inline object literals).
    // The format field IS in the documented API (https://opencode.ai/docs/sdk/#structured-output)
    // but NOT in SDK types (@opencode-ai/sdk@1.14.41). This is a known SDK type lag.
    // When the SDK adds format to SessionPromptData.body, this comment can be removed.
    const promptResult = await client.session.prompt({
      path: { id: childSessionId },
      body,
    });

    if (promptResult.error || !promptResult.data) {
      onFailed({
        attempt,
        step: 'session_prompt',
        error: promptResult.error,
        details: { hasData: !!promptResult.data, agent, hasFormat: true },
      });
      if (attempt < maxAttempts) continue; // retry transient prompt failure
      return null;
    }

    const info = promptResult.data.info;

    // StructuredOutputError is deterministic — the LLM cannot fulfill the schema.
    // Retrying will produce the same failure. Fail immediately.
    if (info?.error && info.error.name === 'StructuredOutputError') {
      onFailed({
        attempt,
        step: 'structured_output_error',
        error: info.error,
        details: { agent, retries: info.error.data?.retries },
      });
      return null;
    }

    // ── Response parsing: primary path (structured output) ──
    // SDK docs field name (canonical): info.structured_output
    // Server may also return info.structured — kept as fallback
    // Defensive: check both field names to ensure forward and backward compat.
    let findings: Record<string, unknown> | null = null;

    const structuredRaw = info?.structured_output ?? info?.structured;
    if (structuredRaw && typeof structuredRaw === 'object' && !Array.isArray(structuredRaw)) {
      findings = structuredRaw as Record<string, unknown>;
    }

    // ── Response parsing: TextPart fallback REMOVED (fail-closed) ──
    // Previously: extracted JSON from text parts when structured_output was absent.
    // This violated FlowGuard's fail-closed invariant — accepting heuristically-parsed
    // content that was NOT SDK-validated. The retry loop below handles the absence
    // of structured output by retrying up to maxAttempts, then returning null.
    // See: https://opencode.ai/docs/sdk/#error-handling

    if (!findings) {
      onFailed({
        attempt,
        step: 'no_findings',
        details: {
          agent,
          hasInfo: !!info,
          hasStructuredOutput: info ? 'structured_output' in info : false,
          hasStructured: info ? 'structured' in info : false,
          infoKeys: info ? Object.keys(info) : [],
          partsCount: promptResult.data.parts?.length ?? 0,
          textPartsLength:
            promptResult.data.parts
              ?.filter((p) => p.type === 'text' && p.text)
              .reduce((sum, p) => sum + (p.text?.length ?? 0), 0) ?? 0,
        },
      });
      if (attempt < maxAttempts) continue; // retry missing structured output
      return null;
    }

    // Authoritative session ID injection: the subagent cannot reliably know its
    // own session ID, so the runtime overwrites findings.reviewedBy.sessionId
    // with the verified childSessionId. This prevents SUBAGENT_SESSION_MISMATCH
    // failures caused by the subagent guessing or using a placeholder literal.
    const reviewedBy = findings.reviewedBy as Record<string, unknown> | undefined;
    if (reviewedBy && typeof reviewedBy === 'object') {
      reviewedBy.sessionId = childSessionId;
    } else {
      findings.reviewedBy = { sessionId: childSessionId };
    }

    return {
      sessionId: childSessionId,
      rawResponse: JSON.stringify(findings),
      findings,
    };
  }

  // Unreachable under normal control flow, but TypeScript needs a return.
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
  if (!reviewerResult.findings) return null;

  const parsed = parseToolResult(originalOutput);
  if (!parsed || Array.isArray(parsed)) return null;

  parsed.next =
    `${REVIEW_COMPLETED_PREFIX}: The FlowGuard plugin has automatically invoked the ` +
    `${REVIEWER_SUBAGENT_TYPE} subagent. Review findings are included in ` +
    `pluginReviewFindings. Submit your selfReviewVerdict based on the ` +
    `overallVerdict, and include the reviewFindings object from ` +
    `pluginReviewFindings in your flowguard_plan, flowguard_architecture, or flowguard_implement call.`;

  // Inject structured findings
  parsed.pluginReviewFindings = reviewerResult.findings;
  parsed._pluginReviewSessionId = reviewerResult.sessionId;

  return JSON.stringify(parsed);
}

/**
 * Build mutated output for content-aware standalone /review.
 *
 * Unlike buildMutatedOutput (which injects a self-review verdict instruction
 * for /plan, /architecture, /implement), this injects pluginReviewFindings
 * and instructs the agent to re-call flowguard_review with the same content
 * input and analysisFindings set to the injected findings.
 */
export function buildReviewContentMutatedOutput(
  originalOutput: string,
  reviewerResult: ReviewerResult,
): string | null {
  if (!reviewerResult.findings) return null;

  const parsed = parseToolResult(originalOutput);
  if (!parsed || Array.isArray(parsed)) return null;

  parsed.next =
    `PLUGIN_REVIEW_COMPLETED: The FlowGuard plugin has automatically invoked the ` +
    `${REVIEWER_SUBAGENT_TYPE} subagent. Review findings are included in ` +
    `pluginReviewFindings. Call flowguard_review again with the same content ` +
    `input (prNumber/branch/url/text) and set analysisFindings to the ` +
    `complete pluginReviewFindings object. Do NOT modify or map the findings. ` +
    `Include attestation.toolObligationId from requiredReviewAttestation.`;

  parsed.pluginReviewFindings = reviewerResult.findings;
  parsed._pluginReviewSessionId = reviewerResult.sessionId;

  return JSON.stringify(parsed);
}

// ─── Orchestration Entry Point ───────────────────────────────────────────────

/**
 * Determine if a tool output signals INDEPENDENT_REVIEW_REQUIRED.
 *
 * @param toolOutput - Raw tool output string
 * @returns true if the output contains the review-required signal
 */
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

/**
 * Extract review context from a FlowGuard tool response.
 *
 * Parses the iteration and planVersion from the `next` field,
 * and extracts other context needed for prompt building.
 *
 * @param toolName - 'flowguard_plan', 'flowguard_architecture', or 'flowguard_implement'
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
  // Standalone /review: extract review context from requiredReviewAttestation
  // embedded in the blocked CONTENT_ANALYSIS_REQUIRED response.
  // iteration and planVersion are the obligation defaults (1/1).
  if (toolName === TOOL_FLOWGUARD_REVIEW) {
    const att = toolOutput.requiredReviewAttestation as Record<string, unknown> | undefined;
    if (!att) return null;
    const obligationId = typeof att.toolObligationId === 'string' ? att.toolObligationId : '';
    const mandateDigest = typeof att.mandateDigest === 'string' ? att.mandateDigest : '';
    const criteriaVersion = typeof att.criteriaVersion === 'string' ? att.criteriaVersion : '';
    if (!obligationId || !mandateDigest || !criteriaVersion) return null;
    return {
      iteration: 1,
      planVersion: 1,
      obligationId,
      criteriaVersion,
      mandateDigest,
    };
  }

  // Generic plan/implement/architecture extraction.
  // then to regex extraction from next text for backward compatibility.
  const obl = toolOutput.reviewObligation as
    | {
        obligationId?: unknown;
        obligationType?: unknown;
        iteration?: unknown;
        planVersion?: unknown;
        criteriaVersion?: unknown;
        mandateDigest?: unknown;
      }
    | undefined;

  const obligationId =
    (obl?.obligationId as string | undefined) ??
    (typeof toolOutput.reviewObligationId === 'string' ? toolOutput.reviewObligationId : null);
  const criteriaVersion =
    (obl?.criteriaVersion as string | undefined) ??
    (typeof toolOutput.reviewCriteriaVersion === 'string'
      ? toolOutput.reviewCriteriaVersion
      : null);
  const mandateDigest =
    (obl?.mandateDigest as string | undefined) ??
    (typeof toolOutput.reviewMandateDigest === 'string' ? toolOutput.reviewMandateDigest : null);

  let iteration: number | null =
    (obl?.iteration as number | undefined) ??
    (typeof toolOutput.reviewObligationIteration === 'number'
      ? toolOutput.reviewObligationIteration
      : null);
  let planVersion: number | null =
    (obl?.planVersion as number | undefined) ??
    (typeof toolOutput.reviewObligationPlanVersion === 'number'
      ? toolOutput.reviewObligationPlanVersion
      : null);

  const next = typeof toolOutput.next === 'string' ? toolOutput.next : '';

  // Regex fallback for iteration/planVersion (deprecated, non-structured outputs only)
  if (iteration === null) {
    const match = next.match(/iteration[=:\s]+(\d+)/i);
    if (!match) return null;
    iteration = parseInt(match[1]!, 10);
  }
  if (planVersion === null) {
    const match = next.match(/planVersion[=:\s]+(\d+)/i);
    if (!match) return null;
    planVersion = parseInt(match[1]!, 10);
  }

  if (!obligationId || !criteriaVersion || !mandateDigest) return null;

  // Validate against the tool response fields for consistency
  if (toolName === TOOL_FLOWGUARD_PLAN) {
    const selfReviewIteration = toolOutput.selfReviewIteration;
    if (typeof selfReviewIteration === 'number' && selfReviewIteration !== iteration) {
      return null; // Inconsistent — fail-closed
    }
  }

  return { iteration, planVersion, obligationId, criteriaVersion, mandateDigest };
}

/**
 * Build a review prompt for content-aware standalone /review.
 * Used by the plugin-orchestrator when it detects a CONTENT_ANALYSIS_REQUIRED
 * blocked response with requiredReviewAttestation.
 *
 * Unlike buildPlanReviewPrompt / buildImplReviewPrompt / buildArchitectureReviewPrompt
 * which wrap artifact-specific context, this prompt presents arbitrary external
 * content (PR diff, branch diff, URL content, or manual text) for subagent analysis.
 */

export function buildReviewContentPrompt(opts: {
  content: string;
  ticketText: string;
  obligationId: string;
  mandateDigest: string;
  criteriaVersion: string;
  iteration: number;
  planVersion: number;
  /** Active stack profile name. P9c. */
  profileName?: string;
  /** Phase-specific stack review rules for REVIEW. P9c. */
  profileRules?: string;
}): string {
  const stackSection = buildStackProfileSection(opts.profileName, opts.profileRules);
  const lines: string[] = [
    'You are ' + REVIEWER_SUBAGENT_TYPE + ' - a governance reviewer subagent.',
    'Review the following content for issues, risks, and missing verification.',
    'Obligation: ' + opts.obligationId,
    'Iteration: ' + String(opts.iteration) + ', PlanVersion: ' + String(opts.planVersion),
    '',
    'ATTESTATION (include these exact values in your ReviewFindings output):',
    '  reviewedBy: "' + REVIEWER_SUBAGENT_TYPE + '"',
    '  mandateDigest: "' + opts.mandateDigest + '"',
    '  criteriaVersion: "' + opts.criteriaVersion + '"',
    '  toolObligationId: "' + opts.obligationId + '"',
    '',
  ];
  if (opts.ticketText) {
    lines.push('Ticket context: ' + opts.ticketText, '');
  }
  if (stackSection) {
    lines.push(stackSection, '');
  }
  lines.push(
    'CONTENT TO REVIEW:',
    '```',
    opts.content,
    '```',
    '',
    'Return a complete ReviewFindings JSON object (no markdown fences, no extra text).',
    'Fields: reviewMode: "subagent", iteration, planVersion, overallVerdict,',
    '  blockingIssues, majorRisks, missingVerification, scopeCreep, unknowns,',
    '  reviewedBy: { sessionId }, reviewedAt, attestation.',
    'Use ONLY these categories: completeness, correctness, feasibility, risk, quality.',
  );
  return lines.join('\n');
}
