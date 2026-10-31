/**
 * @module integration/review-agent-resolution
 * @description Lazy, fail-closed agent resolution for the isolated flowguard-reviewer subagent.
 *
 * The reviewer is governance-relevant authority evidence. An ordinary `general`
 * agent cannot substitute for the installed reviewer because prompt text cannot
 * enforce the reviewer's host-side read-only capability boundary.
 *
 * Resolve from the current host registry on every dispatch. Host reloads must
 * not inherit another location's process-global capability cache.
 *
 * @version v2
 */

import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import type { OrchestratorClient } from '../types.js';

/** Primary reviewer agent installed with host-side read-only restrictions. */
export const REVIEWER_AGENT_PRIMARY = REVIEWER_SUBAGENT_TYPE;

export class ReviewerAgentUnavailableError extends Error {
  readonly code = 'REVIEWER_AGENT_UNAVAILABLE' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReviewerAgentUnavailableError';
  }
}

function unavailable(reason: string, cause?: unknown): never {
  throw new ReviewerAgentUnavailableError(reason, cause === undefined ? undefined : { cause });
}

/**
 * Resolve the dedicated FlowGuard reviewer. Missing capability and registry
 * observation failures are both fail-closed: neither may degrade to `general`.
 */
export async function resolveReviewerAgent(
  client: OrchestratorClient,
  sessionId: string,
): Promise<string> {
  let result: Awaited<ReturnType<OrchestratorClient['listAgents']>>;
  try {
    result = await client.listAgents(sessionId);
  } catch (error) {
    return unavailable(
      `Unable to verify that the isolated ${REVIEWER_AGENT_PRIMARY} capability is registered; refusing SDK review fallback.`,
      error,
    );
  }

  if (!Array.isArray(result)) {
    return unavailable(
      `Reviewer agent registry returned no verifiable agent list; ${REVIEWER_AGENT_PRIMARY} isolation is NOT_VERIFIED.`,
    );
  }

  const found = result.some((agent) => agent.id === REVIEWER_AGENT_PRIMARY);
  if (!found) {
    return unavailable(
      `Required isolated reviewer agent ${REVIEWER_AGENT_PRIMARY} is not registered. Reload/reinstall the host before review.`,
    );
  }

  return REVIEWER_AGENT_PRIMARY;
}
