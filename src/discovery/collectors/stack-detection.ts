/**
 * @module discovery/collectors/stack-detection
 * @description Collector: technology stack detection — logic functions.
 *
 * Detection rules and constants extracted to stack-detection-rules.ts.
 * Shared utilities (ReadFileFn, safeRead, findItem, etc.) canonical in
 * stack-detection-utils.ts — imported here, no local duplicates (P4c).
 *
 * @version v5
 */

import * as path from 'node:path';
import type { CollectorInput, CollectorOutput, StackInfo, DetectedItem } from '../types.js';

/**
 * Extraction context — bundles all detection results for version extraction.
 */
export interface ExtractionContext {
  readonly readFile: ReadFileFn;
  readonly languages: DetectedItem[];
  readonly frameworks: DetectedItem[];
  readonly runtimes: DetectedItem[];
  readonly testFrameworks: DetectedItem[];
  readonly tools: DetectedItem[];
  readonly qualityTools: DetectedItem[];
  readonly databases: DetectedItem[];
  readonly allFiles: readonly string[];
  readonly buildTools: DetectedItem[];
}

import { collectRootBasenames, findItem, type ReadFileFn } from './stack-detection-utils.js';

import {
  LANGUAGE_EXTENSIONS,
  BUILD_TOOL_RULES,
  ROOT_FIRST_BUILD_TOOLS,
  FRAMEWORK_CONFIG_RULES,
} from './stack-detection-rules.js';
import {
  extractFromPomXml,
  extractFromGradleBuild,
  extractArtifactsFromPomXml,
  extractArtifactsFromGradle,
  extractDatabasesFromDockerCompose,
} from './languages/java.js';
import {
  refineFromPackageManagerField,
  refineBuildToolFromLockfiles,
  extractFromPackageJson,
  extractFromTsConfig,
} from './languages/js-ecosystem.js';
import { extractFromNodeVersionFiles } from './languages/node.js';
import { extractFromGoMod } from './languages/go.js';
import { extractFromPythonRootFiles } from './languages/python.js';
import { extractFromRustRootFiles } from './languages/rust.js';

/**
 * Refine the npm build tool from the `packageManager` field in package.json.
 *
 * This is the highest-priority signal for package manager identity and version.
 * The `packageManager` field is a Corepack standard that explicitly declares
 * both the manager and its pinned version.
 *
 * Priority: packageManager field > root lockfile > default npm.
 *
 * Returns true if the field was found and applied (so lockfile refinement
 * can be skipped), false otherwise.
 *
 * Mutates buildTools in place.
 */

// ─── Lockfile Detection ───────────────────────────────────────────────────────

/**
 * Lockfile-based package manager detection rules.
 *
 * Maps lockfile basenames to package manager IDs. When a lockfile is found in
 * allFiles, the corresponding package manager REPLACES the default 'npm' build
 * tool (since package.json → npm is the initial detection, but the lockfile is
 * the authoritative signal for the actual package manager).
 *
 * package-lock.json confirms npm — no replacement needed.
 */

/**
 * Refine the npm build tool to the actual package manager based on root-level lockfiles.
 *
 * Only considers root-level files using shared repo-path normalization helpers
 * to avoid false positives from nested lockfiles in monorepo subdirectories
 * (e.g. packages/app/pnpm-lock.yaml).
 *
 * Scans allFiles for known lockfile basenames at root level. If a non-npm lockfile
 * is found, replaces the 'npm' build tool with the actual package manager.
 * If package-lock.json is found (or no lockfile at all), npm stays.
 *
 * Mutates buildTools in place. Only acts when 'npm' is already in buildTools
 * (i.e., package.json was detected).
 */

/**
 * Enforce root-first authority for selected build tools.
 *
 * `listRepoSignals()` currently reports package files by basename, which can include
 * nested manifests. For Python/Rust/Go ecosystem facts we require explicit root-level
 * evidence and remove unsupported tool detections.
 */
