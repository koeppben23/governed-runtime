/**
 * @module discovery/orchestrator
 * @description Discovery orchestrator — runs all collectors and assembles DiscoveryResult.
 *
 * Design:
 * - Each collector runs independently (Promise.allSettled via collector-runner)
 * - Collector failure degrades that collector only (status: "failed")
 * - Partial results are allowed — the orchestrator never fails entirely
 * - Per-collector timeout budget (configurable, default 10s)
 * - Produces a complete DiscoveryResult with per-collector diagnostics
 *
 * Also provides:
 * - extractDiscoverySummary(): extracts DiscoverySummary from DiscoveryResult
 * - computeDiscoveryDigest() (re-exported): SHA-256 of canonical JSON for snapshot/session integrity
 *
 * @version v2
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { withSpan, addFingerprint } from '../telemetry/index.js';
import type {
  CodeSurfacesInfo,
  CollectorDiagnostic,
  CollectorInput,
  DetectedItem,
  DiscoveryResult,
  DomainSignals,
  RepoMetadata,
  StackInfo,
  SurfacesInfo,
  TopologyInfo,
} from './types.js';
import { DISCOVERY_SCHEMA_VERSION } from './types.js';
import type {
  DetectedStack,
  DetectedStackItem,
  DetectedStackTarget,
  DetectedStackTargetEntry,
  DiscoverySummary,
} from '../state/discovery-schemas.js';
import { collectRepoMetadata } from './collectors/repo-metadata.js';
import type { DiscoveryIoPort } from './io-port.js';
import { collectStack } from './collectors/stack-detection.js';
import { collectTopology } from './collectors/topology.js';
import { collectSurfaces } from './collectors/surface-detection.js';
import { collectCodeSurfaces } from './collectors/code-surface-analysis.js';
import { collectDomainSignals } from './collectors/domain-signals.js';
import { extractScopedStack } from './scoped-stack.js';
import { runCollectorWithDiagnostics, type CollectorRunResult } from './collector-runner.js';

export { computeDiscoveryDigest } from './discovery-digest.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default per-collector timeout (ms). */
const COLLECTOR_TIMEOUT_MS = 10_000;

// ─── File Reading ─────────────────────────────────────────────────────────────

/**
 * Create a default readFile function for a given worktree root.
 * Returns file content as UTF-8 string or undefined on any error.
 */
