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
import type { RuntimeRequirement } from '../providers/registry.js';
import { RUNTIME_REQUIREMENTS_BY_PROVIDER, ASSERTION_PROFILES } from '../providers/registry.js';
import type { ProbeRunner, ProbeRole } from '../verification/toolchain-probe.js';
import type { PlannedVerificationCandidate } from '../discovery/verification-candidate-planned.js';

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

/**
 * Wraps VerificationCandidate[] into PlannedVerificationCandidate[] for compatibility.
 */
export function wrapForResolution(
  candidates: readonly VerificationCandidate[],
): PlannedVerificationCandidate[] {
  return candidates.map((c) => ({ candidate: c }));
}

export async function resolveRuntimeReadiness(
  candidates: readonly PlannedVerificationCandidate[],
  runner: ProbeRunner,
  cwd: string,
): Promise<readonly ResolvedVerificationCandidate[]> {
  const results: ResolvedVerificationCandidate[] = [];

  for (const planned of candidates) {
    const candidate = planned.candidate;
    if (candidate.assertionCapability !== 'structured') {
      results.push({ candidate, runtime: { status: 'unavailable', requirements: [] } });
      continue;
    }

    const requirements = getEffectiveRequirements(candidate, planned.executionProfileId);

    if (requirements.length === 0) {
      results.push({ candidate, runtime: { status: 'ready', requirements: [] } });
      continue;
    }

    const resolvedReqs = await probeRequirements(requirements, runner, cwd);
    const status = aggregateStatus(resolvedReqs);

    results.push({ candidate, runtime: { status, requirements: resolvedReqs } });
  }

  return results;
}

// ─── Internal ────────────────────────────────────────────────────────────────

function buildProbeSpec(
  req: RuntimeRequirement,
): import('../verification/toolchain-probe.js').ProbeSpec {
  if (req.probe.kind === 'executable_file') {
    return {
      kind: 'executable_file',
      id: req.id,
      role: req.role,
      path: req.probe.path,
    };
  }
  return {
    kind: 'exec',
    id: req.id,
    role: req.role,
    command: req.probe.command,
    versionPattern: req.probe.versionPattern,
  };
}

function getEffectiveRequirements(
  candidate: VerificationCandidate,
  executionProfileId?: string,
): readonly RuntimeRequirement[] {
  if (candidate.assertionCapability !== 'structured') return [];

  const profile = executionProfileId
    ? ASSERTION_PROFILES.find((p) => p.profileId === executionProfileId)
    : undefined;

  // Profile-specific requirements with possible platform resolution
  if (profile?.resolveRuntimeRequirements) {
    return profile.resolveRuntimeRequirements(candidate);
  }

  if (profile?.runtimeRequirements?.length) {
    return profile.runtimeRequirements;
  }

  const pid = candidate.assertionReport.providerId;
  return RUNTIME_REQUIREMENTS_BY_PROVIDER.get(pid) ?? [];
}

async function probeRequirements(
  requirements: readonly RuntimeRequirement[],
  runner: ProbeRunner,
  cwd: string,
): Promise<ResolvedRequirement[]> {
  const results: ResolvedRequirement[] = [];

  for (const req of requirements) {
    const probeSpec = buildProbeSpec(req);
    const probeResult = await runner.probe({ tool: probeSpec, cwd });

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
