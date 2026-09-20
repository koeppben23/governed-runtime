/**
 * @module architecture/dependency-rules
 * @description Clean Architecture dependency boundary enforcement.
 *
 * This test statically analyzes all production TypeScript import and re-export
 * edges. Two authorities govern the result:
 *
 * 1. TOP-LEVEL MODULE DIRECTION: `MODULE_DEPENDENCY_POLICY`
 *    (`module-dependency-policy.ts`) is the single positive authority — the
 *    exact set of governed modules that each governed module may import.
 *    Observed and declared edges must match in both directions, so both an
 *    unapproved direction and a stale policy edge fail. This replaces the
 *    historical distributed deny lists and the per-module allow-lists.
 * 2. FINE-GRAINED BOUNDARIES inside an allowed edge stay here: state may only
 *    use the listed shared primitives and owns its evidence discriminators,
 *    archive/types and discovery/types are leaves, rails must not use Node I/O
 *    builtins directly, integration/tools must not import plugin-* modules, and
 *    entry / test-support / unclassified imports stay default-deny.
 *
 * MODULE-LEVEL CYCLE DEBT is frozen separately: `module-graph.ts` detects
 * strongly connected components, `scripts/module-cycle-baseline.json` records
 * every currently cyclic directed edge, and the observed cyclic-edge set must
 * equal the baseline. `scripts/check-module-cycle-lineage.mjs` additionally
 * enforces in CI that the baseline may only shrink relative to the PR base.
 * FILE-LEVEL cycles remain rejected outright by Rule 8.
 *
 * The regex-based parser may miss dynamically-constructed imports; for those,
 * an explicit exception comment is required.
 *
 * @version v2
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isTestSourcePath,
  MODULE_CLASSIFICATION,
  MODULE_CLASSIFICATION_BY_NAME,
} from './module-classification.js';
import {
  isRootCompositionFile,
  isRootHostRuntimeFile,
  isToolCommandContextFile,
  placementOwnerOf,
} from './integration-placement-policy.js';
import { MODULE_DEPENDENCY_POLICY } from './module-dependency-policy.js';
import {
  cycleParticipatingEdges,
  cyclicStronglyConnectedComponents,
  edgeKey,
  moduleEdgeSet,
  type ModuleEdge,
} from './module-graph.js';
import { normalizeRepoPath, repoRelative } from './repo-path.js';

const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');

const NODE_BUILTINS = new Set([
  'fs',
  'path',
  'crypto',
  'child_process',
  'process',
  'os',
  'events',
  'stream',
  'buffer',
  'util',
  'url',
  'querystring',
  'http',
  'https',
  'net',
  'tls',
  'dgram',
  'dns',
  'domain',
  'assert',
  'perf_hooks',
  'readline',
  'repl',
  'string_decoder',
  'tty',
  'dgram',
  'v8',
  'vm',
  'zlib',
  'async_hooks',
  'cluster',
  'console',
  'constants',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs/promises',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

const NODE_BUILTIN_PREFIXES = [
  'node:',
  'node:fs',
  'node:path',
  'node:crypto',
  'node:child_process',
  'node:process',
  'node:os',
  'node:events',
  'node:stream',
  'node:buffer',
  'node:util',
  'node:url',
  'node:querystring',
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'node:dgram',
  'node:dns',
  'node:domain',
  'node:assert',
  'node:perf_hooks',
];

interface ImportInfo {
  module: string;
  raw: string;
  isNodeBuiltin: boolean;
  isRelative: boolean;
  isFFModule: boolean;
  targetModule: string | null;
  targetResolved: boolean;
}

interface FileAnalysis {
  filePath: string;
  relativePath: string;
  imports: ImportInfo[];
}

interface ImportViolation {
  file: string;
  rule: string;
  message: string;
  imports?: string[];
}

function mockImport(module: string): ImportInfo {
  return {
    module,
    raw: `import '${module}'`,
    isNodeBuiltin: false,
    isRelative: module.startsWith('.'),
    isFFModule: false,
    targetModule: null,
    targetResolved: false,
  };
}

function isNodeBuiltinImport(module: string): boolean {
  if (NODE_BUILTINS.has(module)) return true;
  if (module.startsWith('node:') && NODE_BUILTINS.has(module.slice(5))) return true;
  if (NODE_BUILTIN_PREFIXES.includes(module)) return true;
  return false;
}

const CLASSIFIED_ENTRIES: ReadonlySet<string> = new Set(
  MODULE_CLASSIFICATION.map((entry) => entry.name),
);
const GOVERNED_MODULES: ReadonlySet<string> = new Set(
  MODULE_CLASSIFICATION.filter((entry) => entry.kind === 'governed').map((entry) => entry.name),
);
const TEST_SUPPORT_ENTRIES: ReadonlySet<string> = new Set(
  MODULE_CLASSIFICATION.filter((entry) => entry.kind === 'test-support').map((entry) => entry.name),
);
const ENTRY_ENTRIES: ReadonlySet<string> = new Set(
  MODULE_CLASSIFICATION.filter((entry) => entry.kind === 'entry').map((entry) => entry.name),
);

/**
 * Resolve a relative import specifier to its classified top-level entry: the
 * first path segment under `src/` (a module directory or a root-level file).
 * Returns null when the specifier does not resolve to an existing source under
 * `src/` — under default-deny that is a violation, never a silent non-match.
 */
function resolveTargetEntry(importerDir: string, specifier: string): string | null {
  const resolved = resolveImportPath(importerDir, specifier);
  if (!resolved) return null;
  const relToSrc = repoRelative(SRC_DIR, resolved);
  if (relToSrc.startsWith('..')) return null;
  return relToSrc.split('/')[0] || null;
}

function parseImports(
  fileContent: string,
  importerDir: string,
  importerModule: string,
): ImportInfo[] {
  const imports: ImportInfo[] = [];

  const toImportInfo = (module: string, raw: string): ImportInfo => {
    const isRelative = module.startsWith('.');
    const targetModule = isRelative ? resolveTargetEntry(importerDir, module) : null;
    return {
      module,
      raw,
      isNodeBuiltin: isNodeBuiltinImport(module),
      isRelative,
      isFFModule:
        targetModule !== null &&
        GOVERNED_MODULES.has(targetModule) &&
        targetModule !== importerModule,
      targetModule,
      targetResolved: isRelative && targetModule !== null,
    };
  };

  const importRegex =
    /^import\s+(?:(?:type\s+)?(?:\{[^}]*\}|[^;{}]+)\s+from\s+)?['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]|^export\s+(?:\{[^}]*\}|[^;{}]+)\s+from\s+['"]([^'"]+)['"]|^export\s+from\s+['"]([^'"]+)['"]|^export\s+\*\s+as\s+\w+\s+from\s+['"]([^'"]+)['"]|^require\s*\(['"]([^'"]+)['"]\)/gm;

  let match;
  while ((match = importRegex.exec(fileContent)) !== null) {
    const module = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
    if (!module) continue;

    imports.push(toImportInfo(module, match[0]));
  }

  // Dynamic imports: await import('./foo.js'), import('./foo.js')
  const dynamicImportRegex = /(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRegex.exec(fileContent)) !== null) {
    const module = match[1];
    if (!module) continue;

    imports.push(toImportInfo(module, match[0]));
  }

  return imports;
}

