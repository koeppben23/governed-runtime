/**
 * @module integration/implementation-guidance
 * @description Runtime-only advisory implementation guidance for full status.
 *
 * This projection derives compact task-specific hints from canonical sources:
 * SessionState owns task/workflow evidence, DiscoveryResult owns repository facts.
 * It is never persisted and never overrides phase, policy, review, or plan gates.
 */

import type { DiscoveryHealthProjection } from '../discovery/discovery-health.js';
import { isDiscoveryHealthAvailable } from '../discovery/discovery-health.js';
import type { CodeSurfaceSignal, DiscoveryResult, SurfaceInfo } from '../discovery/types.js';
import type { SessionState } from '../state/schema.js';

export type ImplementationGuidanceConfidence = 'none' | 'low' | 'medium' | 'high';

export interface ImplementationGuidanceItem {
  readonly label: string;
  readonly path: string | null;
  readonly confidence: Exclude<ImplementationGuidanceConfidence, 'none'>;
  readonly evidence: string[];
  readonly source:
    | 'task_text_and_discovery'
    | 'persisted_discovery_result'
    | 'session_verification_candidates'
    | 'session_implementation_evidence'
    | 'session_risk_gate';
}

export interface ImplementationGuidanceWarning {
  readonly code: string;
  readonly message: string;
}

export interface ImplementationGuidanceProjection {
  readonly kind: 'derived_implementation_guidance';
  readonly advisory: true;
  readonly runtimeOnly: true;
  readonly source: {
    readonly task: 'session_ticket_plan' | 'missing';
    readonly discovery: 'persisted_discovery_result' | 'unavailable';
  };
  readonly confidence: ImplementationGuidanceConfidence;
  readonly notVerified: string[];
  readonly warnings: ImplementationGuidanceWarning[];
  readonly relevantFiles: ImplementationGuidanceItem[];
  readonly modules: ImplementationGuidanceItem[];
  readonly surfaces: ImplementationGuidanceItem[];
  readonly tests: ImplementationGuidanceItem[];
  readonly contracts: ImplementationGuidanceItem[];
  readonly riskHotspots: ImplementationGuidanceItem[];
  readonly limits: {
    readonly maxRelevantFiles: number;
    readonly maxModules: number;
    readonly maxSurfaces: number;
    readonly maxTests: number;
    readonly maxContracts: number;
    readonly maxRiskHotspots: number;
  };
}

interface BuildImplementationGuidanceInput {
  readonly state: SessionState;
  readonly discovery: DiscoveryResult | null;
  readonly discoveryHealth: DiscoveryHealthProjection | null;
}

type GuidanceSections = Pick<
  ImplementationGuidanceProjection,
  'relevantFiles' | 'modules' | 'surfaces' | 'tests' | 'contracts' | 'riskHotspots'
>;

interface ProjectionContext {
  readonly hasTaskText: boolean;
  readonly warnings: readonly ImplementationGuidanceWarning[];
  readonly notVerified: readonly string[];
  readonly confidence: ImplementationGuidanceConfidence;
  readonly sections: GuidanceSections;
}

const LIMITS = {
  maxRelevantFiles: 6,
  maxModules: 4,
  maxSurfaces: 6,
  maxTests: 5,
  maxContracts: 4,
  maxRiskHotspots: 5,
} as const;

const STOP_WORDS = new Set([
  'add',
  'and',
  'bug',
  'change',
  'fix',
  'for',
  'from',
  'implement',
  'into',
  'issue',
  'plan',
  'task',
  'test',
  'the',
  'this',
  'to',
  'update',
  'with',
]);

/** Build a pure, advisory implementation guidance projection for full status only. */
export function buildImplementationGuidance(
  input: BuildImplementationGuidanceInput,
): ImplementationGuidanceProjection {
  const taskText = [input.state.ticket?.text, input.state.plan?.current.body]
    .filter((part): part is string => Boolean(part))
    .join('\n');
  const taskTerms = extractTaskTerms(taskText);
  const hasTaskText = taskTerms.length > 0;
  const warnings = buildWarnings(input.state, input.discoveryHealth, input.discovery);
  const notVerified = buildNotVerified(input.discoveryHealth, input.discovery, hasTaskText);

  if (!input.discovery) {
    return buildUnavailableGuidance(input, hasTaskText, taskTerms, warnings, notVerified);
  }

  const sections = buildGuidanceSections(
    input.state,
    input.discovery,
    input.discoveryHealth,
    taskTerms,
  );
  const confidence = aggregateConfidence(Object.values(sections).flat(), input.discoveryHealth);

  return buildProjection({ hasTaskText, warnings, notVerified, confidence, sections });
}