function enforceRootFirstBuildTools(
  buildTools: DetectedItem[],
  rootFiles: ReadonlySet<string>,
): void {
  const hasRootEvidence = (rule: { evidence: readonly string[] }): boolean =>
    rule.evidence.some((file) => rootFiles.has(file));

  for (const rule of ROOT_FIRST_BUILD_TOOLS) {
    const index = buildTools.findIndex((item) => item.id === rule.id);
    if (index === -1) continue;
    if (hasRootEvidence(rule)) continue;
    buildTools.splice(index, 1);
  }
}

/** Add root-level build tools derived from lock/manifests not covered by packageFiles. */
export function addRootFirstBuildTools(
  buildTools: DetectedItem[],
  rootFiles: ReadonlySet<string>,
): void {
  if (rootFiles.has('uv.lock') && !findItem(buildTools, 'uv')) {
    buildTools.push({
      id: 'uv',
      confidence: 0.9,
      classification: 'fact',
      evidence: ['uv.lock'],
    });
  }

  if (rootFiles.has('poetry.lock') && !findItem(buildTools, 'poetry')) {
    buildTools.push({
      id: 'poetry',
      confidence: 0.9,
      classification: 'fact',
      evidence: ['poetry.lock'],
    });
  }
}

/** Return the first root-level file that exists from a list of candidates, or null. */
export function firstRootEvidence(
  rootFiles: ReadonlySet<string>,
  candidates: readonly string[],
): string | null {
  for (const file of candidates) {
    if (rootFiles.has(file)) return file;
  }
  return null;
}

/** Ensure root-level manifest facts for Python/Rust/Go languages and quality tools. */
export function addRootFirstLanguageAndLintFacts(
  rootFiles: ReadonlySet<string>,
  languages: DetectedItem[],
  qualityTools: DetectedItem[],
): void {
  const PYTHON_EVIDENCE_FILES: readonly string[] = [
    'pyproject.toml',
    '.python-version',
    'requirements.txt',
    'requirements-dev.txt',
    'uv.lock',
    'poetry.lock',
  ];
  const pythonEvidence = firstRootEvidence(rootFiles, PYTHON_EVIDENCE_FILES);
  if (pythonEvidence && !findItem(languages, 'python')) {
    languages.push({
      id: 'python',
      confidence: 0.85,
      classification: 'derived_signal',
      evidence: [pythonEvidence],
    });
  }

  const RUST_EVIDENCE_FILES: readonly string[] = [
    'Cargo.toml',
    'rust-toolchain.toml',
    'rust-toolchain',
  ];
  const rustEvidence = firstRootEvidence(rootFiles, RUST_EVIDENCE_FILES);
  if (rustEvidence && !findItem(languages, 'rust')) {
    languages.push({
      id: 'rust',
      confidence: 0.85,
      classification: 'derived_signal',
      evidence: [rustEvidence],
    });
  }

  if (rootFiles.has('go.mod') && !findItem(languages, 'go')) {
    languages.push({
      id: 'go',
      confidence: 0.85,
      classification: 'derived_signal',
      evidence: ['go.mod'],
    });
  }

  if (rootFiles.has('.golangci.yml') && !findItem(qualityTools, 'golangci-lint')) {
    qualityTools.push({
      id: 'golangci-lint',
      confidence: 0.85,
      classification: 'derived_signal',
      evidence: ['.golangci.yml'],
    });
  }

  if (rootFiles.has('.golangci.yaml') && !findItem(qualityTools, 'golangci-lint')) {
    qualityTools.push({
      id: 'golangci-lint',
      confidence: 0.85,
      classification: 'derived_signal',
      evidence: ['.golangci.yaml'],
    });
  }
}

// ─── Collector ────────────────────────────────────────────────────────────────

