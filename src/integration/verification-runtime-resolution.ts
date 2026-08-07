/**
 * @module integration/verification-runtime-resolution
 * @description Runtime readiness resolution for verification candidates.
 *
 * Combines planned VerificationCandidates with toolchain probe results to
 * produce a separate runtime readiness projection. Never mutates or removes
 * candidates — only annotates them with runtime availability status.
 *
 * @version v1
 */

import type { VerificationCandidate } from '../state/discovery-schemas.js';
import type { RuntimeRequirement } from '../discovery/assertion-provider-catalog.js';
import { DESCRIPTOR_BY_PROVIDER } from '../discovery/assertion-provider-catalog.js';
import type { ProbeRunner, ProbeRole } from '../verification/toolchain-probe.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type RuntimeStatus =
  'ready' | 'tool_missing' | 'reporter_missing' | 'runtime_missing' | 'unavailable' | 'unknown';

export interface ResolvedRequirement {
  readonly id: string;
  readonly role: ProbeRole;
  readonly status: 'available' | 'missing' | 'unknown';
  readonly version?: string;
}

export interface ResolvedVerificationCandidate {
  readonly candidate: VerificationCandidate;
  readonly runtime: {
    readonly status: RuntimeStatus;
    readonly requirements: readonly ResolvedRequirement[];
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function resolveRuntimeReadiness(
  candidates: readonly VerificationCandidate[],
  runner: ProbeRunner,
  cwd: string,
): Promise<readonly ResolvedVerificationCandidate[]> {
  const results: ResolvedVerificationCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.assertionCapability !== 'structured') {
      results.push({
        candidate,
        runtime: { status: 'unavailable', requirements: [] },
      });
      continue;
    }

    const providerId = candidate.assertionReport.providerId;
    const descriptor = DESCRIPTOR_BY_PROVIDER.get(providerId);

    if (!descriptor?.runtimeRequirements || descriptor.runtimeRequirements.length === 0) {
      results.push({
        candidate,
        runtime: { status: 'ready', requirements: [] },
      });
      continue;
    }

    const resolvedReqs = await probeRequirements(descriptor.runtimeRequirements, runner, cwd);
    const status = aggregateStatus(resolvedReqs);

    results.push({
      candidate,
      runtime: { status, requirements: resolvedReqs },
    });
  }

  return results;
}

// ─── Internal ────────────────────────────────────────────────────────────────

async function probeRequirements(
  requirements: readonly RuntimeRequirement[],
  runner: ProbeRunner,
  cwd: string,
): Promise<ResolvedRequirement[]> {
  const results: ResolvedRequirement[] = [];

  for (const req of requirements) {
    const probeResult = await runner.probe({
      tool: {
        id: req.id,
        role: req.role,
        command: req.probe.command,
        versionPattern: req.probe.versionPattern,
      },
      cwd,
    });

    let status: 'available' | 'missing' | 'unknown';
    if (probeResult.status === 'available') {
      status = 'available';
    } else if (probeResult.status === 'missing') {
      status = 'missing';
    } else {
      status = 'unknown';
    }

    results.push({
      id: req.id,
      role: req.role,
      status,
      version: probeResult.status === 'available' ? probeResult.version : undefined,
    });
  }

  return results;
}

function aggregateStatus(requirements: readonly ResolvedRequirement[]): RuntimeStatus {
  if (requirements.length === 0) return 'ready';

  let hasMissingRuntime = false;
  let hasMissingTool = false;
  let hasMissingReporter = false;
  let hasUnknown = false;
  let allAvailable = true;

  for (const req of requirements) {
    if (req.status === 'missing') {
      allAvailable = false;
      if (req.role === 'runtime') hasMissingRuntime = true;
      else if (req.role === 'reporter') hasMissingReporter = true;
      else hasMissingTool = true;
    } else if (req.status === 'unknown') {
      allAvailable = false;
      hasUnknown = true;
    }
  }

  if (allAvailable) return 'ready';
  if (hasMissingReporter) return 'reporter_missing';
  if (hasMissingRuntime) return 'runtime_missing';
  if (hasMissingTool) return 'tool_missing';
  if (hasUnknown) return 'unknown';
  return 'unknown';
}