function buildUnavailableGuidance(
  input: BuildImplementationGuidanceInput,
  hasTaskText: boolean,
  taskTerms: readonly string[],
  warnings: readonly ImplementationGuidanceWarning[],
  notVerified: readonly string[],
): ImplementationGuidanceProjection {
  return {
    kind: 'derived_implementation_guidance',
    advisory: true,
    runtimeOnly: true,
    source: { task: hasTaskText ? 'session_ticket_plan' : 'missing', discovery: 'unavailable' },
    confidence: 'none',
    notVerified: [...notVerified],
    warnings: [...warnings],
    relevantFiles: [],
    modules: [],
    surfaces: [],
    tests: buildTestItems(input.state, taskTerms, input.discoveryHealth),
    contracts: [],
    riskHotspots: buildStateRiskHotspots(input.state),
    limits: LIMITS,
  };
}

function buildGuidanceSections(
  state: SessionState,
  discovery: DiscoveryResult,
  discoveryHealth: DiscoveryHealthProjection | null,
  taskTerms: readonly string[],
): GuidanceSections {
  return {
    relevantFiles: buildRelevantFileItems(state, discovery, discoveryHealth, taskTerms),
    modules: buildModuleItems(discovery, discoveryHealth, taskTerms),
    surfaces: buildSurfaceGuidanceItems(discovery, discoveryHealth, taskTerms),
    tests: rankItems(
      buildTestItems(state, taskTerms, discoveryHealth),
      LIMITS.maxTests,
      discoveryHealth,
    ),
    contracts: buildContractItems(discovery, discoveryHealth, taskTerms),
    riskHotspots: buildRiskHotspotItems(state, discovery, discoveryHealth, taskTerms),
  };
}

function buildRelevantFileItems(
  state: SessionState,
  discovery: DiscoveryResult,
  discoveryHealth: DiscoveryHealthProjection | null,
  taskTerms: readonly string[],
): ImplementationGuidanceItem[] {
  const relevantFiles = rankItems(
    [
      ...implementationFileItems(state, taskTerms),
      ...codeSurfaceItems(discovery.codeSurfaces?.endpoints ?? [], taskTerms),
      ...codeSurfaceItems(discovery.codeSurfaces?.authBoundaries ?? [], taskTerms),
      ...codeSurfaceItems(discovery.codeSurfaces?.dataAccess ?? [], taskTerms),
      ...codeSurfaceItems(discovery.codeSurfaces?.integrations ?? [], taskTerms),
      ...surfaceEvidenceItems(discovery.surfaces.api, taskTerms),
      ...surfaceEvidenceItems(discovery.surfaces.persistence, taskTerms),
      ...surfaceEvidenceItems(discovery.surfaces.security, taskTerms),
    ],
    LIMITS.maxRelevantFiles,
    discoveryHealth,
  );
  return onlyCorroborated(relevantFiles);
}

function buildModuleItems(
  discovery: DiscoveryResult,
  discoveryHealth: DiscoveryHealthProjection | null,
  taskTerms: readonly string[],
): ImplementationGuidanceItem[] {
  const modules = rankItems(
    discovery.topology.modules.map((module) =>
      makeItem(
        module.name || module.path,
        module.path,
        [module.manifestFile],
        taskTerms,
        'persisted_discovery_result',
      ),
    ),
    LIMITS.maxModules,
    discoveryHealth,
  );
  return onlyCorroborated(modules);
}