/**
 * Collect technology stack information.
 *
 * Scans file list, package files, and config files to detect:
 * - Languages (by file extension frequency)
 * - Build tools (by package manifest presence, refined by lockfiles)
 * - Frameworks (by config file presence + package.json dependencies)
 * - Test frameworks (by config file presence + package.json devDependencies)
 * - Quality tools (by config file presence + package.json devDependencies)
 * - Runtimes (by config file presence)
 *
 * Lockfile detection (pnpm-lock.yaml, yarn.lock, bun.lockb) refines the
 * default npm build tool to the actual package manager. The `packageManager`
 * field in package.json (Corepack standard) takes highest priority and
 * includes the pinned version; when present, lockfile refinement is skipped.
 * Only root-level lockfiles are considered (nested lockfiles are ignored).
 *
 * When `input.readFile` is provided, also extracts version information
 * from manifest file contents. Version extraction is fail-soft: unreadable
 * or unparseable files result in `version: undefined`, never errors.
 */
export async function collectStack(input: CollectorInput): Promise<CollectorOutput<StackInfo>> {
  try {
    const languages = detectLanguages(input.allFiles);
    const buildTools = detectBuildTools(input.packageFiles);
    const { frameworks, testFrameworks, runtimes, qualityTools } = detectFromConfigs(
      input.configFiles,
    );
    const tools: DetectedItem[] = [];
    const databases: DetectedItem[] = [];

    // Package manager refinement (highest to lowest priority):
    // 1. packageManager field from package.json (Corepack standard, with version)
    // 2. Root-level lockfile detection (pnpm-lock.yaml, yarn.lock, bun.lockb)
    // If packageManager field is found, lockfile refinement is skipped.
    let pmRefined = false;
    if (input.readFile) {
      pmRefined = await refineFromPackageManagerField(input.readFile, buildTools);
    }
    if (!pmRefined) {
      refineBuildToolFromLockfiles(input.allFiles, buildTools);
    }

    // Root-first manifest authority for Python/Rust/Go ecosystem facts.
    const rootFiles = collectRootBasenames(input.allFiles);
    enforceRootFirstBuildTools(buildTools, rootFiles);
    addRootFirstBuildTools(buildTools, rootFiles);
    addRootFirstLanguageAndLintFacts(rootFiles, languages, qualityTools);

    // Version extraction post-pass (requires readFile capability)
    if (input.readFile) {
      await extractVersions({
        readFile: input.readFile,
        languages,
        frameworks,
        runtimes,
        testFrameworks,
        tools,
        qualityTools,
        databases,
        allFiles: input.allFiles,
        buildTools,
      });
    }

    return {
      status: 'complete',
      data: {
        languages,
        frameworks,
        buildTools,
        testFrameworks,
        runtimes,
        tools,
        qualityTools,
        databases,
      },
    };
  } catch {
    return {
      status: 'failed',
      data: {
        languages: [],
        frameworks: [],
        buildTools: [],
        testFrameworks: [],
        runtimes: [],
        tools: [],
        qualityTools: [],
        databases: [],
      },
    };
  }
}

// ─── Internal Detection Functions ─────────────────────────────────────────────

/**
 * Detect languages by counting file extensions.
 * Confidence is proportional to the fraction of files with that extension.
 * Minimum 1 file to be detected.
 */
