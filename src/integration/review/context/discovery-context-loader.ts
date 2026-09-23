/**
 * @module integration/review/discovery-context-loader
 * @description Bounded, failure-safe loader for reviewer Discovery context.
 *
 * This module may read persisted Discovery artifacts, but it never mutates
 * session, discovery, audit, archive, or review state. Drift checking is
 * opt-in to avoid turning reviewer prompt construction into a second status
 * pipeline with hidden latency.
 */

import { readDiscovery } from '../../../adapters/persistence-discovery.js';
import { workspaceDir } from '../../../adapters/workspace/index.js';
import { buildImplementationGuidance } from '../../implementation-guidance.js';
import type { DiscoveryReviewContext, ReviewDiscoveryProvider } from './discovery-port.js';
import type { SessionState } from '../../../state/schema.js';

export interface BuildReviewDiscoveryContextInput {
  readonly sessionState: SessionState;
  readonly fingerprint: string | null;
  readonly worktree: string;
  readonly includeDriftCheck?: boolean;
  readonly driftTimeoutMs?: number;
  /** Injected Discovery context authority (review owns no discovery import). */
  readonly discoveryProvider: ReviewDiscoveryProvider;
}

export async function buildReviewDiscoveryContext(
  input: BuildReviewDiscoveryContextInput,
): Promise<DiscoveryReviewContext> {
  const baseContext = baseSessionContext(input.sessionState);
  if (!input.fingerprint) {
    return unavailableContext(
      baseContext,
      'Discovery context unavailable: workspace fingerprint could not be resolved.',
      input.discoveryProvider,
    );
  }

  try {
    const wsDir = workspaceDir(input.fingerprint);
    const discovery = await readDiscovery(wsDir);
    if (!discovery) {
      const health = input.discoveryProvider.unavailableHealth('missing');
      return {
        ...baseContext,
        health,
        drift: input.discoveryProvider.notChecked(
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

    const health = input.discoveryProvider.extractHealth(discovery);
    const drift = input.includeDriftCheck
      ? await input.discoveryProvider.build({
          workspaceDir: wsDir,
          worktree: input.worktree,
          fingerprint: input.fingerprint,
          ...(input.driftTimeoutMs !== undefined ? { timeoutMs: input.driftTimeoutMs } : {}),
        })
      : input.discoveryProvider.notChecked(
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
      input.discoveryProvider,
    );
  }
}

function baseSessionContext(state: SessionState): DiscoveryReviewContext {
  return {
    detectedStack: state.detectedStack ?? null,
    verificationCandidates: state.verificationCandidates ?? [],
  };
}

function unavailableContext(
  base: DiscoveryReviewContext,
  reason: string,
  discoveryProvider: ReviewDiscoveryProvider,
): DiscoveryReviewContext {
  const health = discoveryProvider.unavailableHealth('read_failed');
  return {
    ...base,
    health,
    drift: discoveryProvider.notChecked(reason),
    implementationGuidance: null,
    notVerified: [`NOT_VERIFIED: ${reason}`],
  };
}