function buildSurfaceGuidanceItems(
  discovery: DiscoveryResult,
  discoveryHealth: DiscoveryHealthProjection | null,
  taskTerms: readonly string[],
): ImplementationGuidanceItem[] {
  const surfaces = rankItems(
    [
      ...surfaceItems(discovery.surfaces.api, taskTerms),
      ...surfaceItems(discovery.surfaces.persistence, taskTerms),
      ...surfaceItems(discovery.surfaces.security, taskTerms),
      ...surfaceItems(discovery.surfaces.cicd, taskTerms),
      ...codeSurfaceItems(discovery.codeSurfaces?.endpoints ?? [], taskTerms),
    ],
    LIMITS.maxSurfaces,
    discoveryHealth,
  );
  return onlyCorroborated(surfaces);
}

function buildContractItems(
  discovery: DiscoveryResult,
  discoveryHealth: DiscoveryHealthProjection | null,
  taskTerms: readonly string[],
): ImplementationGuidanceItem[] {
  const contracts = rankItems(
    [
      ...discovery.topology.rootConfigs.map((config) =>
        makeItem(config, config, [config], taskTerms, 'persisted_discovery_result'),
      ),
      ...surfaceItems(discovery.surfaces.api, taskTerms),
    ],
    LIMITS.maxContracts,
    discoveryHealth,
  );
  return onlyCorroborated(contracts);
}

function buildRiskHotspotItems(
  state: SessionState,
  discovery: DiscoveryResult,
  discoveryHealth: DiscoveryHealthProjection | null,
  taskTerms: readonly string[],
): ImplementationGuidanceItem[] {
  const riskHotspots = rankItems(
    [
      ...buildStateRiskHotspots(state),
      ...surfaceItems(discovery.surfaces.security, taskTerms),
      ...surfaceItems(discovery.surfaces.cicd, taskTerms),
      ...codeSurfaceItems(discovery.codeSurfaces?.authBoundaries ?? [], taskTerms),
      ...codeSurfaceItems(discovery.codeSurfaces?.dataAccess ?? [], taskTerms),
    ],
    LIMITS.maxRiskHotspots,
    discoveryHealth,
  );
  return riskHotspots;
}

function buildProjection(context: ProjectionContext): ImplementationGuidanceProjection {
  const { hasTaskText, warnings, notVerified, confidence, sections } = context;
  const nextNotVerified = [...notVerified];
  if (hasTaskText && hasNoImplementationDirection(sections)) {
    nextNotVerified.push(
      'NOT_VERIFIED: No matching task, plan, changed-file, or risk-gate evidence supports implementation direction.',
    );
  }
  return {
    kind: 'derived_implementation_guidance',
    advisory: true,
    runtimeOnly: true,
    source: {
      task: hasTaskText ? 'session_ticket_plan' : 'missing',
      discovery: 'persisted_discovery_result',
    },
    confidence,
    notVerified: nextNotVerified,
    warnings: [...warnings],
    ...sections,
    limits: LIMITS,
  };
}

function extractTaskTerms(text: string): string[] {
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9._/-]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
  return Array.from(new Set(terms)).slice(0, 24);
}

function buildWarnings(
  state: SessionState,
  health: DiscoveryHealthProjection | null,
  discovery: DiscoveryResult | null,
): ImplementationGuidanceWarning[] {
  const warnings: ImplementationGuidanceWarning[] = [];
  if (state.riskGate?.status === 'blocked') {
    warnings.push({
      code: 'risk_gate_blocked',
      message: state.riskGate.message,
    });
  }
  if (!discovery) {
    warnings.push({
      code: 'discovery_unavailable',
      message:
        'Implementation guidance has no repository discovery artifact; repo-specific hints are unavailable.',
    });
    return warnings;
  }
  if (!health) {
    warnings.push({
      code: 'discovery_health_unavailable',
      message: 'Discovery health could not be projected; guidance confidence is capped.',
    });
    return warnings;
  }
  if (!isDiscoveryHealthAvailable(health)) {
    warnings.push({
      code: 'discovery_health_unavailable',
      message: `Discovery health is unavailable (${health.reason}); guidance confidence is capped. ${health.recovery}`,
    });
    return warnings;
  }
  if (!health.healthy) {
    warnings.push({
      code: 'discovery_degraded',
      message: 'Discovery is degraded; guidance is advisory and confidence is capped.',
    });
  }
  if (health.hasBudgetExhaustion) {
    warnings.push({
      code: 'discovery_budget_exhausted',
      message: 'Code-surface analysis was truncated by budget limits.',
    });
  }
  if (health.ageWarning) {
    warnings.push({ code: 'discovery_stale', message: health.ageWarning });
  }
  if (hasHighRiskSurface(discovery)) {
    warnings.push({
      code: 'high_risk_surface_present',
      message:
        'Security, CI/CD, authentication, or data-access surfaces were detected; preserve applicable risk, review, and validation gates.',
    });
  }
  return warnings;
}