function detectLanguages(allFiles: readonly string[]): DetectedItem[] {
  if (allFiles.length === 0) return [];

  // Count files per language
  const counts = new Map<string, number>();
  const evidenceMap = new Map<string, string[]>();

  for (const filePath of allFiles) {
    const ext = path.extname(filePath).toLowerCase();
    if (!ext) continue;

    for (const rule of LANGUAGE_EXTENSIONS) {
      if (rule.extensions.has(ext)) {
        counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
        const ev = evidenceMap.get(rule.id) ?? [];
        // Keep max 3 evidence paths per language
        if (ev.length < 3) ev.push(filePath);
        evidenceMap.set(rule.id, ev);
      }
    }
  }

  // Convert to DetectedItems with confidence based on relative count
  const total = allFiles.length;
  const items: DetectedItem[] = [];

  for (const [id, count] of counts) {
    // Confidence: min 0.3 for any presence, scaled up to 0.95 for dominant language
    const ratio = count / total;
    const confidence = Math.min(0.95, 0.3 + ratio * 0.65);

    items.push({
      id,
      confidence: Math.round(confidence * 100) / 100,
      classification: 'fact',
      evidence: evidenceMap.get(id) ?? [],
    });
  }

  // Sort by confidence descending
  return items.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Detect build tools by presence of package manifest files.
 * Confidence is 0.9 (high — file presence is strong signal).
 */
function detectBuildTools(packageFiles: readonly string[]): DetectedItem[] {
  const packageSet = new Set(packageFiles);
  const items: DetectedItem[] = [];

  for (const rule of BUILD_TOOL_RULES) {
    if (packageSet.has(rule.packageFile)) {
      items.push({
        id: rule.id,
        confidence: 0.9,
        classification: 'fact',
        evidence: [rule.packageFile],
      });
    }
  }

  return items;
}

/**
 * Detect frameworks, test frameworks, runtimes, and quality tools from config files.
 * Confidence is 0.85 (config file presence is a strong signal).
 */
function detectFromConfigs(configFiles: readonly string[]): {
  frameworks: DetectedItem[];
  testFrameworks: DetectedItem[];
  runtimes: DetectedItem[];
  qualityTools: DetectedItem[];
} {
  const configSet = new Set(configFiles);
  const frameworks: DetectedItem[] = [];
  const testFrameworks: DetectedItem[] = [];
  const runtimes: DetectedItem[] = [];
  const qualityTools: DetectedItem[] = [];

  for (const rule of FRAMEWORK_CONFIG_RULES) {
    const matchedConfigs = rule.configFiles.filter((f) => configSet.has(f));
    if (matchedConfigs.length === 0) continue;

    const item: DetectedItem = {
      id: rule.id,
      confidence: 0.85,
      classification: 'fact',
      evidence: matchedConfigs,
    };

    switch (rule.category) {
      case 'framework':
        frameworks.push(item);
        break;
      case 'testFramework':
        testFrameworks.push(item);
        break;
      case 'runtime':
        runtimes.push(item);
        break;
      case 'qualityTool':
        qualityTools.push(item);
        break;
    }
  }

  return { frameworks, testFrameworks, runtimes, qualityTools };
}

// ─── Version Extraction ───────────────────────────────────────────────────────

/** Set compilerTarget + compilerTargetEvidence on a DetectedItem. */

/**
 * Extract version information from manifest file contents.
 *
 * Conservative extraction: only matches obvious, well-known declaration patterns.
 * No full XML/TOML/Gradle DSL parsing — regex only.
 * Every file read is fail-soft: missing or malformed files are silently skipped.
 *
 * Mutates items in place by adding version and versionEvidence fields.
 *
 * Execution order is fully sequential for deterministic first-write-wins priority:
 * 1. .nvmrc / .node-version (highest Node version authority)
 * 2. package.json (engines.node, TS dep version, framework deps)
 * 3. tsconfig.json (TypeScript compilerTarget — no shared targets)
 * 4. pom.xml (Java version, Spring Boot version — Maven authority)
 * 5. pom.xml artifacts (tools, test frameworks, quality tools)
 * 6. build.gradle(.kts) (Java version, Spring Boot version — Gradle fallback)
 * 7. build.gradle(.kts) artifacts (tools, test frameworks, quality tools, databases — Gradle fallback)
 * 8. docker-compose files (database engines + optional image tag version)
 * 9. Python manifests/tooling (python version, pytest, ruff, black, mypy)
 * 10. Cargo.toml / rust-toolchain* (rust edition/version, clippy, rustfmt)
 * 11. go.mod (Go version — no shared targets)
 *
 * Maven runs before Gradle: in projects with both pom.xml and build.gradle,
 * Maven is the canonical build system and Gradle values are ignored via
 * first-write-wins on languages.java.version and frameworks.spring-boot.version.
 * Same applies to artifact detection: pom.xml artifacts are authoritative.
 */
async function extractVersions(ctx: {
  readonly readFile: ReadFileFn;
  readonly languages: DetectedItem[];
  readonly frameworks: DetectedItem[];
  readonly runtimes: DetectedItem[];
  readonly testFrameworks: DetectedItem[];
  readonly tools: DetectedItem[];
  readonly qualityTools: DetectedItem[];
  readonly databases: DetectedItem[];
  readonly allFiles: readonly string[];
  readonly buildTools: DetectedItem[];
}): Promise<void> {
  const {
    readFile,
    languages,
    frameworks,
    runtimes,
    testFrameworks,
    tools,
    qualityTools,
    databases,
    allFiles,
    buildTools,
  } = ctx;
  // Fully sequential: deterministic first-write-wins priority.
  // .nvmrc / .node-version > package.json engines.node
  await extractFromNodeVersionFiles(readFile, runtimes);
  await extractFromPackageJson(
    readFile,
    languages,
    frameworks,
    runtimes,
    testFrameworks,
    qualityTools,
    databases,
  );
  await extractFromTsConfig(readFile, languages);
  // Maven before Gradle: shared write targets (languages.java, frameworks.spring-boot)
  await extractFromPomXml(readFile, languages, frameworks);
  await extractArtifactsFromPomXml(readFile, testFrameworks, tools, qualityTools, databases);
  await extractFromGradleBuild(readFile, languages, frameworks);
  await extractArtifactsFromGradle(readFile, testFrameworks, tools, qualityTools, databases);
  await extractDatabasesFromDockerCompose(readFile, allFiles, databases);
  await extractFromPythonRootFiles(
    readFile,
    allFiles,
    languages,
    testFrameworks,
    qualityTools,
    buildTools,
  );
  await extractFromRustRootFiles(readFile, allFiles, languages, qualityTools, buildTools);
  await extractFromGoMod(readFile, languages, allFiles);
}

/**
 * Extract Node.js version from .nvmrc or .node-version files.
 * Format: plain text, single line with version string.
 * Always writes to runtimes.node — never to language items.
 */

/**
 * Extract versions from package.json: engines.node, framework dependencies,
 * devDependencies.typescript, and full JS/TS ecosystem scanning.
 *
 * Scans both `dependencies` and `devDependencies` against JS_ECOSYSTEM_DEPS
 * to detect and version-enrich frameworks, test frameworks, and quality tools.
 * Config-detected items get version enrichment; new items are created.
 */

/**
 * Extract TypeScript compiler target from tsconfig.json compilerOptions.target.
 * Stored as compilerTarget, not version — ES2022 is not a TypeScript version.
 */

/**
 * Extract Java and Spring Boot versions from pom.xml.
 * Conservative regex: only matches `<property>value</property>` patterns.
 */

/** Add or enrich a framework item with version info. */

/** Add or enrich a runtime item with version info. */

/**
 * Extract Java and Spring Boot versions from build.gradle or build.gradle.kts.
 * Conservative: only matches sourceCompatibility, JavaLanguageVersion.of(),
 * and Spring Boot plugin declarations.
 */

/**
 * Extract Go version from go.mod directive.
 * Format: `go 1.22` or `go 1.22.1`.
 */

/** Extract Python ecosystem facts from root-level manifests and requirements files. */

/** Extract Rust ecosystem facts from root-level Cargo/toolchain manifests. */

/** Check if a requirements file declares a package at line start (ignore comments/options). */

// ─── Artifact Detection (pom.xml / build.gradle) ─────────────────────────────

/**
 * Extract tool/testFramework/qualityTool artifacts from pom.xml.
 *
 * Scans <dependency> and <plugin> blocks for known artifact IDs.
 * Version extraction is best-effort: when a <version> tag exists in the
 * same block it is captured; BOM-managed dependencies without explicit
 * versions are still detected (without version).
 */

/**
 * Extract tool/testFramework/qualityTool artifacts from build.gradle(.kts).
 *
 * Scans plugin declarations and dependency configurations for known artifacts.
 * Runs AFTER pom.xml extraction — Maven is authoritative; Gradle values are
 * only added for IDs not already detected (first-write-wins across files).
 */

/**
 * Extract database engines from docker-compose image declarations.
 *
 * Conservative detection:
 * - Scans only docker-compose*.yml/yaml files listed in allFiles
 * - Parses only `image:` lines
 * - Maps known image names to engines
 * - Extracts version only when tag is unambiguous and starts with digits
 */
