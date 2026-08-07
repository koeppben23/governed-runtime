/**
 * @module audit/proofgraph/runtime-availability-binder
 * @description Map PR-8 runtime readiness to ProofGraph unavailable evidence.
 *
 * When a structured verification candidate (from PR 6/7/8) has a known runtime
 * status of tool_missing, reporter_missing, or runtime_missing, any claim that
 * requires that provider cannot be proven. This module produces claim-scoped
 * ProofProviderResult(status='unavailable') entries that the evaluator maps to
 * NOT_VERIFIED — never CONTRADICTED, never PROVEN.
 *
 * Claim-scoped: only claims whose counterexampleRequirement names the affected
 * provider receive an unavailable result. A generic "vitest is missing" does not
 * make every claim unavailable — only claims requiring vitest.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { ProofProviderResult } from '../../state/proofgraph.js';
import type { ResolvedVerificationCandidate } from '../../integration/verification-runtime-resolution.js';
import {
  EXECUTED_TEST_PROVIDER_ID,
  EXECUTED_TEST_PROVIDER_VERSION,
} from './executed-test-binder.js';

export function bindRuntimeUnavailableEvidence(
  state: SessionState,
  evaluatedAt: string,
  runtimeCandidates?: readonly ResolvedVerificationCandidate[],
): ProofProviderResult[] {
  if (!runtimeCandidates || runtimeCandidates.length === 0) return [];

  const contract = state.proofContract;
  if (!contract) return [];

  const results: ProofProviderResult[] = [];
  const unavailableByProvider = collectUnavailableProviders(runtimeCandidates);

  for (const claim of contract.claims) {
    const req = claim.counterexampleRequirement;
    if (!req) continue;

    const providerId = req.assertion.providerId;
    const unavailableStatus = unavailableByProvider.get(providerId);
    if (!unavailableStatus) continue;

    results.push({
      claimId: claim.claimId,
      providerKind: 'executed_test',
      providerId: EXECUTED_TEST_PROVIDER_ID,
      providerVersion: EXECUTED_TEST_PROVIDER_VERSION,
      input: {},
      status: 'unavailable',
      executedAt: evaluatedAt,
      detail: `provider '${providerId}' is not available for runtime execution: ${unavailableStatus}`,
    });
  }

  return results;
}

function collectUnavailableProviders(
  runtimeCandidates: readonly ResolvedVerificationCandidate[],
): Map<string, string> {
  const map = new Map<string, string>();

  for (const rc of runtimeCandidates) {
    const c = rc.candidate;
    if (c.assertionCapability !== 'structured') continue;

    const providerId = c.assertionReport.providerId;
    const status = rc.runtime.status;

    if (
      status === 'tool_missing' ||
      status === 'reporter_missing' ||
      status === 'runtime_missing'
    ) {
      if (!map.has(providerId)) {
        map.set(providerId, status);
      }
    }
  }

  return map;
}
