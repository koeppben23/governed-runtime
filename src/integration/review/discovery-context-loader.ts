/**
 * @module integration/review/discovery-context-loader
 * @description Bounded, failure-safe loader for reviewer Discovery context.
 *
 * This module may read persisted Discovery artifacts, but it never mutates
 * session, discovery, audit, archive, or review state. Drift checking is
 * opt-in to avoid turning reviewer prompt construction into a second status
 * pipeline with hidden latency.
 */

import { readDiscovery } from '../../adapters/persistence-discovery.js';
import { workspaceDir } from '../../adapters/workspace/index.js';
import {
  extractDiscoveryHealth,
  unavailableDiscoveryHealth,
} from '../../discovery/discovery-health.js';
import {
  buildDiscoveryDriftStatus,
  notCheckedDiscoveryDriftStatus,
} from '../discovery-drift-status.js';
import { buildImplementationGuidance } from '../implementation-guidance.js';
import type { SessionState } from '../../state/schema.js';
import type { DiscoveryReviewContext } from './discovery-context-prompt.js';

export interface BuildReviewDiscoveryContextInput {
  readonly sessionState: SessionState;
  readonly fingerprint: string | null;
  readonly worktree: string;
  readonly includeDriftCheck?: boolean;
  readonly driftTimeoutMs?: number;
}

export async function buildReviewDiscoveryContext(
  input: BuildReviewDiscoveryContextInput,
): Promise<DiscoveryReviewContext> {
  const baseContext = baseSessionContext(input.sessionState);
  if (!input.fingerprint) {
    return unavailableContext(
      baseContext,
      'Discovery context unavailable: workspace fingerprint could not be resolved.',
    );
  }

  try {
    const wsDir = workspaceDir(input.fingerprint);
    const discovery = await readDiscovery(wsDir);
    if (!discovery) {
      const health = unavailableDiscoveryHealth('missing');
      return {
        ...baseContext,
        health,
        drift: notCheckedDiscoveryDriftStatus(
          'Discovery drift was not checked during review prompt construction because persisted discovery is missing.',
        ),
        implementationGuidance: buildImplementationGuidance({
          state: input.sessionState,
          discovery: null,
          discoveryHealth: health,
        }),
        notVerified: [
          'NOT_VERIFIED: Persisted discovery artifact is missing; reviewer Discovery context is incomplete.',
        ],
      };
    }

    const health = extractDiscoveryHealth(discovery);
    const drift = input.includeDriftCheck
      ? await buildDiscoveryDriftStatus({
          workspaceDir: wsDir,
          worktree: input.worktree,
          fingerprint: input.fingerprint,
          timeoutMs: input.driftTimeoutMs,
        })
      : notCheckedDiscoveryDriftStatus(
          'Discovery drift was not checked during review prompt construction to avoid hidden review-orchestration latency.',
        );
    const implementationGuidance = buildImplementationGuidance({
      state: input.sessionState,
      discovery,
      discoveryHealth: health,
    });

    return { ...baseContext, health, drift, implementationGuidance };
  } catch (error) {
    return unavailableContext(
      baseContext,
      `Discovery context unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function baseSessionContext(state: SessionState): DiscoveryReviewContext {
  return {
    detectedStack: state.detectedStack ?? null,
    verificationCandidates: state.verificationCandidates ?? [],
  };
}

function unavailableContext(base: DiscoveryReviewContext, reason: string): DiscoveryReviewContext {
  const health = unavailableDiscoveryHealth('read_failed');
  return {
    ...base,
    health,
    drift: notCheckedDiscoveryDriftStatus(reason),
    implementationGuidance: null,
    notVerified: [`NOT_VERIFIED: ${reason}`],
  };
}
