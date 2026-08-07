/**
 * @module integration/tools/status-provider-projection
 * @description Provider capability and runtime readiness projection for status.
 *
 * Extracted from status-tool.ts to stay within the 750 LOC file-size budget.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import { resolveProviderCapabilities } from '../provider-capability-resolution.js';
import { resolveRuntimeReadiness } from '../verification-runtime-resolution.js';
import type { ProbeRunner } from '../../verification/toolchain-probe.js';
import type { ResolvedVerificationCandidate } from '../verification-runtime-resolution.js';

export function computeProviderCapabilities(
  state: SessionState,
  runtimeCandidates?: readonly ResolvedVerificationCandidate[],
) {
  return resolveProviderCapabilities(
    state.detectedStack ?? undefined,
    state.verificationCandidates,
    runtimeCandidates,
  );
}

export async function resolveRuntimeProviderCapabilities(
  state: SessionState,
  runner: ProbeRunner,
  cwd: string,
) {
  return resolveProviderCapabilities(
    state.detectedStack ?? undefined,
    state.verificationCandidates,
    await resolveRuntimeReadiness(state.verificationCandidates ?? [], runner, cwd),
  );
}