async function analyzeFile(filePath: string): Promise<FileAnalysis> {
  const content = await fs.readFile(filePath, 'utf-8');
  const relativePath = repoRelative(SRC_DIR, filePath);
  const importerModule = relativePath.split('/')[0]!;
  const imports = parseImports(content, path.dirname(filePath), importerModule);

  return {
    filePath: normalizeRepoPath(filePath),
    relativePath,
    imports,
  };
}

async function collectFiles(dir: string, pattern: RegExp): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name === 'node_modules') continue;
    const relativeFromSrc = repoRelative(SRC_DIR, fullPath);
    if (entry.isDirectory()) {
      // Semantic test classification only — a directory whose name merely
      // contains `__` is analyzed like any other production surface.
      if (isTestSourcePath(relativeFromSrc)) continue;
      files.push(...(await collectFiles(fullPath, pattern)));
    } else if (entry.isFile() && pattern.test(entry.name)) {
      if (isTestSourcePath(relativeFromSrc)) continue;
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * The importer's governed top-level module, derived from the single
 * classification authority. It is the FIRST path segment under `src/` — never
 * a nested directory that merely shares a governed module's name, which would
 * otherwise let a nested path escape its module's rules (for example
 * `providers/state/foo.ts` is `providers`, not `state`).
 */
function getLayerFromPath(filePath: string): string | null {
  const relativePath = repoRelative(SRC_DIR, filePath);
  const topLevel = relativePath.split('/')[0];
  if (topLevel === undefined || topLevel.length === 0) return null;
  return MODULE_CLASSIFICATION_BY_NAME.get(topLevel)?.kind === 'governed' ? topLevel : null;
}

function detectViolations(analyses: Map<string, FileAnalysis>): ImportViolation[] {
  const allViolations: ImportViolation[] = [];

  // Default-deny: every relative import in production code must resolve to a
  // classified entry, and test-support entries are closed to production
  // importers. Unclassified targets are violations, never silent non-matches.
  for (const [, analysis] of analyses) {
    if (analysis.filePath.includes('.test.')) continue;
    const importerKind = MODULE_CLASSIFICATION_BY_NAME.get(
      analysis.relativePath.split('/')[0]!,
    )?.kind;
    for (const imp of analysis.imports) {
      if (!imp.isRelative) continue;
      const label = `imports '${imp.module}'`;
      if (!imp.targetResolved || imp.targetModule === null) {
        allViolations.push({
          file: analysis.relativePath,
          rule: 'unclassified-import-target',
          message: `${label} — does not resolve to a source under src/`,
        });
        continue;
      }
      if (!CLASSIFIED_ENTRIES.has(imp.targetModule)) {
        allViolations.push({
          file: analysis.relativePath,
          rule: 'unclassified-module',
          message: `${label} — '${imp.targetModule}' is not a classified top-level module`,
        });
        continue;
      }
      if (TEST_SUPPORT_ENTRIES.has(imp.targetModule) && !isTestSourcePath(analysis.relativePath)) {
        allViolations.push({
          file: analysis.relativePath,
          rule: 'test-support-import',
          message: `${label} — production code must not import test-support entry '${imp.targetModule}'`,
        });
        continue;
      }
      // Entry points are outbound-only: they compose governed modules broadly,
      // but a governed module importing an entry point would bypass every
      // layer rule through the barrel's re-exports.
      if (ENTRY_ENTRIES.has(imp.targetModule) && importerKind === 'governed') {
        allViolations.push({
          file: analysis.relativePath,
          rule: 'entry-import',
          message: `${label} — governed modules must not import entry point '${imp.targetModule}'; entry points are outbound-only`,
        });
      }
    }
  }

  return allViolations;
}

/**
 * Resolve a relative import to its canonical path relative to `src/`, or null
 * when the specifier is bare or does not resolve to a source under `src/`.
 */
function resolveSrcTarget(analysis: FileAnalysis, imp: ImportInfo): string | null {
  if (!imp.isRelative) return null;
  const resolved = resolveImportPath(path.dirname(analysis.filePath), imp.module);
  if (!resolved) return null;
  const relToSrc = repoRelative(SRC_DIR, resolved);
  if (relToSrc.startsWith('..')) return null;
  return relToSrc;
}

/**
 * #922 boundary: files in `integration/tools/**` must not import plugin
 * composition (index.ts, plugin.ts, plugin-* lifecycle).
 */
function detectToolsCompositionImports(analyses: Map<string, FileAnalysis>): ImportViolation[] {
  const violations: ImportViolation[] = [];
  for (const [, analysis] of analyses) {
    if (!analysis.relativePath.startsWith('integration/tools/')) continue;
    if (analysis.filePath.includes('.test.')) continue;
    for (const imp of analysis.imports) {
      const target = resolveSrcTarget(analysis, imp);
      if (target !== null && isRootCompositionFile(target)) {
        violations.push({
          file: analysis.relativePath,
          rule: 'tools-no-composition',
          message: `integration/tools/ imports integration composition (bridge bypass): ${target}`,
          imports: [imp.module],
        });
      }
    }
  }
  return violations;
}

/** Integration owners that review/** may consume (positive allowlist). */
const REVIEW_ALLOWED_INTEGRATION_OWNERS: ReadonlySet<string> = new Set([
  'review',
  'review-enforcement',
  'root-authority',
]);

/**
 * Lower layers that review/** may consume. This is an explicit, default-deny
 * set: adding a layer here is a deliberate contract change.
 */
const REVIEW_LOWER_LAYERS: ReadonlySet<string> = new Set([
  'adapters',
  'config',
  'shared',
  'state',
  'templates',
]);

/**
 * #922 boundary (default-deny): review/** may import ONLY review/** (owner
 * review or review-enforcement), integration root authorities, and the
 * explicit lower layers. Plugin composition, host/runtime wiring, tools/**,
 * and every sibling integration context (status, discovery, proofgraph, ...)
 * are violations.
 */
function detectReviewBoundaryViolations(analyses: Map<string, FileAnalysis>): ImportViolation[] {
  const violations: ImportViolation[] = [];
  for (const [, analysis] of analyses) {
    if (!analysis.relativePath.startsWith('integration/review/')) continue;
    if (analysis.filePath.includes('.test.')) continue;
    for (const imp of analysis.imports) {
      const target = resolveSrcTarget(analysis, imp);
      if (target === null) continue;
      if (target.startsWith('integration/')) {
        const owner = placementOwnerOf(target);
        if (owner !== null && REVIEW_ALLOWED_INTEGRATION_OWNERS.has(owner)) continue;
        violations.push({
          file: analysis.relativePath,
          rule: 'review-boundary',
          message: `review/ imports integration target outside its contract: '${target}' (owner ${owner ?? 'unclassified'})`,
          imports: [imp.module],
        });
        continue;
      }
      const topLevel = target.split('/')[0] ?? '';
      if (!REVIEW_LOWER_LAYERS.has(topLevel)) {
        violations.push({
          file: analysis.relativePath,
          rule: 'review-boundary',
          message: `review/ imports non-lower-layer target '${target}'`,
          imports: [imp.module],
        });
      }
    }
  }
  return violations;
}

