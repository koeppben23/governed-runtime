/**
 * @module discovery/orchestrator
 * @description Discovery orchestrator — runs all collectors and assembles DiscoveryResult.
 *
 * Design:
 * - Each collector runs independently (Promise.allSettled)
 * - Collector failure degrades that collector only (status: "failed")
 * - Partial results are allowed — the orchestrator never fails entirely
 * - Per-collector timeout budget (configurable, default 10s)
 * - Produces a complete DiscoveryResult with all sections populated
 *
 * Also provides:
 * - extractDiscoverySummary(): extracts DiscoverySummary from DiscoveryResult
 * - computeDiscoveryDigest(): SHA-256 of canonical JSON for drift detection
 *
 * @version v1
 */

import { createHash } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { withSpan, addFingerprint } from '../telemetry';
import type {
  CollectorInput,
  CollectorStatus,
  DetectedStack,
  DetectedStackTarget,
  DetectedStackVersion,
  DiscoveryResult,
  DiscoverySummary,
  StackInfo,
  TopologyInfo,
  ValidationHints,
} from './types';
import { DISCOVERY_SCHEMA_VERSION } from './types';
import { collectRepoMetadata } from './collectors/repo-metadata';
import { collectStack } from './collectors/stack-detection';
import { collectTopology } from './collectors/topology';
import { collectSurfaces } from './collectors/surface-detection';
import { collectCodeSurfaces } from './collectors/code-surface-analysis';
import { collectDomainSignals } from './collectors/domain-signals';

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
  return async (relativePath: string): Promise<string | undefined> => {
    try {
      return await fsReadFile(nodePath.join(worktreePath, relativePath), 'utf8');
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
  timeoutMs: number = COLLECTOR_TIMEOUT_MS,
): Promise<DiscoveryResult> {
  return withSpan(
    'discovery.run',
    async () => {
      addFingerprint(input.fingerprint);
      return runDiscoveryImpl(input, timeoutMs);
    },
    { 'flowguard.fingerprint': input.fingerprint },
  );
}

async function runDiscoveryImpl(
  input: CollectorInput,
  timeoutMs: number = COLLECTOR_TIMEOUT_MS,
): Promise<DiscoveryResult> {
  // Enrich input with default readFile if not provided by caller
  const enrichedInput: CollectorInput = input.readFile
    ? input
    : { ...input, readFile: createDefaultReadFile(input.worktreePath) };

  // Run all collectors in parallel with timeout budget
  const [metaResult, stackResult, topoResult, surfaceResult, codeSurfaceResult, domainResult] =
    await Promise.allSettled([
      withTimeout(collectRepoMetadata(enrichedInput), timeoutMs),
      withTimeout(collectStack(enrichedInput), timeoutMs),
      withTimeout(collectTopology(enrichedInput), timeoutMs),
      withTimeout(collectSurfaces(enrichedInput), timeoutMs),
      withTimeout(collectCodeSurfaces(enrichedInput), timeoutMs),
      withTimeout(collectDomainSignals(enrichedInput), timeoutMs),
    ]);

  // Extract results with safe defaults for failures
  const collectors: Record<string, CollectorStatus> = {};

  const meta = extractResult(metaResult, 'repo-metadata', collectors, {
    defaultBranch: null,
    headCommit: null,
    isDirty: true,
    worktreePath: input.worktreePath,
    canonicalRemote: null,
    fingerprint: input.fingerprint,
  });

  const stack = extractResult(stackResult, 'stack-detection', collectors, {
    languages: [],
    frameworks: [],
    buildTools: [],
    testFrameworks: [],
    runtimes: [],
    tools: [],
    qualityTools: [],
  });

  const topology = extractResult(topoResult, 'topology', collectors, {
    kind: 'unknown' as const,
    modules: [],
    entryPoints: [],
    rootConfigs: [],
    ignorePaths: [],
  });

  const surfaces = extractResult(surfaceResult, 'surface-detection', collectors, {
    api: [],
    persistence: [],
    cicd: [],
    security: [],
    layers: [],
  });

  const codeSurfaces = extractResult(codeSurfaceResult, 'code-surface-analysis', collectors, {
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
  });

  const domain = extractResult(domainResult, 'domain-signals', collectors, {
    keywords: [],
    glossarySources: [],
  });

  // Derive validation hints from stack + topology
  const validationHints = deriveValidationHints(stack, topology, input);

  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    collectedAt: new Date().toISOString(),
    collectors,
    repoMetadata: meta,
    stack,
    topology,
    surfaces,
    codeSurfaces,
    domainSignals: domain,
    validationHints,
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

/** Sort priority: language=0, framework=1, runtime=2, buildTool=3, tool=4, testFramework=5, qualityTool=6. */
const TARGET_ORDER: Record<DetectedStackTarget, number> = {
  language: 0,
  framework: 1,
  runtime: 2,
  buildTool: 3,
  tool: 4,
  testFramework: 5,
  qualityTool: 6,
};

/**
 * Extract a compact detected stack from a full DiscoveryResult.
 *
 * Returns only items that have a `.version` string. Items are sorted
 * deterministically: by category (language → framework → runtime → buildTool
 * → tool → testFramework → qualityTool), then by id within each category.
 *
 * Derived evidence — NOT SSOT. The authoritative version data lives in
 * `DiscoveryResult.stack`. This is a compact projection for
 * `flowguard_status.detectedStack`.
 *
 * Returns null when no versioned items are found.
 */
export function extractDetectedStack(result: DiscoveryResult): DetectedStack | null {
  const entries: DetectedStackVersion[] = [];

  const categories: Array<{ items: typeof result.stack.languages; target: DetectedStackTarget }> = [
    { items: result.stack.languages, target: 'language' },
    { items: result.stack.frameworks, target: 'framework' },
    { items: result.stack.runtimes, target: 'runtime' },
    { items: result.stack.buildTools, target: 'buildTool' },
    { items: result.stack.tools ?? [], target: 'tool' },
    { items: result.stack.testFrameworks, target: 'testFramework' },
    { items: result.stack.qualityTools ?? [], target: 'qualityTool' },
  ];

  for (const { items, target } of categories) {
    for (const item of items) {
      if (item.version) {
        entries.push({
          id: item.id,
          version: item.version,
          target,
          ...(item.versionEvidence ? { evidence: item.versionEvidence } : {}),
        });
      }
    }
  }

  if (entries.length === 0) return null;

  // Deterministic sort: category order, then alphabetical by id
  entries.sort((a, b) => {
    const orderDiff = TARGET_ORDER[a.target] - TARGET_ORDER[b.target];
    if (orderDiff !== 0) return orderDiff;
    return a.id.localeCompare(b.id);
  });

  const summary = entries.map((e) => `${e.id}=${e.version}`).join(', ');

  return { summary, versions: entries };
}

/**
 * Compute SHA-256 digest of a DiscoveryResult.
 *
 * Uses canonical JSON (recursively sorted keys) for deterministic hashing.
 * Used as `discoveryDigest` on SessionState for drift detection.
 */
export function computeDiscoveryDigest(result: DiscoveryResult): string {
  const canonical = JSON.stringify(canonicalize(result));
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Recursively produce a canonical form of a JSON-compatible value.
 *
 * - Objects: keys sorted lexicographically, values canonicalized recursively.
 * - Arrays: element order preserved (order is semantic), values canonicalized.
 * - Primitives: returned unchanged.
 *
 * This guarantees that two structurally equal values produce identical
 * JSON.stringify output regardless of original key insertion order.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  // Object: sort keys lexicographically, recurse into values
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Wrap a promise with a timeout.
 * Rejects with a timeout error if the promise doesn't resolve in time.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Collector timed out after ${ms}ms`)), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

/**
 * Extract collector result or use default on failure.
 * Records collector status in the collectors map.
 */
function extractResult<T>(
  settled: PromiseSettledResult<{ status: CollectorStatus; data: T }>,
  name: string,
  collectors: Record<string, CollectorStatus>,
  defaultData: T,
): T {
  if (settled.status === 'fulfilled') {
    collectors[name] = settled.value.status;
    return settled.value.data;
  }
  // Collector failed or timed out
  collectors[name] = 'failed';
  return defaultData;
}

/**
 * Derive validation hints from stack and topology analysis.
 *
 * Infers likely build/test/lint commands based on detected tools.
 */
function deriveValidationHints(
  stack: StackInfo,
  topology: TopologyInfo,
  input: CollectorInput,
): ValidationHints {
  const commands: ValidationHints['commands'] = [];
  const lintTools: ValidationHints['lintTools'] = [];

  // Detect build/test commands from build tools
  const buildToolIds = new Set(stack.buildTools.map((t) => t.id));

  if (buildToolIds.has('npm')) {
    commands.push(
      {
        kind: 'build',
        command: 'npm run build',
        confidence: 0.7,
        classification: 'derived_signal',
      },
      { kind: 'test', command: 'npm test', confidence: 0.8, classification: 'derived_signal' },
    );
  }
  if (buildToolIds.has('maven')) {
    commands.push(
      { kind: 'build', command: 'mvn compile', confidence: 0.8, classification: 'derived_signal' },
      { kind: 'test', command: 'mvn test', confidence: 0.8, classification: 'derived_signal' },
    );
  }
  if (buildToolIds.has('gradle') || buildToolIds.has('gradle-kotlin')) {
    commands.push(
      { kind: 'build', command: 'gradle build', confidence: 0.8, classification: 'derived_signal' },
      { kind: 'test', command: 'gradle test', confidence: 0.8, classification: 'derived_signal' },
    );
  }
  if (buildToolIds.has('cargo')) {
    commands.push(
      { kind: 'build', command: 'cargo build', confidence: 0.9, classification: 'derived_signal' },
      { kind: 'test', command: 'cargo test', confidence: 0.9, classification: 'derived_signal' },
    );
  }
  if (buildToolIds.has('go-modules')) {
    commands.push(
      {
        kind: 'build',
        command: 'go build ./...',
        confidence: 0.9,
        classification: 'derived_signal',
      },
      { kind: 'test', command: 'go test ./...', confidence: 0.9, classification: 'derived_signal' },
    );
  }

  // Detect typecheck commands
  const configSet = new Set(input.configFiles);
  if (configSet.has('tsconfig.json')) {
    commands.push({
      kind: 'typecheck',
      command: 'npx tsc --noEmit',
      confidence: 0.85,
      classification: 'derived_signal',
    });
  }

  // Detect test frameworks as lint/check tools
  for (const tf of stack.testFrameworks) {
    if (tf.id === 'vitest') {
      commands.push({
        kind: 'test',
        command: 'npx vitest run',
        confidence: 0.9,
        classification: 'derived_signal',
      });
    }
    if (tf.id === 'jest') {
      commands.push({
        kind: 'test',
        command: 'npx jest',
        confidence: 0.85,
        classification: 'derived_signal',
      });
    }
  }

  // Detect lint tools from config files
  const eslintConfigs = [
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.json',
    '.eslintrc.yml',
    'eslint.config.js',
    'eslint.config.mjs',
  ];
  if (eslintConfigs.some((c) => configSet.has(c))) {
    lintTools.push({
      id: 'eslint',
      confidence: 0.9,
      classification: 'fact',
      evidence: eslintConfigs.filter((c) => configSet.has(c)),
    });
    commands.push({
      kind: 'lint',
      command: 'npx eslint .',
      confidence: 0.7,
      classification: 'derived_signal',
    });
  }

  const prettierConfigs = ['.prettierrc', '.prettierrc.json'];
  if (prettierConfigs.some((c) => configSet.has(c))) {
    lintTools.push({
      id: 'prettier',
      confidence: 0.9,
      classification: 'fact',
      evidence: prettierConfigs.filter((c) => configSet.has(c)),
    });
    commands.push({
      kind: 'format',
      command: 'npx prettier --check .',
      confidence: 0.7,
      classification: 'derived_signal',
    });
  }

  return { commands, lintTools };
}