function buildNotVerified(
  health: DiscoveryHealthProjection | null,
  discovery: DiscoveryResult | null,
  hasTaskText: boolean,
): string[] {
  const notVerified: string[] = [
    'NOT_VERIFIED: Guidance is advisory and never overrides plan, policy, phase, review, or validation gates.',
    'NOT_VERIFIED: Suggested files and commands have not been executed or modified by this projection.',
  ];
  if (!hasTaskText) {
    notVerified.push(
      'NOT_VERIFIED: No ticket or plan text was available for task-specific corroboration.',
    );
  }
  if (!discovery) {
    notVerified.push('NOT_VERIFIED: Repository discovery facts are unavailable.');
  } else if (!health) {
    notVerified.push(
      'NOT_VERIFIED: Repository discovery is missing health evidence or degraded; results may be incomplete.',
    );
  } else if (!isDiscoveryHealthAvailable(health)) {
    notVerified.push(...health.notVerified);
  } else if (!health.healthy) {
    notVerified.push('NOT_VERIFIED: Repository discovery is degraded; results may be incomplete.');
  }
  return notVerified;
}

function codeSurfaceItems(
  signals: readonly CodeSurfaceSignal[],
  taskTerms: readonly string[],
): ImplementationGuidanceItem[] {
  return signals.map((signal) =>
    makeItem(
      signal.label,
      signal.location,
      [signal.location, ...signal.evidence],
      taskTerms,
      'persisted_discovery_result',
    ),
  );
}

function surfaceItems(
  surfaces: readonly SurfaceInfo[],
  taskTerms: readonly string[],
): ImplementationGuidanceItem[] {
  return surfaces.map((surface) =>
    makeItem(
      surface.label,
      firstEvidencePath(surface.evidence),
      surface.evidence,
      taskTerms,
      'persisted_discovery_result',
    ),
  );
}

function surfaceEvidenceItems(
  surfaces: readonly SurfaceInfo[],
  taskTerms: readonly string[],
): ImplementationGuidanceItem[] {
  return surfaces.flatMap((surface) =>
    surface.evidence.map((evidence) =>
      makeItem(surface.label, evidence, [evidence], taskTerms, 'persisted_discovery_result'),
    ),
  );
}

function buildTestItems(
  state: SessionState,
  taskTerms: readonly string[],
  health: DiscoveryHealthProjection | null,
): ImplementationGuidanceItem[] {
  const candidates = state.verificationCandidates ?? [];
  return candidates
    .filter((candidate) => candidate.kind === 'test' || candidate.kind === 'coverage')
    .map((candidate) => {
      const baseConfidence = candidate.confidence;
      const confidence = capConfidence(baseConfidence, health);
      return {
        label: candidate.command,
        path: null,
        confidence,
        evidence: [candidate.source, candidate.reason],
        source: 'session_verification_candidates',
      } satisfies ImplementationGuidanceItem;
    })
    .sort(compareItems(taskTerms));
}

function implementationFileItems(
  state: SessionState,
  taskTerms: readonly string[],
): ImplementationGuidanceItem[] {
  return (state.implementation?.changedFiles ?? []).map((file) => ({
    ...makeItem(file, file, [file], taskTerms, 'session_implementation_evidence'),
    source: 'session_implementation_evidence',
  }));
}

function buildStateRiskHotspots(state: SessionState): ImplementationGuidanceItem[] {
  if (state.riskGate?.status !== 'blocked') return [];
  return [
    {
      label: state.riskGate.code,
      path: null,
      confidence: 'high',
      evidence: [state.riskGate.message, state.riskGate.lastDecisionId],
      source: 'session_risk_gate',
    },
  ];
}