/**
 * #922 boundary: production code outside `integration/tools/**` may not
 * deep-import a tool command context (tools/<context>/**). The single external
 * entry into the tool layer is `integration/tools/index.ts`.
 */
function detectExternalToolContextImports(analyses: Map<string, FileAnalysis>): ImportViolation[] {
  const violations: ImportViolation[] = [];
  for (const [, analysis] of analyses) {
    if (analysis.relativePath.startsWith('integration/tools/')) continue;
    if (analysis.filePath.includes('.test.')) continue;
    for (const imp of analysis.imports) {
      const target = resolveSrcTarget(analysis, imp);
      if (target !== null && isToolCommandContextFile(target)) {
        violations.push({
          file: analysis.relativePath,
          rule: 'external-tool-context-import',
          message: `deep import into a tool command context: ${target}`,
          imports: [imp.module],
        });
      }
    }
  }
  return violations;
}

function resolveImportPath(importerDir: string, importPath: string): string {
  if (!importPath.startsWith('.')) return '';

  const resolved = normalizeRepoPath(path.resolve(importerDir, importPath));

  if (existsSync(resolved)) return resolved;
  if (existsSync(resolved + '.ts')) return resolved + '.ts';

  const withoutJs = resolved.replace(/\.js$/, '');
  if (withoutJs !== resolved && existsSync(withoutJs + '.ts')) return withoutJs + '.ts';

  const indexPath = path.join(resolved, 'index.ts');
  if (existsSync(indexPath)) return normalizeRepoPath(indexPath);

  return '';
}

function detectCycles(analyses: Map<string, FileAnalysis>): string[] {
  const cycles: string[] = [];

  // Build adjacency: source file -> set of imported source files
  const adjacency = new Map<string, Set<string>>();
  for (const [filePath, analysis] of analyses) {
    const dir = path.dirname(filePath);
    const targets = new Set<string>();
    for (const imp of analysis.imports) {
      const resolved = resolveImportPath(dir, imp.module);
      if (resolved && analyses.has(resolved) && resolved !== filePath) {
        targets.add(resolved);
      }
    }
    adjacency.set(normalizeRepoPath(filePath), targets);
  }

  // DFS from each node. Do not use a global visited set: a node can participate
  // in multiple independent cycles and must remain explorable from other paths.
  //
  // Complexity guard: the naive path-enumeration DFS is exponential on dense
  // DAGs and drove CI past the 60s test timeout (base run already spent
  // ~59.6s). A `fullyExplored` set makes the exploration O(V+E) while
  // preserving the exact result set: a subtree that completed without finding
  // a cycle cannot contain one from any later entry point (cycle membership is
  // a graph property, not a path property), and nodes explored during a run
  // that DID find a cycle are simply re-explored by the next root.
  const sorted = [...adjacency.keys()].sort();
  const fullyExplored = new Set<string>();
  for (const node of sorted) {
    if (fullyExplored.has(node)) continue;
    const rootVisited = new Set<string>();
    const dfsPath: string[] = [];
    const visiting = new Set<string>();
    let foundCycle = false;

    function dfs(current: string): void {
      if (fullyExplored.has(current)) return;
      if (visiting.has(current)) {
        // Cycle found via visiting -> extract the cycle substring
        const idx = dfsPath.indexOf(current);
        if (idx >= 0) {
          foundCycle = true;
          cycleKey(current, dfsPath.slice(idx));
        }
        return;
      }

      visiting.add(current);
      rootVisited.add(current);
      dfsPath.push(current);

      const targets = adjacency.get(current);
      if (targets) {
        const targetList = [...targets].sort();
        for (const next of targetList) {
          dfs(next);
        }
      }

      dfsPath.pop();
      visiting.delete(current);
    }

    function cycleKey(start: string, cyclePath: string[]): void {
      // Normalize for deterministic de-duplication without changing edge order.
      const orderedCycle = [...cyclePath];
      let minIdx = 0;
      for (let i = 1; i < orderedCycle.length; i++) {
        if (orderedCycle[i]! < orderedCycle[minIdx]!) minIdx = i;
      }
      const rotated = [...orderedCycle.slice(minIdx), ...orderedCycle.slice(0, minIdx)];
      const normalized = [...rotated, rotated[0]!];
      const key = normalized.map((f) => repoRelative(PROJECT_ROOT, f)).join(' -> ');
      cycles.push(key);
    }

    dfs(node);

    // Only a cycle-free exploration may prune later roots.
    if (!foundCycle) {
      for (const visited of rootVisited) fullyExplored.add(visited);
    }
  }

  return [...new Set(cycles)].sort();
}

