/**
 * @module discovery/collectors/topology
 * @description Collector: repository topology analysis.
 *
 * Determines:
 * - Topology kind: monorepo, single-project, or unknown
 * - Modules: packages/workspaces detected from manifests
 * - Entry points: main files, bin scripts, handlers
 * - Root configs: top-level configuration files
 * - Ignore paths: directories to exclude from analysis
 *
 * Detection strategy:
 * - Multiple package manifests in subdirectories → monorepo signal
 * - nx.json or workspaces in package.json → monorepo signal
 * - Single root package.json / pom.xml only → single-project
 *
 * @version v1
 */

import * as path from 'node:path';
import type {
  CollectorInput,
  CollectorOutput,
  TopologyInfo,
  TopologyKind,
  ModuleInfo,
  EntryPointInfo,
} from '../types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Package manifest filenames (basename match). */
const MANIFEST_BASENAMES = new Set([
  'package.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'composer.json',
]);

/** Monorepo indicator config files. */
const MONOREPO_INDICATORS = new Set(['nx.json', 'lerna.json', 'pnpm-workspace.yaml', 'rush.json']);

/** Standard ignore paths. */
const IGNORE_PATHS = [
  'node_modules',
  'dist',
  'build',
  'out',
  '.git',
  'coverage',
  '.next',
  '.nuxt',
  'target',
  'vendor',
  '__pycache__',
  '.gradle',
];

/** Common entry point patterns (basename). */
const ENTRY_POINT_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  kind: EntryPointInfo['kind'];
}> = [
  { pattern: /^(?:index|main|app|server)\.[tj]sx?$/, kind: 'main' },
  { pattern: /^handler\.[tj]sx?$/, kind: 'handler' },
  { pattern: /^cli\.[tj]sx?$/, kind: 'bin' },
  { pattern: /^Main\.java$/, kind: 'main' },
  { pattern: /^main\.go$/, kind: 'main' },
  { pattern: /^main\.py$/, kind: 'main' },
  { pattern: /^main\.rs$/, kind: 'main' },
];

// ─── Collector ────────────────────────────────────────────────────────────────

/**
 * Collect repository topology information.
 *
 * Analyzes file paths to determine project structure:
 * - Counts and locates package manifests
 * - Detects monorepo indicators
 * - Identifies modules (subdirectory manifests)
 * - Finds entry points
 * - Lists root-level config files
 */
export async function collectTopology(
  input: CollectorInput,
): Promise<CollectorOutput<TopologyInfo>> {
  try {
    const modules = detectModules(input.allFiles);
    const kind = detectTopologyKind(modules, input.configFiles);
    const entryPoints = detectEntryPoints(input.allFiles);
    const rootConfigs = detectRootConfigs(input.allFiles);

    return {
      status: 'complete',
      data: {
        kind,
        modules,
        entryPoints,
        rootConfigs,
        ignorePaths: [...IGNORE_PATHS],
      },
    };
  } catch {
    return {
      status: 'failed',
      data: {
        kind: 'unknown',
        modules: [],
        entryPoints: [],
        rootConfigs: [],
        ignorePaths: [...IGNORE_PATHS],
      },
    };
  }
}

// ─── Internal Detection Functions ─────────────────────────────────────────────

/**
 * Detect modules by finding package manifest files in subdirectories.
 *
 * A "module" is a directory containing a package manifest that is NOT the root.
 * Root-level manifests are handled separately in topology kind detection.
 */
function detectModules(allFiles: readonly string[]): ModuleInfo[] {
  const modules: ModuleInfo[] = [];

  for (const filePath of allFiles) {
    const basename = path.basename(filePath);
    if (!MANIFEST_BASENAMES.has(basename)) continue;

    const dir = path.dirname(filePath);
    // Normalize: root-level files have dir === "." — skip those
    if (dir === '.' || dir === '') continue;
    // Skip files deep in node_modules, dist, etc.
    const normalized = filePath.replace(/\\/g, '/');
    if (IGNORE_PATHS.some((p) => normalized.includes(`${p}/`))) continue;

    modules.push({
      path: dir,
      name: dir.replace(/\\/g, '/').split('/').pop() ?? dir,
      manifestFile: basename,
    });
  }

  return modules;
}

/**
 * Determine topology kind based on module count and monorepo indicators.
 */
function detectTopologyKind(
  modules: readonly ModuleInfo[],
  configFiles: readonly string[],
): TopologyKind {
  const configSet = new Set(configFiles);

  // Strong monorepo signals
  const hasMonorepoIndicator = [...MONOREPO_INDICATORS].some((f) => configSet.has(f));
  if (hasMonorepoIndicator) return 'monorepo';

  // Multiple modules (subdirectory manifests) → monorepo
  if (modules.length >= 2) return 'monorepo';

  // Has at least one config or package file → single project
  if (configFiles.length > 0) return 'single-project';

  return 'unknown';
}

/**
 * Detect entry points by matching file basenames against known patterns.
 * Only considers files in the root or first-level src/ directories.
 */
function detectEntryPoints(allFiles: readonly string[]): EntryPointInfo[] {
  const entryPoints: EntryPointInfo[] = [];
  const seen = new Set<string>();

  for (const filePath of allFiles) {
    const normalized = filePath.replace(/\\/g, '/');
    const depth = normalized.split('/').length;
    // Only root (depth 1) or one level deep (depth 2, e.g., src/main.ts)
    if (depth > 2) continue;

    const basename = path.basename(filePath);

    for (const rule of ENTRY_POINT_PATTERNS) {
      if (rule.pattern.test(basename) && !seen.has(filePath)) {
        seen.add(filePath);
        entryPoints.push({
          path: filePath,
          kind: rule.kind,
        });
      }
    }
  }

  return entryPoints;
}

/**
 * Detect root-level config files (files in the repository root).
 */
function detectRootConfigs(allFiles: readonly string[]): string[] {
  const configs: string[] = [];

  for (const filePath of allFiles) {
    const normalized = filePath.replace(/\\/g, '/');
    // Root-level only: no directory separator
    if (normalized.includes('/')) continue;

    const ext = path.extname(filePath).toLowerCase();
    const basename = filePath.toLowerCase();

    // Config patterns: dotfiles, .json, .yaml, .yml, .toml, .xml, Makefile, Dockerfile
    if (
      basename.startsWith('.') ||
      ext === '.json' ||
      ext === '.yaml' ||
      ext === '.yml' ||
      ext === '.toml' ||
      ext === '.xml' ||
      ext === '.config' ||
      basename === 'makefile' ||
      basename === 'dockerfile' ||
      basename === 'rakefile' ||
      basename === 'gemfile'
    ) {
      configs.push(filePath);
    }
  }

  return configs.sort();
}
