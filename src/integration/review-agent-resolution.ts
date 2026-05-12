/**
 * @module integration/review-agent-resolution
 * @description Lazy agent resolution for the flowguard-reviewer subagent.
 *
 * Extracted from review-orchestrator.ts (FG-REL-038) for single-responsibility.
 * Probes the OpenCode agent registry to determine whether 'flowguard-reviewer'
 * is registered. Falls back to 'general' with a system directive.
 *
 * Cache semantics: Module-level singleton, valid for process lifetime.
 * OpenCode loads agents once at startup; registry changes require restart.
 *
 * @version v1
 */

import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import type { OrchestratorClient } from './review-orchestrator.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Primary agent: 'flowguard-reviewer' — a custom subagent registered by the
 * FlowGuard installer in .opencode/agents/flowguard-reviewer.md.
 */
export const REVIEWER_AGENT_PRIMARY = REVIEWER_SUBAGENT_TYPE;

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

// ─── Agent Resolution Cache ─────────────────────────────────────────────────

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

/** @internal No-op retained for tests; model capability is no longer cached globally. */
export function _resetModelCapabilityCache(): void {
  // Capability depends on provider/model/agent and is intentionally not cached globally.
}

/** @internal Always unknown; model capability is evaluated per invocation. */
export function _getModelCapabilityCache(): 'unknown' | 'supported' | 'unsupported' {
  return 'unknown';
}