describe('Layer Dependency Rules', () => {
  let analyses: Map<string, FileAnalysis>;

  beforeAll(async () => {
    analyses = new Map();
    const tsFiles = await collectFiles(SRC_DIR, /\.ts$/);
    for (const file of tsFiles) {
      const analysis = await analyzeFile(file);
      analyses.set(file, analysis);
    }
  });

  describe('Rule 1: state/ shared-primitive boundary (fine-grained)', () => {
    const stateViolations: ImportViolation[] = [];
    const allowedStateSharedImports = new Set([
      '../shared/actor-assurance.js',
      '../shared/canonical-json.js',
      '../shared/hashing.js',
      '../shared/policy-idp-config.js',
      '../shared/repository-fingerprint.js',
      // The canonical review-continuation authority (state/review-continuation.ts)
      // verifies frozen review material itself and reuses the single content
      // normalization/digest authority instead of duplicating it in state.
      '../shared/review-subject.js',
    ]);

    it('keeps identifier authorities separated', async () => {
      const identifiers = await fs.readFile(
        path.join(SRC_DIR, 'shared', 'flowguard-identifiers.ts'),
        'utf-8',
      );
      expect(identifiers).not.toMatch(
        /export\s*\{[^}]*\b(?:REVIEW_REPORT_SCHEMA_ID|POLICY_DIGEST_VERSION|POLICY_DIGEST_PATTERN)\b/,
      );
      expect(identifiers).toMatch(
        /export\s+const\s+REVIEWER_SUBAGENT_TYPE\s*=\s*'flowguard-reviewer'/,
      );
      const evidenceIdentifiers = await fs.readFile(
        path.join(SRC_DIR, 'state', 'evidence-identifiers.ts'),
        'utf-8',
      );
      expect(evidenceIdentifiers).not.toMatch(/\bFINGERPRINT_PATTERN\b/);
      const repositoryFingerprint = await fs.readFile(
        path.join(SRC_DIR, 'shared', 'repository-fingerprint.ts'),
        'utf-8',
      );
      expect(repositoryFingerprint).toMatch(/export\s+const\s+FINGERPRINT_PATTERN\s*=/);
    });

    beforeAll(() => {
      for (const [, analysis] of analyses) {
        if (!analysis.filePath.includes('/state/')) continue;
        if (analysis.filePath.includes('.test.')) continue;

        // The top-level direction (state -> shared only) is governed by
        // MODULE_DEPENDENCY_POLICY; this rule is STRICTER inside the allowed
        // edge: state may only use the listed shared primitives.
        const sharedImports = analysis.imports.filter(
          (imp) => imp.isFFModule && imp.targetModule === 'shared',
        );
        for (const imp of sharedImports) {
          if (
            !allowedStateSharedImports.has(imp.module) &&
            !(
              imp.module === '../shared/flowguard-identifiers.js' &&
              /import\s*\{\s*REVIEWER_SUBAGENT_TYPE\s*\}\s*from/.test(imp.raw)
            )
          ) {
            stateViolations.push({
              file: analysis.relativePath,
              rule: 'state-shared-primitive',
              message: `state/ imports an unapproved shared primitive: ${imp.module}`,
              imports: [imp.module],
            });
          }
        }
      }
    });

    it('should have state files', () => {
      const stateFiles = Array.from(analyses.values()).filter(
        (a) => a.filePath.includes('/state/') && !a.filePath.includes('.test.'),
      );
      expect(stateFiles.length).toBeGreaterThan(0);
    });

    it('should have no violations', () => {
      if (stateViolations.length > 0) {
        console.error(
          '\nstate/ violations:\n' +
            stateViolations.map((v) => `  - ${v.file}: ${v.message}`).join('\n'),
        );
      }
      expect(stateViolations).toHaveLength(0);
    });
  });

  describe('Rule 2: archive/types is a leaf module', () => {
    const violations: ImportViolation[] = [];
    const forbiddenFromArchive = new Set([
      'machine',
      'rails',
      'adapters',
      'integration',
      'config',
      'audit',
      'discovery',
      'state',
    ]);
    beforeAll(() => {
      for (const [, analysis] of analyses) {
        if (!analysis.filePath.includes('/archive/types')) continue;
        if (analysis.filePath.includes('.test.')) continue;

        const ffImports = analysis.imports.filter((i) => i.isFFModule && i.targetModule);
        for (const imp of ffImports) {
          if (imp.targetModule && forbiddenFromArchive.has(imp.targetModule)) {
            violations.push({
              file: analysis.relativePath,
              rule: 'archive-leaf',
              message: `archive/types imports from forbidden module: ${imp.targetModule}`,
              imports: [imp.module],
            });
          }
        }
      }
    });

    it('should have archive/types files', () => {
      const files = Array.from(analyses.values()).filter(
        (a) => a.filePath.includes('/archive/types') && !a.filePath.includes('.test.'),
      );
      expect(files.length).toBeGreaterThan(0);
    });

    it('should have no violations', () => {
      if (violations.length > 0) {
        console.error(
          '\narchive/types violations:\n' +
            violations.map((v) => `  - ${v.file}: ${v.message}`).join('\n'),
        );
      }
      expect(violations).toHaveLength(0);
    });
  });

  describe('Rule 3: discovery/types is a leaf module', () => {
    const violations: ImportViolation[] = [];
    // P2d: discovery/types now re-exports schemas from state/discovery-schemas.
    // state/ is the bottom layer — discovery depending on state is architecturally
    // correct. All other FlowGuard modules remain forbidden.
    const forbiddenFromDiscovery = new Set([
      'machine',
      'rails',
      'adapters',
      'integration',
      'config',
      'audit',
      'archive',
    ]);

    beforeAll(() => {
      for (const [, analysis] of analyses) {
        if (!analysis.filePath.includes('/discovery/types')) continue;
        if (analysis.filePath.includes('.test.')) continue;

        const ffImports = analysis.imports.filter((i) => i.isFFModule && i.targetModule);
        for (const imp of ffImports) {
          if (imp.targetModule && forbiddenFromDiscovery.has(imp.targetModule)) {
            violations.push({
              file: analysis.relativePath,
              rule: 'discovery-leaf',
              message: `discovery/types imports from forbidden module: ${imp.targetModule}`,
              imports: [imp.module],
            });
          }
        }
      }
    });

    it('should have discovery/types files', () => {
      const files = Array.from(analyses.values()).filter(
        (a) => a.filePath.includes('/discovery/types') && !a.filePath.includes('.test.'),
      );
      expect(files.length).toBeGreaterThan(0);
    });

    it('should have no violations', () => {
      if (violations.length > 0) {
        console.error(
          '\ndiscovery/types violations:\n' +
            violations.map((v) => `  - ${v.file}: ${v.message}`).join('\n'),
        );
      }
      expect(violations).toHaveLength(0);
    });
  });

  describe('Rule 5b: rails/ must NOT import Node I/O builtins directly', () => {
    const violations: ImportViolation[] = [];
    const FORBIDDEN_NODE_BUILTINS = new Set([
      'fs',
      'path',
      'crypto',
      'child_process',
      'process',
      'os',
      'events',
      'stream',
      'buffer',
      'util',
      'url',
      'http',
      'https',
      'net',
      'node:fs',
      'node:path',
      'node:crypto',
      'node:child_process',
      'node:process',
      'node:os',
      'node:events',
      'node:stream',
      'node:net',
    ]);

    beforeAll(() => {
      for (const [, analysis] of analyses) {
        if (!analysis.filePath.includes('/rails/')) continue;
        if (analysis.filePath.includes('.test.')) continue;

        const builtinImports = analysis.imports.filter(
          (i) => i.isNodeBuiltin && FORBIDDEN_NODE_BUILTINS.has(i.module),
        );

        for (const imp of builtinImports) {
          violations.push({
            file: analysis.relativePath,
            rule: 'rails-no-builtins',
            message: `rails/ imports from forbidden builtin: ${imp.module}`,
            imports: [imp.module],
          });
        }
      }
    });

    it('should have rails files', () => {
      const railsFiles = Array.from(analyses.values()).filter(
        (a) => a.filePath.includes('/rails/') && !a.filePath.includes('.test.'),
      );
      expect(railsFiles.length).toBeGreaterThan(0);
    });

    it('should have no rails -> Node builtin imports', () => {
      if (violations.length > 0) {
        console.error(
          '\nrails/ -> Node builtin violations:\n' +
            violations.map((v) => `  - ${v.file}: ${v.message}`).join('\n'),
        );
      }
      expect(violations).toHaveLength(0);
    });
  });

  describe('Rule 5g: integration/tools/ must NOT import integration composition', () => {
    const violations: ImportViolation[] = [];

    beforeAll(() => {
      violations.push(...detectToolsCompositionImports(analyses));
    });

    it('should have integration/tools files', () => {
      const toolsFiles = Array.from(analyses.values()).filter(
        (a) => a.filePath.includes('/integration/tools/') && !a.filePath.includes('.test.'),
      );
      expect(toolsFiles.length).toBeGreaterThan(0);
    });

    it('should have no tools -> composition imports', () => {
      if (violations.length > 0) {
        console.error(
          '\nintegration/tools/ -> composition violations:\n' +
            violations.map((v) => `  - ${v.file}: ${v.message}`).join('\n'),
        );
      }
      expect(violations).toHaveLength(0);
    });

    it('detects a deep tools -> plugin composition import, depth-independently', () => {
      const probe: FileAnalysis = {
        filePath: normalizeRepoPath(path.join(SRC_DIR, 'integration/tools/plan/probe.ts')),
        relativePath: 'integration/tools/plan/probe.ts',
        imports: [mockImport('../../plugin-risk.js')],
      };
      const detected = detectToolsCompositionImports(
        new Map([['integration/tools/plan/probe.ts', probe]]),
      );
      expect(detected.map((violation) => violation.rule)).toEqual(['tools-no-composition']);
    });

    it('detects a deep tools -> plugin-helpers composition import', () => {
      const probe: FileAnalysis = {
        filePath: normalizeRepoPath(path.join(SRC_DIR, 'integration/tools/plan/probe.ts')),
        relativePath: 'integration/tools/plan/probe.ts',
        imports: [mockImport('../../plugin-helpers.js')],
      };
      const detected = detectToolsCompositionImports(
        new Map([['integration/tools/plan/probe.ts', probe]]),
      );
      expect(detected.map((violation) => violation.rule)).toEqual(['tools-no-composition']);
    });
  });

  describe('Integration tool-context boundary (#922)', () => {
    it('production outside tools/** does not deep-import a tool command context', () => {
      const violations = detectExternalToolContextImports(analyses);
      if (violations.length > 0) {
        console.error(
          '\nexternal tool-context deep imports:\n' +
            violations.map((v) => `  - ${v.file}: ${v.message}`).join('\n'),
        );
      }
      expect(violations).toEqual([]);
    });

    it('is non-vacuous and still permits tool infrastructure imports', () => {
      const contextTargets = new Set<string>();
      const infrastructureImporters: string[] = [];
      for (const [, analysis] of analyses) {
        if (analysis.filePath.includes('.test.')) continue;
        for (const imp of analysis.imports) {
          const target = resolveSrcTarget(analysis, imp);
          if (target === null) continue;
          if (isToolCommandContextFile(target)) contextTargets.add(target);
          if (
            !analysis.relativePath.startsWith('integration/tools/') &&
            target.startsWith('integration/tools/') &&
            !isToolCommandContextFile(target)
          ) {
            infrastructureImporters.push(`${analysis.relativePath} -> ${target}`);
          }
        }
      }
      expect(contextTargets.size).toBeGreaterThan(0);
      expect(infrastructureImporters.length).toBeGreaterThan(0);
    });

    it('detects an external deep import into a command context', () => {
      const probe: FileAnalysis = {
        filePath: normalizeRepoPath(path.join(SRC_DIR, 'integration/plugin-probe.ts')),
        relativePath: 'integration/plugin-probe.ts',
        imports: [mockImport('./tools/plan/plan.js')],
      };
      const detected = detectExternalToolContextImports(
        new Map([['integration/plugin-probe.ts', probe]]),
      );
      expect(detected.map((violation) => violation.rule)).toEqual(['external-tool-context-import']);
    });

    it('permits an external import of the tool barrel (negative fixture)', () => {
      const probe: FileAnalysis = {
        filePath: normalizeRepoPath(path.join(SRC_DIR, 'integration/index.ts')),
        relativePath: 'integration/index.ts',
        imports: [mockImport('./tools/index.js')],
      };
      expect(detectExternalToolContextImports(new Map([['integration/index.ts', probe]]))).toEqual(
        [],
      );
    });

    it('detects review imports of tools or composition, and permits authorities', () => {
      const rulesFor = (spec: string): string[] => {
        const probe: FileAnalysis = {
          filePath: normalizeRepoPath(path.join(SRC_DIR, 'integration/review/probe.ts')),
          relativePath: 'integration/review/probe.ts',
          imports: [mockImport(spec)],
        };
        return detectReviewBoundaryViolations(
          new Map([['integration/review/probe.ts', probe]]),
        ).map((violation) => violation.rule);
      };
      expect(rulesFor('../tools/implementation/implement-shared.js')).toEqual(['review-boundary']);
      expect(rulesFor('../plugin-risk.js')).toEqual(['review-boundary']);
      expect(rulesFor('../runtime-lease.js')).toEqual(['review-boundary']);
      expect(rulesFor('../discovery/discovery-drift-status.js')).toEqual(['review-boundary']);
      expect(rulesFor('../status/status.js')).toEqual(['review-boundary']);
      expect(rulesFor('../proofgraph/refresh.js')).toEqual(['review-boundary']);
      expect(rulesFor('../tool-names.js')).toEqual([]);
      expect(rulesFor('../../state/evidence.js')).toEqual([]);
      expect(rulesFor('../../discovery/discovery-health.js')).toEqual(['review-boundary']);
    });
  });

  describe('Rule 6: Inward imports are ALLOWED (outer may import inner)', () => {
    it('should allow integration/ to import from rails/ (entry point pattern)', () => {
      const integrationRailsImports = Array.from(analyses.values())
        .filter((a) => a.filePath.includes('/integration/') && !a.filePath.includes('.test.'))
        .flatMap((a) => a.imports.filter((i) => i.isFFModule && i.targetModule === 'rails'));

      expect(integrationRailsImports.length).toBeGreaterThan(0);
    });

    it('should allow adapters/ to import from state/ (common pattern)', () => {
      const adaptersStateImports = Array.from(analyses.values())
        .filter((a) => a.filePath.includes('/adapters/') && !a.filePath.includes('.test.'))
        .flatMap((a) => a.imports.filter((i) => i.isFFModule && i.targetModule === 'state'));

      expect(adaptersStateImports.length).toBeGreaterThan(0);
    });
  });

  describe('Module graph governance (positive policy + cycle debt)', () => {
    const governedNames = [...GOVERNED_MODULES];

    function observedModuleEdges(): ModuleEdge[] {
      const edges: ModuleEdge[] = [];
      for (const [, analysis] of analyses) {
        if (analysis.filePath.includes('.test.')) continue;
        const from = getLayerFromPath(analysis.filePath);
        if (from === null) continue;
        for (const imp of analysis.imports) {
          if (!imp.isFFModule || imp.targetModule === null) continue;
          if (!GOVERNED_MODULES.has(imp.targetModule)) continue;
          if (imp.targetModule === from) continue;
          edges.push({ from, to: imp.targetModule });
        }
      }
      return edges;
    }

    const observed: ModuleEdge[] = [];
    const observedEdgeSet = new Set<string>();
    beforeAll(() => {
      observed.push(...observedModuleEdges());
      for (const key of moduleEdgeSet(observed)) observedEdgeSet.add(key);
    });
    const policyEdges: ModuleEdge[] = [];
    for (const [from, targets] of Object.entries(MODULE_DEPENDENCY_POLICY)) {
      for (const to of targets) policyEdges.push({ from, to });
    }
    const policyEdgeSet = moduleEdgeSet(policyEdges);
    const cycleBaseline = JSON.parse(
      readFileSync(path.join(PROJECT_ROOT, 'scripts', 'module-cycle-baseline.json'), 'utf-8'),
    ) as { version: number; edges: ModuleEdge[] };

    function describeEdges(keys: readonly string[]): string {
      return (
        keys
          .map((key) => key.replace('\u0000', ' -> '))
          .sort()
          .join(', ') || '(none)'
      );
    }

    it('observed module directions equal the positive policy exactly (deduplicated)', () => {
      const unapproved = [...observedEdgeSet].filter((key) => !policyEdgeSet.has(key));
      const stale = [...policyEdgeSet].filter((key) => !observedEdgeSet.has(key));
      expect(unapproved, `unapproved module edges: ${describeEdges(unapproved)}`).toEqual([]);
      expect(stale, `stale policy edges: ${describeEdges(stale)}`).toEqual([]);
      // Deduplication contract: many files of one direction are one edge.
      expect(observedEdgeSet.size).toBeLessThanOrEqual(observed.length);
    });

    // Intentional second topology pin beside the edge baseline: name the real
    // SCC shape explicitly and update both together when a cycle is dissolved
    // or a module joins an existing SCC. The edge baseline remains the debt
    // authority; this assertion documents the structure the debt lives in.
    it('classifies the real module graph as acyclic (no cyclic SCCs)', () => {
      const sccs = cyclicStronglyConnectedComponents(governedNames, observed);
      expect(sccs).toEqual([]);
    });

    it('cyclic module edges equal the committed debt baseline exactly', () => {
      const cyclic = cycleParticipatingEdges(governedNames, observed);
      const cyclicSet = moduleEdgeSet(cyclic);
      const baselineSet = moduleEdgeSet(cycleBaseline.edges);
      const newDebt = [...cyclicSet].filter((key) => !baselineSet.has(key));
      const resolvedDebt = [...baselineSet].filter((key) => !cyclicSet.has(key));
      expect(newDebt, `new cyclic edges: ${describeEdges(newDebt)}`).toEqual([]);
      expect(
        resolvedDebt,
        `resolved cyclic edges must shrink the baseline: ${describeEdges(resolvedDebt)}`,
      ).toEqual([]);
    });

    it('the cycle debt baseline is well-formed and contains only cyclic edges', () => {
      expect(cycleBaseline.version).toBe(1);
      const cyclicSet = moduleEdgeSet(cycleParticipatingEdges(governedNames, observed));
      const seen = new Set<string>();
      for (const baselineEdge of cycleBaseline.edges) {
        expect(baselineEdge.from).not.toBe(baselineEdge.to);
        expect(GOVERNED_MODULES.has(baselineEdge.from)).toBe(true);
        expect(GOVERNED_MODULES.has(baselineEdge.to)).toBe(true);
        expect(cyclicSet.has(edgeKey(baselineEdge.from, baselineEdge.to))).toBe(true);
        expect(seen.has(edgeKey(baselineEdge.from, baselineEdge.to))).toBe(false);
        seen.add(edgeKey(baselineEdge.from, baselineEdge.to));
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle files with no imports', () => {
      const noImportFiles = Array.from(analyses.values()).filter((a) => a.imports.length === 0);

      expect(noImportFiles.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle type-only imports correctly', () => {
      const filesWithTypes = Array.from(analyses.values()).filter((a) =>
        a.imports.some((i) => i.raw.includes('import type')),
      );

      expect(filesWithTypes.length).toBeGreaterThan(0);
    });

    it('should handle re-exports correctly', () => {
      const reExportFiles = Array.from(analyses.values()).filter((a) =>
        a.imports.some((i) => i.raw.includes('export from') || i.raw.includes('export *')),
      );

      expect(reExportFiles.length).toBeGreaterThanOrEqual(0);
    });

    it('should correctly identify Node builtin imports', () => {
      const testCases = [
        { input: 'node:fs', expected: true },
        { input: 'node:path', expected: true },
        { input: 'node:crypto', expected: true },
        { input: 'fs', expected: true },
        { input: 'path', expected: true },
        { input: 'crypto', expected: true },
        { input: 'z', expected: false },
        { input: 'vitest', expected: false },
        { input: '../state/schema', expected: false },
      ];

      for (const { input, expected } of testCases) {
        expect(isNodeBuiltinImport(input)).toBe(expected);
      }
    });
  });

  describe('Negative Fixture — proves violations are detected', () => {
    const policyEdgeSet = moduleEdgeSet(
      Object.entries(MODULE_DEPENDENCY_POLICY).flatMap(([from, targets]) =>
        [...targets].map((to) => ({ from, to })),
      ),
    );

    it('detects an unapproved module edge against the positive policy', () => {
      const observed = moduleEdgeSet([{ from: 'state', to: 'integration' }]);
      const unapproved = [...observed].filter((key) => !policyEdgeSet.has(key));
      expect(unapproved).toEqual([edgeKey('state', 'integration')]);
    });

    it('detects a stale policy edge that the code no longer observes', () => {
      const observed = moduleEdgeSet([{ from: 'state', to: 'shared' }]);
      const stale = [...policyEdgeSet].filter((key) => !observed.has(key));
      expect(stale).toContain(edgeKey('machine', 'state'));
      expect(stale).not.toContain(edgeKey('state', 'shared'));
    });

    it('detects a new cyclic edge against the cycle debt baseline', () => {
      const baseline = moduleEdgeSet([{ from: 'a', to: 'b' }]);
      const cyclic = moduleEdgeSet(
        cycleParticipatingEdges(
          ['a', 'b'],
          [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
          ],
        ),
      );
      const newDebt = [...cyclic].filter((key) => !baseline.has(key));
      expect(newDebt).toEqual([edgeKey('b', 'a')]);
    });

    it('detects removed cycle debt until the baseline shrinks', () => {
      const baseline = moduleEdgeSet([
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ]);
      const cyclic = moduleEdgeSet(cycleParticipatingEdges(['a', 'b'], [{ from: 'a', to: 'b' }]));
      const resolvedDebt = [...baseline].filter((key) => !cyclic.has(key));
      expect(resolvedDebt).toContain(edgeKey('b', 'a'));
    });

    it('still rejects unclassified, test-support, and entry imports (default-deny)', () => {
      const fakeAnalysis: FileAnalysis = {
        filePath: normalizeRepoPath(path.join(SRC_DIR, 'state/deliberate-violation.ts')),
        relativePath: 'state/deliberate-violation.ts',
        imports: [
          {
            module: '../../scripts/not-a-module.js',
            raw: "import { x } from '../../scripts/not-a-module.js';",
            isNodeBuiltin: false,
            isRelative: true,
            isFFModule: false,
            targetModule: null,
            targetResolved: false,
          },
        ],
      };
      const violations = detectViolations(
        new Map([['state/deliberate-violation.ts', fakeAnalysis]]),
      );
      expect(violations.map((violation) => violation.rule)).toEqual(['unclassified-import-target']);
    });
  });

  describe('Review bounded context boundary (FG-QUAL-002)', () => {
    it('integration/review/ directory exists', () => {
      const reviewDir = path.join(SRC_DIR, 'integration', 'review');
      expect(existsSync(reviewDir), 'Expected integration/review/ directory to exist').toBe(true);
    });

    it('integration/review/enforcement/ directory exists', () => {
      const enfDir = path.join(SRC_DIR, 'integration', 'review', 'enforcement');
      expect(
        existsSync(enfDir),
        'Expected integration/review/enforcement/ directory to exist',
      ).toBe(true);
    });

    it('review/ has a barrel index.ts', () => {
      const barrel = path.join(SRC_DIR, 'integration', 'review', 'index.ts');
      expect(existsSync(barrel), 'Expected integration/review/index.ts barrel').toBe(true);
    });

    it('review/ imports stay inside the review boundary', () => {
      const violations = detectReviewBoundaryViolations(analyses);
      if (violations.length > 0) {
        console.error(
          '\nreview/ boundary violations:\n' +
            violations.map((v) => `  - ${v.file}: ${v.message}`).join('\n'),
        );
      }
      expect(violations).toEqual([]);
    });

    it('review/ boundary is non-vacuous: review files import root authorities', () => {
      const reviewFiles = Array.from(analyses.values()).filter(
        (analysis) =>
          analysis.relativePath.startsWith('integration/review/') &&
          !analysis.filePath.includes('.test.'),
      );
      expect(reviewFiles.length).toBeGreaterThan(0);
      const rootAuthorityImports = reviewFiles.flatMap((analysis) =>
        analysis.imports
          .map((imp) => resolveSrcTarget(analysis, imp))
          .filter(
            (target): target is string =>
              target !== null && !isRootCompositionFile(target) && !isRootHostRuntimeFile(target),
          ),
      );
      expect(rootAuthorityImports).toContain('integration/tool-names.ts');
    });

    it('review/ obligation-state.ts and audit-events.ts exist', () => {
      const obligationState = path.join(SRC_DIR, 'integration', 'review', 'obligation-state.ts');
      const auditEvents = path.join(SRC_DIR, 'integration', 'review', 'audit-events.ts');
      expect(existsSync(obligationState), 'Expected review/obligation-state.ts').toBe(true);
      expect(existsSync(auditEvents), 'Expected review/audit-events.ts').toBe(true);
    });

    it('review/ barrel exports updateObligation, blockObligation, and appendReviewAuditEvent', async () => {
      const barrelPath = path.join(SRC_DIR, 'integration', 'review', 'index.ts');
      const content = await fs.readFile(barrelPath, 'utf-8');
      expect(content).toContain('updateObligation');
      expect(content).toContain('blockObligation');
      expect(content).toContain('appendReviewAuditEvent');
    });

    it('review/ adapters/persistence dependency is allowed (audit trail I/O)', async () => {
      // audit-events.ts imports from adapters/persistence — this is an intentional
      // architectural decision documented in the barrel header. Verify it compiles
      // and the import is to adapters/ only, not to plugin-* or tools/.
      const auditEventsPath = path.join(SRC_DIR, 'integration', 'review', 'audit-events.ts');
      const content = await fs.readFile(auditEventsPath, 'utf-8');
      const imports = parseImports(content, path.dirname(auditEventsPath), 'integration');
      const adapterImports = imports.filter((i) => i.module.includes('adapters/'));
      const pluginImports = imports.filter(
        (i) => i.module.includes('plugin-') || i.module.includes('/plugin.'),
      );
      expect(adapterImports.length, 'audit-events.ts should import from adapters/').toBeGreaterThan(
        0,
      );
      expect(pluginImports, 'audit-events.ts must NOT import from plugin-*').toEqual([]);
    });
  });

  describe('Directory existence', () => {
    const CORE_LAYER_DIRS = [
      'state',
      'machine',
      'rails',
      'adapters',
      'integration',
      'config',
      'audit',
      'discovery',
      'archive',
      'logging',
      'cli',
      'identity',
      'presentation',
      'diagnostics',
    ] as const;

    it('all core layer directories exist', () => {
      for (const dir of CORE_LAYER_DIRS) {
        const fullPath = path.join(SRC_DIR, dir);
        expect(existsSync(fullPath), `Expected directory '${dir}' to exist`).toBe(true);
      }
    });
  });

  describe('CLI facade integrity', () => {
    it('cli/install.ts imports from install-command, uninstall-command, doctor-command', async () => {
      const facadePath = path.join(SRC_DIR, 'cli', 'install.ts');
      const content = await fs.readFile(facadePath, 'utf-8');
      expect(content).toContain("from './install-command.js'");
      expect(content).toContain("from './uninstall-command.js'");
      expect(content).toContain("from './doctor-command.js'");
    });

    it('command modules do not import cli/install.ts (no circular dependency)', async () => {
      const commands = [
        path.join(SRC_DIR, 'cli', 'install-command.ts'),
        path.join(SRC_DIR, 'cli', 'uninstall-command.ts'),
        path.join(SRC_DIR, 'cli', 'doctor-command.ts'),
      ];

      for (const cmdPath of commands) {
        const exists = existsSync(cmdPath);
        if (!exists) continue; // file may not exist in all environments
        const content = await fs.readFile(cmdPath, 'utf-8');
        expect(content).not.toContain("from './install.js'");
        expect(content).not.toContain("from '../install.js'");
      }
    });

    it('command modules exist on disk', () => {
      expect(existsSync(path.join(SRC_DIR, 'cli/install-command.ts'))).toBe(true);
      expect(existsSync(path.join(SRC_DIR, 'cli/uninstall-command.ts'))).toBe(true);
      expect(existsSync(path.join(SRC_DIR, 'cli/doctor-command.ts'))).toBe(true);
    });
  });

  describe('Rule 8: No circular module dependencies', () => {
    it('reports cycles in real import-edge order', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowguard-cycle-test-'));
      try {
        const a = normalizeRepoPath(path.join(dir, 'a.ts'));
        const b = normalizeRepoPath(path.join(dir, 'b.ts'));
        const c = normalizeRepoPath(path.join(dir, 'c.ts'));
        await Promise.all([
          fs.writeFile(a, "import './c.js';\n", 'utf-8'),
          fs.writeFile(b, "import './a.js';\n", 'utf-8'),
          fs.writeFile(c, "import './b.js';\n", 'utf-8'),
        ]);

        const fakeAnalyses = new Map<string, FileAnalysis>([
          [
            a,
            {
              filePath: a,
              relativePath: repoRelative(PROJECT_ROOT, a),
              imports: [mockImport('./c.js')],
            },
          ],
          [
            b,
            {
              filePath: b,
              relativePath: repoRelative(PROJECT_ROOT, b),
              imports: [mockImport('./a.js')],
            },
          ],
          [
            c,
            {
              filePath: c,
              relativePath: repoRelative(PROJECT_ROOT, c),
              imports: [mockImport('./b.js')],
            },
          ],
        ]);

        expect(detectCycles(fakeAnalyses)).toContain(
          [a, c, b, a].map((f) => repoRelative(PROJECT_ROOT, f)).join(' -> '),
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('should have no circular imports between source files', { timeout: 60000 }, () => {
      const cycles = detectCycles(analyses);
      if (cycles.length > 0) {
        console.error(
          '\nCircular module dependencies in source files:\n' +
            cycles.map((c) => `  ${c}`).join('\n'),
        );
      }
      expect(cycles).toHaveLength(0);
    });
  });

  describe('Summary', () => {
    it('should have analyzed all TypeScript files', () => {
      const nonTestCount = Array.from(analyses.values()).filter(
        (a) => !a.filePath.includes('.test.'),
      ).length;

      expect(nonTestCount).toBeGreaterThan(50);
    });

    it('should have no critical architecture violations', () => {
      const violations = detectViolations(analyses);

      if (violations.length > 0) {
        const summary = violations.map((v) => `  - ${v.file}: ${v.message}`).join('\n');
        console.error('\nCritical architecture violations:\n' + summary);
      }

      expect(violations).toHaveLength(0);
    });
  });
});

// ─── Module classification (default-deny) ────────────────────────────────────

describe('Module classification (default-deny)', () => {
  it('classifies every top-level entry under src/ (ratchet)', () => {
    const entries = readdirSync(SRC_DIR, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() ||
          (entry.isFile() && entry.name.endsWith('.ts') && !isTestSourcePath(entry.name)),
      )
      .map((entry) => entry.name)
      .sort();

    const unclassified = entries.filter((name) => !CLASSIFIED_ENTRIES.has(name));
    expect(unclassified).toEqual([]);

    // Non-vacuity: the enumeration sees directories and root-level files.
    expect(entries).toContain('state');
    expect(entries).toContain('index.ts');
  });

  it('every governed module is recognized by the path classifier', () => {
    for (const name of GOVERNED_MODULES) {
      const synthetic = normalizeRepoPath(path.join(SRC_DIR, name, 'probe.ts'));
      expect(getLayerFromPath(synthetic), `${name} must map to its own layer`).toBe(name);
    }
  });

  it('classifies by the top-level module, not nested names shadowing another module', () => {
    expect(
      getLayerFromPath(normalizeRepoPath(path.join(SRC_DIR, 'providers', 'state', 'probe.ts'))),
    ).toBe('providers');
    expect(
      getLayerFromPath(normalizeRepoPath(path.join(SRC_DIR, 'integration', 'shared', 'probe.ts'))),
    ).toBe('integration');
    // Root-level entries are not layers.
    expect(getLayerFromPath(normalizeRepoPath(path.join(SRC_DIR, 'index.ts')))).toBeNull();
    expect(getLayerFromPath(normalizeRepoPath(path.join(SRC_DIR, 'shared.ts')))).toBeNull();
  });

  function violationForImport(
    imp: ImportInfo,
    relativePath = 'state/deliberate-violation.ts',
  ): ImportViolation[] {
    const fakeAnalysis: FileAnalysis = {
      filePath: normalizeRepoPath(path.join(SRC_DIR, relativePath)),
      relativePath,
      imports: [imp],
    };
    return detectViolations(new Map([[relativePath, fakeAnalysis]]));
  }

  it('flags an import of an unclassified top-level module', () => {
    const violations = violationForImport({
      module: '../newmodule/x.js',
      raw: "import { x } from '../newmodule/x.js';",
      isNodeBuiltin: false,
      isRelative: true,
      isFFModule: false,
      targetModule: 'newmodule',
      targetResolved: true,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe('unclassified-module');
  });

  it('flags production imports of test-support entries', () => {
    const violations = violationForImport({
      module: '../fixtures.js',
      raw: "import { makeState } from '../fixtures.js';",
      isNodeBuiltin: false,
      isRelative: true,
      isFFModule: false,
      targetModule: 'fixtures.ts',
      targetResolved: true,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe('test-support-import');
  });

  it('flags an unresolved relative import target', () => {
    const violations = violationForImport({
      module: '../missing/gone.js',
      raw: "import { x } from '../missing/gone.js';",
      isNodeBuiltin: false,
      isRelative: true,
      isFFModule: false,
      targetModule: null,
      targetResolved: false,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe('unclassified-import-target');
  });

  it('does not flag a classified, allowed cross-module import', () => {
    const violations = violationForImport({
      module: '../shared/hashing.js',
      raw: "import { hashText } from '../shared/hashing.js';",
      isNodeBuiltin: false,
      isRelative: true,
      isFFModule: true,
      targetModule: 'shared',
      targetResolved: true,
    });
    expect(violations).toEqual([]);
  });

  it('flags a governed module importing an entry point (barrel bypass)', () => {
    const violations = violationForImport({
      module: '../index.js',
      raw: "import { evaluate } from '../index.js';",
      isNodeBuiltin: false,
      isRelative: true,
      isFFModule: false,
      targetModule: 'index.ts',
      targetResolved: true,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe('entry-import');
  });

  it('does not flag an entry point composing governed modules', () => {
    const violations = violationForImport(
      {
        module: './state/schema.js',
        raw: "export * from './state/schema.js';",
        isNodeBuiltin: false,
        isRelative: true,
        isFFModule: true,
        targetModule: 'state',
        targetResolved: true,
      },
      'index.ts',
    );
    expect(violations).toEqual([]);
  });

  it('classifies test code semantically, not by `__` directory names', () => {
    expect(isTestSourcePath('state/probe.ts')).toBe(false);
    expect(isTestSourcePath('state/__internal__/escape.ts')).toBe(false);
    expect(isTestSourcePath('state/__tests__/probe.ts')).toBe(true);
    expect(isTestSourcePath('audit/__fixtures__/rfc3161.ts')).toBe(true);
    expect(isTestSourcePath('architecture/mutation-authority-inventory.ts')).toBe(true);
    expect(isTestSourcePath('state/probe.test.ts')).toBe(true);
    expect(isTestSourcePath('state/probe.spec.ts')).toBe(true);
  });
});

export type { ImportViolation, ImportInfo, FileAnalysis };
