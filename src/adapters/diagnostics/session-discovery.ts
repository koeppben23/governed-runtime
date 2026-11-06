/**
 * @module adapters/diagnostics/session-discovery
 * @description Read-only discovery of known reviewer/continuation sessions.
 *
 * Discovery is deliberately separate from session resolution: a discovered
 * candidate is not authorization to read its state. Only a positive invocation
 * link to the requested root marks lineage as verified; every other candidate
 * remains in the graph as `not_verified`.
 */

import type { SessionState } from '../../state/schema.js';
import type { DiscoverySource, SessionDiscovery } from './types.js';

function mergeLineage(
  existing: 'verified' | 'not_verified' | undefined,
  next: 'verified' | 'not_verified' | null,
): 'verified' | 'not_verified' {
  if (existing === 'not_verified' || next === 'not_verified') return 'not_verified';
  return existing ?? next ?? 'not_verified';
}

/**
 * Project every session candidate named by canonical review evidence.
 *
 * The map is stable and denominator-preserving: candidates are never removed
 * because they are unreachable or ambiguous.
 */
export function discoverReviewSessions(
  state: SessionState | null,
  rootSessionId: string,
): Map<string, SessionDiscovery> {
  const found = new Map<string, SessionDiscovery>();
  if (!state?.reviewAssurance) return found;
  const add = (
    sessionId: string | undefined,
    source: DiscoverySource,
    parentSessionId: string | null,
    lineage: 'verified' | 'not_verified' | null,
  ) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const existing = found.get(sessionId);
    const sources = existing?.sources ?? [];
    if (!sources.includes(source)) sources.push(source);
    found.set(sessionId, {
      sources,
      parentSessionId: existing?.parentSessionId ?? parentSessionId,
      lineage: mergeLineage(existing?.lineage, lineage),
    });
  };
  for (const invocation of state.reviewAssurance.invocations) {
    add(
      invocation.childSessionId,
      'review_invocation',
      invocation.parentSessionId,
      invocation.parentSessionId === rootSessionId ? 'verified' : 'not_verified',
    );
  }
  for (const attempt of state.reviewAssurance.attempts) {
    add(attempt.childSessionId, 'review_attempt', null, null);
    for (const observation of attempt.observations) {
      add(observation.observedBySessionId, 'review_observation', null, null);
    }
  }
  return found;
}