function makeItem(
  label: string,
  path: string | null,
  evidence: readonly string[],
  taskTerms: readonly string[],
  source: ImplementationGuidanceItem['source'],
): ImplementationGuidanceItem {
  const matchCount = countMatches([label, path ?? '', ...evidence], taskTerms);
  const confidence = matchCount >= 2 ? 'high' : matchCount === 1 ? 'medium' : 'low';
  return {
    label,
    path,
    confidence,
    evidence: Array.from(new Set(evidence)).slice(0, 4),
    source:
      matchCount > 0 && source === 'persisted_discovery_result'
        ? 'task_text_and_discovery'
        : source,
  };
}

function rankItems(
  items: readonly ImplementationGuidanceItem[],
  limit: number,
  health: DiscoveryHealthProjection | null,
): ImplementationGuidanceItem[] {
  const byIdentity = new Map<string, ImplementationGuidanceItem>();
  for (const item of items) {
    const capped = { ...item, confidence: capConfidence(item.confidence, health) };
    const key = `${capped.label}\u0000${capped.path ?? ''}`;
    const existing = byIdentity.get(key);
    if (!existing || confidenceRank(capped.confidence) > confidenceRank(existing.confidence)) {
      byIdentity.set(key, capped);
    }
  }
  return Array.from(byIdentity.values())
    .sort(
      (a, b) =>
        confidenceRank(b.confidence) - confidenceRank(a.confidence) ||
        a.label.localeCompare(b.label),
    )
    .slice(0, limit);
}

function onlyCorroborated(
  items: readonly ImplementationGuidanceItem[],
): ImplementationGuidanceItem[] {
  return items.filter(
    (item) =>
      item.source === 'task_text_and_discovery' ||
      item.source === 'session_implementation_evidence',
  );
}

function hasNoImplementationDirection(sections: GuidanceSections): boolean {
  return (
    sections.relevantFiles.length === 0 &&
    sections.modules.length === 0 &&
    sections.surfaces.length === 0 &&
    sections.contracts.length === 0
  );
}

function aggregateConfidence(
  items: readonly ImplementationGuidanceItem[],
  health: DiscoveryHealthProjection | null,
): ImplementationGuidanceConfidence {
  if (items.length === 0) return 'none';
  const highest = items.reduce<Exclude<ImplementationGuidanceConfidence, 'none'>>(
    (current, item) =>
      confidenceRank(item.confidence) > confidenceRank(current) ? item.confidence : current,
    'low',
  );
  return capConfidence(highest, health);
}

function capConfidence(
  confidence: Exclude<ImplementationGuidanceConfidence, 'none'>,
  health: DiscoveryHealthProjection | null,
): Exclude<ImplementationGuidanceConfidence, 'none'> {
  if (!health || !health.healthy) return confidenceRank(confidence) > 2 ? 'medium' : confidence;
  return confidence;
}

function confidenceRank(confidence: ImplementationGuidanceConfidence): number {
  switch (confidence) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    case 'none':
      return 0;
  }
}

function countMatches(values: readonly string[], taskTerms: readonly string[]): number {
  let matches = 0;
  for (const term of taskTerms) {
    const normalizedTerm = term.toLowerCase();
    if (values.some((value) => value.toLowerCase().includes(normalizedTerm))) {
      matches++;
    }
  }
  return matches;
}

function compareItems(taskTerms: readonly string[]) {
  return (a: ImplementationGuidanceItem, b: ImplementationGuidanceItem): number => {
    const byConfidence = confidenceRank(b.confidence) - confidenceRank(a.confidence);
    if (byConfidence !== 0) return byConfidence;
    const byMatch =
      countMatches([b.label, b.path ?? '', ...b.evidence], taskTerms) -
      countMatches([a.label, a.path ?? '', ...a.evidence], taskTerms);
    if (byMatch !== 0) return byMatch;
    return a.label.localeCompare(b.label);
  };
}

function firstEvidencePath(evidence: readonly string[]): string | null {
  return evidence.find((item) => item.includes('/') || item.includes('.')) ?? evidence[0] ?? null;
}

function hasHighRiskSurface(discovery: DiscoveryResult): boolean {
  return (
    discovery.surfaces.security.length > 0 ||
    discovery.surfaces.cicd.length > 0 ||
    (discovery.codeSurfaces?.authBoundaries.length ?? 0) > 0 ||
    (discovery.codeSurfaces?.dataAccess.length ?? 0) > 0
  );
}