function createDefaultReadFile(
  worktreePath: string,
): (relativePath: string) => Promise<string | undefined> {
  const resolvedRoot = nodePath.resolve(worktreePath);
  return async (relativePath: string): Promise<string | undefined> => {
    try {
      const targetPath = nodePath.resolve(resolvedRoot, relativePath);
      if (!targetPath.startsWith(resolvedRoot + nodePath.sep) && targetPath !== resolvedRoot) {
        return undefined;
      }
      return await fsReadFile(targetPath, 'utf8');
    } catch {
      return undefined;
    }
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run all discovery collectors and assemble a DiscoveryResult.
 *
 * Each collector runs independently with a timeout budget.
 * If a collector fails or times out, its status is recorded as "failed"
 * and empty defaults are used for its section.
 *
 * @param input - Shared collector input (worktree, fingerprint, file lists).
 * @param timeoutMs - Per-collector timeout (default: 10_000ms).
 * @returns Complete DiscoveryResult with per-collector status.
 */
export async function runDiscovery(
  input: CollectorInput,
  io: DiscoveryIoPort,
  timeoutMs: number = COLLECTOR_TIMEOUT_MS,
): Promise<DiscoveryResult> {
  return withSpan(
    'discovery.run',
    async () => {
      addFingerprint(input.fingerprint);
      return runDiscoveryImpl(input, io, timeoutMs);
    },
    { 'flowguard.fingerprint': input.fingerprint },
  );
}

function runRepoMetadataCollector(
  input: CollectorInput,
  io: DiscoveryIoPort,
  timeoutMs: number,
): Promise<CollectorRunResult<RepoMetadata>> {
  return runCollectorWithDiagnostics('repo-metadata', collectRepoMetadata(input, io), timeoutMs, {
    defaultBranch: null,
    headCommit: null,
    isDirty: true,
    worktreePath: input.worktreePath,
    canonicalRemote: null,
    fingerprint: input.fingerprint,
  });
}

function runStackCollector(
  input: CollectorInput,
  timeoutMs: number,
): Promise<CollectorRunResult<StackInfo>> {
  return runCollectorWithDiagnostics('stack-detection', collectStack(input), timeoutMs, {
    languages: [],
    frameworks: [],
    buildTools: [],
    testFrameworks: [],
    runtimes: [],
    tools: [],
    qualityTools: [],
    databases: [],
  });
}

function runTopologyCollector(
  input: CollectorInput,
  timeoutMs: number,
): Promise<CollectorRunResult<TopologyInfo>> {
  return runCollectorWithDiagnostics('topology', collectTopology(input), timeoutMs, {
    kind: 'unknown' as const,
    modules: [],
    entryPoints: [],
    rootConfigs: [],
    ignorePaths: [],
  });
}

function runSurfaceCollector(
  input: CollectorInput,
  timeoutMs: number,
): Promise<CollectorRunResult<SurfacesInfo>> {
  return runCollectorWithDiagnostics('surface-detection', collectSurfaces(input), timeoutMs, {
    api: [],
    persistence: [],
    cicd: [],
    security: [],
    layers: [],
  });
}

function runCodeSurfaceCollector(
  input: CollectorInput,
  timeoutMs: number,
): Promise<CollectorRunResult<CodeSurfacesInfo>> {
  return runCollectorWithDiagnostics(
    'code-surface-analysis',
    collectCodeSurfaces(input),
    timeoutMs,
    {
      status: 'failed' as const,
      endpoints: [],
      authBoundaries: [],
      dataAccess: [],
      integrations: [],
      budget: {
        scannedFiles: 0,
        scannedBytes: 0,
        maxFiles: 200,
        maxBytesPerFile: 64 * 1024,
        maxTotalBytes: 2 * 1024 * 1024,
        timedOut: false,
      },
    },
  );
}

function runDomainSignalsCollector(
  input: CollectorInput,
  timeoutMs: number,
): Promise<CollectorRunResult<DomainSignals>> {
  return runCollectorWithDiagnostics('domain-signals', collectDomainSignals(input), timeoutMs, {
    keywords: [],
    glossarySources: [],
  });
}

type DiscoveryDiagnostic = DiscoveryResult['diagnostics'][number];

function namedDiagnostic(
  name: DiscoveryDiagnostic['name'],
  diagnostic: CollectorDiagnostic,
): DiscoveryDiagnostic {
  return { ...diagnostic, name };
}

async function runDiscoveryImpl(
  input: CollectorInput,
  io: DiscoveryIoPort,
  timeoutMs: number = COLLECTOR_TIMEOUT_MS,
): Promise<DiscoveryResult> {
  // Enrich input with default readFile if not provided by caller
  const enrichedInput: CollectorInput = input.readFile
    ? input
    : { ...input, readFile: createDefaultReadFile(input.worktreePath) };

  // Run all collectors in parallel with timeout budget and diagnostics
  const [metaRun, stackRun, topoRun, surfaceRun, codeSurfaceRun, domainRun] = await Promise.all([
    runRepoMetadataCollector(enrichedInput, io, timeoutMs),
    runStackCollector(enrichedInput, timeoutMs),
    runTopologyCollector(enrichedInput, timeoutMs),
    runSurfaceCollector(enrichedInput, timeoutMs),
    runCodeSurfaceCollector(enrichedInput, timeoutMs),
    runDomainSignalsCollector(enrichedInput, timeoutMs),
  ]);

  // Collect diagnostics
  const diagnostics: DiscoveryResult['diagnostics'] = [
    namedDiagnostic('repo-metadata', metaRun.diagnostic),
    namedDiagnostic('stack-detection', stackRun.diagnostic),
    namedDiagnostic('topology', topoRun.diagnostic),
    namedDiagnostic('surface-detection', surfaceRun.diagnostic),
    namedDiagnostic('code-surface-analysis', codeSurfaceRun.diagnostic),
    namedDiagnostic('domain-signals', domainRun.diagnostic),
  ];

  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    collectedAt: new Date().toISOString(),
    diagnostics,
    repoMetadata: metaRun.data,
    stack: stackRun.data,
    topology: topoRun.data,
    surfaces: surfaceRun.data,
    codeSurfaces: codeSurfaceRun.data,
    domainSignals: domainRun.data,
  };
}

// ─── Summary & Digest ─────────────────────────────────────────────────────────

/**
 * Extract a lightweight DiscoverySummary from a full DiscoveryResult.
 *
 * Used to embed a small summary in SessionState without bloating it.
 */
export function extractDiscoverySummary(result: DiscoveryResult): DiscoverySummary {
  return {
    primaryLanguages: result.stack.languages.filter((l) => l.confidence >= 0.3).map((l) => l.id),
    frameworks: result.stack.frameworks.map((f) => f.id),
    topologyKind: result.topology.kind,
    moduleCount: result.topology.modules.length,
    hasApiSurface: result.surfaces.api.length > 0,
    hasPersistenceSurface: result.surfaces.persistence.length > 0,
    hasCiCd: result.surfaces.cicd.length > 0,
    hasSecuritySurface: result.surfaces.security.length > 0,
    codeSurfaceStatus: result.codeSurfaces?.status,
    apiEndpointCount: result.codeSurfaces?.endpoints.length,
    hasAuthBoundary: (result.codeSurfaces?.authBoundaries.length ?? 0) > 0,
  };
}

/** Sort priority: language=0, framework=1, runtime=2, buildTool=3, tool=4, testFramework=5, qualityTool=6, database=7. */
const TARGET_ORDER: Record<DetectedStackTarget, number> = {
  language: 0,
  framework: 1,
  runtime: 2,
  buildTool: 3,
  tool: 4,
  testFramework: 5,
  qualityTool: 6,
  database: 7,
};

/**
 * Extract a compact DetectedStack from DiscoveryResult.
 *
 * Produces a deterministic, sorted projection:
 * - items[] sorted by category order (language → framework → ...)
 * - `summary` uses `id=version` for versioned items, `id` for unversioned.
 *
 * If allFiles is provided, also extracts module-scoped stack items for monorepos.
 *
 * Derived evidence — NOT SSOT. The authoritative stack data lives in
 * `DiscoveryResult.stack`. This is a compact projection for
 * `flowguard_status.detectedStack`.
 *
 * Returns null when no items are detected at all (empty input).
 */
function collectDetectedStackItems(
  stack: StackInfo,
  items: DetectedStackItem[],
  targets: DetectedStackTargetEntry[],
): void {
  const categories: ReadonlyArray<{
    readonly items: readonly DetectedItem[];
    readonly target: DetectedStackTarget;
  }> = [
    { items: stack.languages, target: 'language' },
    { items: stack.frameworks, target: 'framework' },
    { items: stack.runtimes, target: 'runtime' },
    { items: stack.buildTools, target: 'buildTool' },
    { items: stack.tools, target: 'tool' },
    { items: stack.testFrameworks, target: 'testFramework' },
    { items: stack.qualityTools, target: 'qualityTool' },
    { items: stack.databases, target: 'database' },
  ];

  for (const { items: categoryItems, target } of categories) {
    for (const item of categoryItems) {
      pushDetectedStackItem(item, target, items, targets);
    }
  }
}

function pushDetectedStackItem(
  item: DetectedItem,
  target: DetectedStackTarget,
  items: DetectedStackItem[],
  targets: DetectedStackTargetEntry[],
): void {
  // Pick one evidence string: versionEvidence > evidence[0]
  const ev = item.versionEvidence ?? item.evidence[0];

  // All items go into items[] — version optional
  items.push({
    kind: target,
    id: item.id,
    ...(item.version ? { version: item.version } : {}),
    ...(ev ? { evidence: ev } : {}),
  });

  // Compiler targets go into targets[]
  if (item.compilerTarget) {
    targets.push({
      kind: 'compilerTarget',
      id: item.id,
      value: item.compilerTarget,
      ...(item.compilerTargetEvidence ? { evidence: item.compilerTargetEvidence } : {}),
    });
  }
}

// Deterministic sort helper
function sortByTargetThenId<T extends { id: string }>(
  arr: T[],
  getTarget: (item: T) => DetectedStackTarget,
): void {
  arr.sort((a, b) => {
    const orderDiff = TARGET_ORDER[getTarget(a)] - TARGET_ORDER[getTarget(b)];
    if (orderDiff !== 0) return orderDiff;
    return a.id.localeCompare(b.id);
  });
}

// Summary: versioned "id=version", unversioned "id"
function buildDetectedStackSummary(items: readonly DetectedStackItem[]): string {
  return items.map((i) => (i.version ? `${i.id}=${i.version}` : i.id)).join(', ');
}

// allFiles is passed as second parameter, readFile as third (optional)
// When called from hydrate.ts: extractDetectedStack(result, repoSignals.files)
async function resolveScopedStack(
  allFiles: readonly string[] | undefined,
  stack: StackInfo,
  readFile: ((path: string) => Promise<string | undefined>) | undefined,
): Promise<Awaited<ReturnType<typeof extractScopedStack>> | undefined> {
  if (!allFiles || allFiles.length === 0) return undefined;
  return extractScopedStack(allFiles, stack, readFile);
}

export async function extractDetectedStack(
  result: DiscoveryResult,
  allFiles?: readonly string[],
  readFile?: (path: string) => Promise<string | undefined>,
): Promise<DetectedStack | null> {
  const items: DetectedStackItem[] = [];
  const targets: DetectedStackTargetEntry[] = [];

  collectDetectedStackItems(result.stack, items, targets);

  if (items.length === 0) return null;

  sortByTargetThenId(items, (i) => i.kind);

  const summary = buildDetectedStackSummary(items);
  const scopes = await resolveScopedStack(allFiles, result.stack, readFile);

  return {
    summary,
    items,
    ...(targets.length > 0 ? { targets } : {}),
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
  };
}
