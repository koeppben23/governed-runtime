/**
 * @module integration/review-agent-resolution
 * @description Lazy, fail-closed agent resolution for the isolated flowguard-reviewer subagent.
 *
 * The reviewer is governance-relevant authority evidence. An ordinary `general`
 * agent cannot substitute for the installed reviewer because prompt text cannot
 * enforce the reviewer's host-side read-only capability boundary.
 *
 * Cache semantics: Module-level singleton, valid for process lifetime.
 * OpenCode loads agents once at startup; registry changes require restart.
 *
 * @version v2
 */

import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import type { OrchestratorClient } from './types.js';

/** Primary reviewer agent installed with host-side read-only restrictions. */
export const REVIEWER_AGENT_PRIMARY = REVIEWER_SUBAGENT_TYPE;

export class ReviewerAgentUnavailableError extends Error {
  readonly code = 'REVIEWER_AGENT_UNAVAILABLE' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReviewerAgentUnavailableError';
  }
}

type CachedResolution =
  | { readonly kind: 'available' }
  | { readonly kind: 'unavailable'; readonly reason: string };

let cachedResolution: CachedResolution | null = null;

function unavailable(reason: string, cause?: unknown): never {
  cachedResolution = { kind: 'unavailable', reason };
  throw new ReviewerAgentUnavailableError(reason, cause === undefined ? undefined : { cause });
}

/**
 * Resolve the dedicated FlowGuard reviewer. Missing capability and registry
 * observation failures are both fail-closed: neither may degrade to `general`.
 */
export async function resolveReviewerAgent(client: OrchestratorClient): Promise<string> {
  if (cachedResolution?.kind === 'available') return REVIEWER_AGENT_PRIMARY;
  if (cachedResolution?.kind === 'unavailable') {
    throw new ReviewerAgentUnavailableError(cachedResolution.reason);
  }

  let result: Awaited<ReturnType<OrchestratorClient['app']['agents']>>;
  try {
    result = await client.app.agents();
  } catch (error) {
    return unavailable(
      `Unable to verify that the isolated ${REVIEWER_AGENT_PRIMARY} capability is registered; refusing SDK review fallback.`,
      error,
    );
  }

  if (result.error) {
    return unavailable(
      `Unable to verify that the isolated ${REVIEWER_AGENT_PRIMARY} capability is registered: ${String(
        (result.error as { message?: unknown }).message ?? result.error,
      )}`,
    );
  }

  if (!Array.isArray(result.data)) {
    return unavailable(
      `Reviewer agent registry returned no verifiable agent list; ${REVIEWER_AGENT_PRIMARY} isolation is NOT_VERIFIED.`,
    );
  }

  const found = result.data.some(
    (agent: Record<string, unknown>) =>
      agent.id === REVIEWER_AGENT_PRIMARY || agent.name === REVIEWER_AGENT_PRIMARY,
  );
  if (!found) {
    return unavailable(
      `Required isolated reviewer agent ${REVIEWER_AGENT_PRIMARY} is not registered. Restart/reinstall the host before review.`,
    );
  }

  cachedResolution = { kind: 'available' };
  return REVIEWER_AGENT_PRIMARY;
}

/** Reset the process-lifetime resolution cache. Test-only utility. */
export function _resetAgentResolutionCache(): void {
  cachedResolution = null;
}
