/**
 * @module integration/tools/status-provider-projection
 * @description Provider capability and runtime readiness projection for status.
 *
 * Extracted from status-tool.ts to stay within the 750 LOC file-size budget.
 *
 * @version v2
 */

import type { SessionState } from '../../state/schema.js';
import { resolveProviderCapabilities } from '../provider-capability-resolution.js';
import { resolveRuntimeReadiness } from '../verification-runtime-resolution.js';
import { planVerificationCandidates } from '../../discovery/verification-planner.js';
import { ProcessProbeRunner } from '../../verification/toolchain-probe.js';
import type { ProbeRunner } from '../../verification/toolchain-probe.js';
import type { ResolvedVerificationCandidate } from '../verification-runtime-resolution.js';
import { join } from 'node:path';

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
    await resolveRuntimeReadiness(
      state.verificationCandidates?.map((c) => ({
        candidate: c,
        executionSubjectInputs: state.executionSubjectInputsByKind?.[c.kind] ?? [],
      })) ?? [],
      runner,
      cwd,
    ),
  );
}

/** Replan via the planner to get profile IDs, then probe runtime readiness. */
export async function resolveRuntimeWithProfileIds(
  state: SessionState,
): Promise<readonly ResolvedVerificationCandidate[]> {
  let rootFiles: string[] = [];
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(state.binding.worktree);
    rootFiles = entries.filter(
      (e) =>
        e === 'mvnw' ||
        e === 'mvnw.cmd' ||
        e === 'gradlew' ||
        e === 'gradlew.bat' ||
        e === 'package.json',
    );
  } catch {
    /* ignore */
  }
  const planned = await planVerificationCandidates({
    detectedStack: state.detectedStack ?? undefined,
    allFiles: rootFiles,
    readFile: async (relativePath: string) => {
      try {
        const { readFile } = await import('node:fs/promises');
        return await readFile(join(state.binding.worktree, relativePath), 'utf-8');
      } catch {
        return undefined;
      }
    },
  });
  const probeRunner = new ProcessProbeRunner();
  return await resolveRuntimeReadiness(planned, probeRunner, state.binding.worktree);
}
