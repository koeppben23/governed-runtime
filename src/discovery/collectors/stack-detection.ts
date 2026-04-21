/**
 * @module discovery/collectors/stack-detection
 * @description Collector: technology stack detection.
 *
 * Detects languages, frameworks, build tools, test frameworks, runtimes,
 * ecosystem tools, and quality tools by analyzing file patterns, package
 * manifests, and config files.
 *
 * Detection strategy:
 * - File extensions → languages (fact)
 * - Package files → build tools (fact)
 * - packageManager field in package.json → package manager identity + version (fact, highest priority)
 * - Root-level lockfiles → package manager refinement: npm/pnpm/yarn/bun (fact, skipped when packageManager found)
 * - Config files → frameworks, test frameworks, quality tools (fact or derived_signal)
 * - package.json deps/devDeps → JS/TS ecosystem detection with versions (derived_signal)
 * - Manifest content → version extraction (fact, requires readFile on input)
 * - pom.xml artifacts → tools, test frameworks, quality tools (derived_signal)
 * - build.gradle(.kts) artifacts → tools, test frameworks, quality tools (derived_signal)
 *
 * Each detected item carries confidence, classification, and evidence.
 * Version extraction is optional: when readFile is absent, items have no version.
 *
 * @version v3
 */

import * as path from 'node:path';
import type { CollectorInput, CollectorOutput, StackInfo, DetectedItem } from '../types';

// ─── Detection Rules ──────────────────────────────────────────────────────────

/** Extension-based language detection. */
const LANGUAGE_EXTENSIONS: ReadonlyArray<{
  id: string;
  extensions: ReadonlySet<string>;
}> = [
  { id: 'typescript', extensions: new Set(['.ts', '.tsx', '.mts', '.cts']) },
  { id: 'javascript', extensions: new Set(['.js', '.jsx', '.mjs', '.cjs']) },
  { id: 'java', extensions: new Set(['.java']) },
  { id: 'python', extensions: new Set(['.py', '.pyi']) },
  { id: 'go', extensions: new Set(['.go']) },
  { id: 'rust', extensions: new Set(['.rs']) },
  { id: 'csharp', extensions: new Set(['.cs']) },
  { id: 'ruby', extensions: new Set(['.rb']) },
  { id: 'php', extensions: new Set(['.php']) },
  { id: 'kotlin', extensions: new Set(['.kt', '.kts']) },
  { id: 'swift', extensions: new Set(['.swift']) },
  { id: 'scala', extensions: new Set(['.scala']) },
];

/** Package file → build tool mapping. */
const BUILD_TOOL_RULES: ReadonlyArray<{
  id: string;
  packageFile: string;
}> = [
  { id: 'npm', packageFile: 'package.json' },
  { id: 'maven', packageFile: 'pom.xml' },
  { id: 'gradle', packageFile: 'build.gradle' },
  { id: 'gradle-kotlin', packageFile: 'build.gradle.kts' },
  { id: 'cargo', packageFile: 'Cargo.toml' },
  { id: 'go-modules', packageFile: 'go.mod' },
  { id: 'pip', packageFile: 'requirements.txt' },
  { id: 'poetry', packageFile: 'pyproject.toml' },
  { id: 'setuptools', packageFile: 'setup.py' },
  { id: 'bundler', packageFile: 'Gemfile' },
  { id: 'composer', packageFile: 'composer.json' },
];

// ─── Artifact Detection Rules ─────────────────────────────────────────────────

/** Artifact category for tool/quality/test detection. */
type ArtifactCategory = 'tool' | 'testFramework' | 'qualityTool';

/**
 * pom.xml artifact detection rules.
 *
 * Scans <dependency> and <plugin> blocks for known artifactIds.
 * Ordered by priority within each category. First match per id wins.
 */
const POM_ARTIFACT_RULES: ReadonlyArray<{
  artifactId: string;
  id: string;
  category: ArtifactCategory;
  evidenceType: 'dependency' | 'plugin';
}> = [
  // Tools (P9 priority 1 & 3)
  {
    artifactId: 'openapi-generator-maven-plugin',
    id: 'openapi-generator',
    category: 'tool',
    evidenceType: 'plugin',
  },
  { artifactId: 'flyway-maven-plugin', id: 'flyway', category: 'tool', evidenceType: 'plugin' },
  { artifactId: 'flyway-core', id: 'flyway', category: 'tool', evidenceType: 'dependency' },
  { artifactId: 'liquibase-core', id: 'liquibase', category: 'tool', evidenceType: 'dependency' },
  // Test frameworks (P9 priority 2)
  {
    artifactId: 'junit-jupiter',
    id: 'junit',
    category: 'testFramework',
    evidenceType: 'dependency',
  },
  {
    artifactId: 'junit-jupiter-api',
    id: 'junit',
    category: 'testFramework',
    evidenceType: 'dependency',
  },
  {
    artifactId: 'cucumber-java',
    id: 'cucumber',
    category: 'testFramework',
    evidenceType: 'dependency',
  },
  {
    artifactId: 'testcontainers',
    id: 'testcontainers',
    category: 'testFramework',
    evidenceType: 'dependency',
  },
  // Quality tools (P9 priority 5)
  {
    artifactId: 'spotless-maven-plugin',
    id: 'spotless',
    category: 'qualityTool',
    evidenceType: 'plugin',
  },
  {
    artifactId: 'maven-checkstyle-plugin',
    id: 'checkstyle',
    category: 'qualityTool',
    evidenceType: 'plugin',
  },
  {
    artifactId: 'archunit-junit5',
    id: 'archunit',
    category: 'qualityTool',
    evidenceType: 'dependency',
  },
  { artifactId: 'archunit', id: 'archunit', category: 'qualityTool', evidenceType: 'dependency' },
  {
    artifactId: 'jacoco-maven-plugin',
    id: 'jacoco',
    category: 'qualityTool',
    evidenceType: 'plugin',
  },
];

/**
 * Gradle plugin detection rules.
 *
 * Matches id("plugin.id") version "x.y.z" declarations.
 * For built-in plugins (jacoco, checkstyle), also matches bare names and apply plugin.
 */
const GRADLE_PLUGIN_RULES: ReadonlyArray<{
  pluginId: string;
  id: string;
  category: ArtifactCategory;
  builtin: boolean;
}> = [
  { pluginId: 'org.openapi.generator', id: 'openapi-generator', category: 'tool', builtin: false },
  { pluginId: 'org.flywaydb.flyway', id: 'flyway', category: 'tool', builtin: false },
  { pluginId: 'org.liquibase.gradle', id: 'liquibase', category: 'tool', builtin: false },
  { pluginId: 'com.diffplug.spotless', id: 'spotless', category: 'qualityTool', builtin: false },
  { pluginId: 'checkstyle', id: 'checkstyle', category: 'qualityTool', builtin: true },
  { pluginId: 'jacoco', id: 'jacoco', category: 'qualityTool', builtin: true },
];

/**
 * Gradle dependency detection rules.
 *
 * Matches "group:artifact:version" in dependency configurations.
 * Version part is optional (BOM-managed dependencies).
 */
const GRADLE_DEPENDENCY_RULES: ReadonlyArray<{
  artifact: string;
  id: string;
  category: ArtifactCategory;
}> = [
  { artifact: 'junit-jupiter', id: 'junit', category: 'testFramework' },
  { artifact: 'junit-jupiter-api', id: 'junit', category: 'testFramework' },
  { artifact: 'cucumber-java', id: 'cucumber', category: 'testFramework' },
  { artifact: 'testcontainers', id: 'testcontainers', category: 'testFramework' },
  { artifact: 'flyway-core', id: 'flyway', category: 'tool' },
  { artifact: 'liquibase-core', id: 'liquibase', category: 'tool' },
  { artifact: 'archunit-junit5', id: 'archunit', category: 'qualityTool' },
  { artifact: 'archunit', id: 'archunit', category: 'qualityTool' },
];

/** Config file → framework/tool mapping. */
const FRAMEWORK_CONFIG_RULES: ReadonlyArray<{
  id: string;
  configFiles: readonly string[];
  category: 'framework' | 'testFramework' | 'runtime' | 'qualityTool';
}> = [
  {
    id: 'angular',
    configFiles: ['angular.json'],
    category: 'framework',
  },
  {
    id: 'next',
    configFiles: ['next.config.js', 'next.config.mjs'],
    category: 'framework',
  },
  {
    id: 'nuxt',
    configFiles: ['nuxt.config.ts'],
    category: 'framework',
  },
  {
    id: 'vite',
    configFiles: ['vite.config.ts', 'vite.config.js'],
    category: 'framework',
  },
  {
    id: 'vitest',
    configFiles: ['vitest.config.ts', 'vitest.config.js'],
    category: 'testFramework',
  },
  {
    id: 'jest',
    configFiles: ['jest.config.js', 'jest.config.ts'],
    category: 'testFramework',
  },
  {
    id: 'webpack',
    configFiles: ['webpack.config.js'],
    category: 'framework',
  },
  {
    id: 'rollup',
    configFiles: ['rollup.config.js'],
    category: 'framework',
  },
  {
    id: 'nx',
    configFiles: ['nx.json'],
    category: 'framework',
  },
  {
    id: 'docker',
    configFiles: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'],
    category: 'runtime',
  },
  {
    id: 'tailwind',
    configFiles: ['tailwind.config.js', 'tailwind.config.ts'],
    category: 'framework',
  },
  {
    id: 'eslint',
    configFiles: [
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.json',
      '.eslintrc.yml',
      'eslint.config.js',
      'eslint.config.mjs',
    ],
    category: 'qualityTool',
  },
  {
    id: 'prettier',
    configFiles: ['.prettierrc', '.prettierrc.json'],
    category: 'qualityTool',
  },
];

// ─── JS/TS Ecosystem Detection ────────────────────────────────────────────────

/**
 * Category target for JS/TS ecosystem dependency mapping.
 *
 * Maps npm package names to detected item IDs and their stack categories.
 * Used by extractFromPackageJson() to scan dependencies and devDependencies.
 * Categories MUST match those used by FRAMEWORK_CONFIG_RULES for dedup to work.
 */
type JsEcosystemCategory = 'framework' | 'testFramework' | 'qualityTool';

const JS_ECOSYSTEM_DEPS: ReadonlyArray<{
  pkg: string;
  id: string;
  category: JsEcosystemCategory;
}> = [
  // ── Frameworks (Priority 1) ─────────────────────────────────────────────
  { pkg: 'react', id: 'react', category: 'framework' },
  { pkg: 'vue', id: 'vue', category: 'framework' },
  { pkg: 'next', id: 'next', category: 'framework' },
  { pkg: 'svelte', id: 'svelte', category: 'framework' },
  { pkg: '@sveltejs/kit', id: 'sveltekit', category: 'framework' },
  { pkg: 'astro', id: 'astro', category: 'framework' },
  { pkg: '@remix-run/node', id: 'remix', category: 'framework' },
  { pkg: '@remix-run/react', id: 'remix', category: 'framework' },
  { pkg: '@angular/core', id: 'angular', category: 'framework' },
  { pkg: 'nuxt', id: 'nuxt', category: 'framework' },
  // ── Test Frameworks (Priority 2) ────────────────────────────────────────
  { pkg: 'vitest', id: 'vitest', category: 'testFramework' },
  { pkg: 'jest', id: 'jest', category: 'testFramework' },
  { pkg: '@playwright/test', id: 'playwright', category: 'testFramework' },
  { pkg: 'cypress', id: 'cypress', category: 'testFramework' },
  // ── Quality Tools (Priority 3) ──────────────────────────────────────────
  { pkg: 'eslint', id: 'eslint', category: 'qualityTool' },
  { pkg: 'prettier', id: 'prettier', category: 'qualityTool' },
  { pkg: '@biomejs/biome', id: 'biome', category: 'qualityTool' },
  // ── Build Tools / Frameworks (Priority 4) ───────────────────────────────
  // vite/webpack/tailwind/nx are categorized as 'framework' in FRAMEWORK_CONFIG_RULES.
  // Using the same category here ensures config-detected + pkg-detected dedup works.
  { pkg: 'vite', id: 'vite', category: 'framework' },
  { pkg: 'webpack', id: 'webpack', category: 'framework' },
  { pkg: 'tailwindcss', id: 'tailwind', category: 'framework' },
  { pkg: 'nx', id: 'nx', category: 'framework' },
];

// ─── packageManager Field Detection ───────────────────────────────────────────

/**
 * Regex for the packageManager field in package.json (Corepack standard).
 *
 * Format: `"packageManager": "pnpm@9.12.0"` or `"yarn@4.1.0"` etc.
 * Captures: [1] = manager name (npm|pnpm|yarn|bun), [2] = version digits.
 */
const PACKAGE_MANAGER_RE = /^(npm|pnpm|yarn|bun)@(\d+(?:\.\d+)*)/;

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
async function refineFromPackageManagerField(
  readFile: ReadFileFn,
  buildTools: DetectedItem[],
): Promise<boolean> {
  const npmIndex = buildTools.findIndex((t) => t.id === 'npm');
  if (npmIndex === -1) return false; // No npm build tool to refine

  const content = await safeRead(readFile, 'package.json');
  if (!content) return false;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return false;
  }

  const pmField = pkg.packageManager;
  if (typeof pmField !== 'string') return false;

  const match = pmField.match(PACKAGE_MANAGER_RE);
  if (!match) return false;

  const managerId = match[1]!;
  const version = match[2]!;
  const evidence = 'package.json:packageManager';

  if (managerId === 'npm') {
    // npm is already the default — just add version
    const npmItem = buildTools[npmIndex]!;
    npmItem.version = version;
    npmItem.versionEvidence = evidence;
    if (!npmItem.evidence.includes(evidence)) {
      npmItem.evidence.push(evidence);
    }
  } else {
    // Replace npm with the declared manager
    buildTools[npmIndex] = {
      id: managerId,
      confidence: 0.95,
      classification: 'fact',
      evidence: [evidence],
      version,
      versionEvidence: evidence,
    };
  }

  return true;
}

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
const LOCKFILE_RULES: ReadonlyArray<{
  basename: string;
  id: string;
}> = [
  { basename: 'pnpm-lock.yaml', id: 'pnpm' },
  { basename: 'yarn.lock', id: 'yarn' },
  { basename: 'bun.lockb', id: 'bun' },
  { basename: 'bun.lock', id: 'bun' },
];

/**
 * Refine the npm build tool to the actual package manager based on root-level lockfiles.
 *
 * Only considers root-level files (no `/` or `\` in path) to avoid false positives
 * from nested lockfiles in monorepo subdirectories (e.g. packages/app/pnpm-lock.yaml).
 *
 * Scans allFiles for known lockfile basenames at root level. If a non-npm lockfile
 * is found, replaces the 'npm' build tool with the actual package manager.
 * If package-lock.json is found (or no lockfile at all), npm stays.
 *
 * Mutates buildTools in place. Only acts when 'npm' is already in buildTools
 * (i.e., package.json was detected).
 */
function refineBuildToolFromLockfiles(
  allFiles: readonly string[],
  buildTools: DetectedItem[],
): void {
  const npmIndex = buildTools.findIndex((t) => t.id === 'npm');
  if (npmIndex === -1) return; // No npm build tool to refine

  // Only root-level files: no path separator means it's at project root
  const rootFiles = new Set(allFiles.filter((f) => !f.includes('/') && !f.includes('\\')));

  // Check for non-npm lockfiles at root (first match wins)
  for (const rule of LOCKFILE_RULES) {
    if (!rootFiles.has(rule.basename)) continue;

    // Replace npm with the actual package manager
    buildTools[npmIndex] = {
      id: rule.id,
      confidence: 0.9,
      classification: 'fact',
      evidence: [rule.basename],
    };
    return; // First lockfile match wins
  }

  // If package-lock.json is present at root, enrich npm evidence
  if (rootFiles.has('package-lock.json')) {
    const npmItem = buildTools[npmIndex]!;
    if (!npmItem.evidence.includes('package-lock.json')) {
      npmItem.evidence.push('package-lock.json');
    }
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

    // Version extraction post-pass (requires readFile capability)
    if (input.readFile) {
      await extractVersions(
        input.readFile,
        languages,
        frameworks,
        runtimes,
        testFrameworks,
        tools,
        qualityTools,
      );
    }

    return {
      status: 'complete',
      data: { languages, frameworks, buildTools, testFrameworks, runtimes, tools, qualityTools },
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

/** Type alias for the readFile function from CollectorInput. */
type ReadFileFn = (relativePath: string) => Promise<string | undefined>;

/**
 * Safely read a file, returning undefined on any error.
 * Wraps the readFile function to guarantee fail-soft behavior.
 */
async function safeRead(readFile: ReadFileFn, relativePath: string): Promise<string | undefined> {
  try {
    return await readFile(relativePath);
  } catch {
    return undefined;
  }
}

/** Set version + versionEvidence on a DetectedItem. */
function setVersion(item: DetectedItem, version: string, evidence: string): void {
  item.version = version;
  item.versionEvidence = evidence;
}

/** Set compilerTarget + compilerTargetEvidence on a DetectedItem. */
function setCompilerTarget(item: DetectedItem, target: string, evidence: string): void {
  item.compilerTarget = target;
  item.compilerTargetEvidence = evidence;
}

/** Extract the first capture group from a regex match, or undefined. */
function captureGroup(match: RegExpMatchArray | null, group: number = 1): string | undefined {
  return match?.[group] ?? undefined;
}

/** Find an item by id in a DetectedItem array. */
function findItem(items: DetectedItem[], id: string): DetectedItem | undefined {
  return items.find((i) => i.id === id);
}

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
 * 7. build.gradle(.kts) artifacts (tools, test frameworks, quality tools — Gradle fallback)
 * 8. go.mod (Go version — no shared targets)
 *
 * Maven runs before Gradle: in projects with both pom.xml and build.gradle,
 * Maven is the canonical build system and Gradle values are ignored via
 * first-write-wins on languages.java.version and frameworks.spring-boot.version.
 * Same applies to artifact detection: pom.xml artifacts are authoritative.
 */
async function extractVersions(
  readFile: ReadFileFn,
  languages: DetectedItem[],
  frameworks: DetectedItem[],
  runtimes: DetectedItem[],
  testFrameworks: DetectedItem[],
  tools: DetectedItem[],
  qualityTools: DetectedItem[],
): Promise<void> {
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
  );
  await extractFromTsConfig(readFile, languages);
  // Maven before Gradle: shared write targets (languages.java, frameworks.spring-boot)
  await extractFromPomXml(readFile, languages, frameworks);
  await extractArtifactsFromPomXml(readFile, testFrameworks, tools, qualityTools);
  await extractFromGradleBuild(readFile, languages, frameworks);
  await extractArtifactsFromGradle(readFile, testFrameworks, tools, qualityTools);
  await extractFromGoMod(readFile, languages);
}

/**
 * Extract Node.js version from .nvmrc or .node-version files.
 * Format: plain text, single line with version string.
 * Always writes to runtimes.node — never to language items.
 */
async function extractFromNodeVersionFiles(
  readFile: ReadFileFn,
  runtimes: DetectedItem[],
): Promise<void> {
  for (const file of ['.nvmrc', '.node-version']) {
    const content = await safeRead(readFile, file);
    if (!content) continue;

    // Strip leading 'v', whitespace, and take first line
    const firstLine = content.trim().split('\n')[0] ?? '';
    const version = firstLine.replace(/^v/i, '').trim();
    if (!version || !/^\d/.test(version)) continue;

    enrichRuntimeVersion(runtimes, 'node', version, file);
    return; // First match wins
  }
}

/**
 * Extract versions from package.json: engines.node, framework dependencies,
 * devDependencies.typescript, and full JS/TS ecosystem scanning.
 *
 * Scans both `dependencies` and `devDependencies` against JS_ECOSYSTEM_DEPS
 * to detect and version-enrich frameworks, test frameworks, and quality tools.
 * Config-detected items get version enrichment; new items are created.
 */
async function extractFromPackageJson(
  readFile: ReadFileFn,
  languages: DetectedItem[],
  frameworks: DetectedItem[],
  runtimes: DetectedItem[],
  testFrameworks: DetectedItem[],
  qualityTools: DetectedItem[],
): Promise<void> {
  const content = await safeRead(readFile, 'package.json');
  if (!content) return;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return;
  }

  // engines.node → node runtime version (never to language items)
  const engines = pkg.engines as Record<string, string> | undefined;
  if (engines?.node) {
    const ver = captureGroup(engines.node.match(/(\d+(?:\.\d+)*)/));
    if (ver) {
      enrichRuntimeVersion(runtimes, 'node', ver, 'package.json:engines.node');
    }
  }

  // Combined deps + devDeps for JS ecosystem scanning
  const deps = pkg.dependencies as Record<string, string> | undefined;
  const devDeps = pkg.devDependencies as Record<string, string> | undefined;

  // ── JS/TS ecosystem scanning ──────────────────────────────────────────
  // Scan both deps and devDeps against JS_ECOSYSTEM_DEPS.
  // For each matched package, resolve the target array from category,
  // then enrich or create the item with its version.
  const seenIds = new Set<string>();
  for (const rule of JS_ECOSYSTEM_DEPS) {
    if (seenIds.has(rule.id)) continue; // First matching package per id wins

    const range = deps?.[rule.pkg] ?? devDeps?.[rule.pkg];
    if (!range) continue;

    seenIds.add(rule.id);
    const ver = captureGroup(range.match(/(\d+(?:\.\d+)*)/));
    const evidenceKey = `package.json:${deps?.[rule.pkg] ? 'dependencies' : 'devDependencies'}.${rule.pkg}`;

    let targetArray: DetectedItem[];
    switch (rule.category) {
      case 'framework':
        targetArray = frameworks;
        break;
      case 'testFramework':
        targetArray = testFrameworks;
        break;
      case 'qualityTool':
        targetArray = qualityTools;
        break;
    }

    enrichOrCreateItem(targetArray, rule.id, evidenceKey, ver);
  }

  // devDependencies.typescript → typescript version
  const tsRange = devDeps?.typescript ?? deps?.typescript;
  if (tsRange) {
    const tsItem = findItem(languages, 'typescript');
    if (tsItem && !tsItem.version) {
      const ver = captureGroup(tsRange.match(/(\d+(?:\.\d+)*)/));
      if (ver) {
        setVersion(tsItem, ver, 'package.json:devDependencies.typescript');
      }
    }
  }
}

/**
 * Extract TypeScript compiler target from tsconfig.json compilerOptions.target.
 * Stored as compilerTarget, not version — ES2022 is not a TypeScript version.
 */
async function extractFromTsConfig(readFile: ReadFileFn, languages: DetectedItem[]): Promise<void> {
  const content = await safeRead(readFile, 'tsconfig.json');
  if (!content) return;

  // tsconfig may have comments (JSONC) — use regex instead of JSON.parse
  const target = captureGroup(content.match(/"target"\s*:\s*"([^"]+)"/i));
  if (!target) return;

  const tsItem = findItem(languages, 'typescript');
  if (tsItem && !tsItem.compilerTarget) {
    setCompilerTarget(tsItem, target, 'tsconfig.json:compilerOptions.target');
  }
}

/**
 * Extract Java and Spring Boot versions from pom.xml.
 * Conservative regex: only matches `<property>value</property>` patterns.
 */
async function extractFromPomXml(
  readFile: ReadFileFn,
  languages: DetectedItem[],
  frameworks: DetectedItem[],
): Promise<void> {
  const content = await safeRead(readFile, 'pom.xml');
  if (!content) return;

  // <java.version>21</java.version>
  const javaVer = captureGroup(
    content.match(/<java\.version>\s*(\d+(?:\.\d+)*)\s*<\/java\.version>/),
  );
  if (javaVer) {
    const javaItem = findItem(languages, 'java');
    if (javaItem && !javaItem.version) {
      setVersion(javaItem, javaVer, 'pom.xml:<java.version>');
    }
  }

  // <maven.compiler.source>21</maven.compiler.source> (alternative Java version)
  if (!javaVer) {
    const compilerVer = captureGroup(
      content.match(/<maven\.compiler\.source>\s*(\d+(?:\.\d+)*)\s*<\/maven\.compiler\.source>/),
    );
    if (compilerVer) {
      const javaItem = findItem(languages, 'java');
      if (javaItem && !javaItem.version) {
        setVersion(javaItem, compilerVer, 'pom.xml:<maven.compiler.source>');
      }
    }
  }

  // Spring Boot version from <spring-boot.version> or parent artifact version
  const sbVer = captureGroup(
    content.match(
      /<spring-boot\.version>\s*(\d+(?:\.\d+)*(?:[.-][A-Za-z0-9]+)*)\s*<\/spring-boot\.version>/,
    ),
  );
  if (sbVer) {
    enrichFrameworkVersion(frameworks, 'spring-boot', sbVer, 'pom.xml:<spring-boot.version>');
    return;
  }

  // Fallback: Spring Boot parent version
  const parentVer = captureGroup(
    content.match(
      /<parent>[\s\S]*?<artifactId>\s*spring-boot-starter-parent\s*<\/artifactId>[\s\S]*?<version>\s*(\d+(?:\.\d+)*(?:[.-][A-Za-z0-9]+)*)\s*<\/version>[\s\S]*?<\/parent>/,
    ),
  );
  if (parentVer) {
    enrichFrameworkVersion(frameworks, 'spring-boot', parentVer, 'pom.xml:parent.version');
  }
}

/** Add or enrich a framework item with version info. */
function enrichFrameworkVersion(
  frameworks: DetectedItem[],
  id: string,
  version: string,
  evidence: string,
): void {
  let item = findItem(frameworks, id);
  if (!item) {
    // Spring Boot may not have been detected via config files — add it
    item = {
      id,
      confidence: 0.85,
      classification: 'derived_signal',
      evidence: [evidence],
    };
    frameworks.push(item);
  }
  if (!item.version) {
    setVersion(item, version, evidence);
  }
}

/** Add or enrich a runtime item with version info. */
function enrichRuntimeVersion(
  runtimes: DetectedItem[],
  id: string,
  version: string,
  evidence: string,
): void {
  let item = findItem(runtimes, id);
  if (!item) {
    item = {
      id,
      confidence: 0.85,
      classification: 'derived_signal',
      evidence: [evidence],
    };
    runtimes.push(item);
  }
  if (!item.version) {
    setVersion(item, version, evidence);
  }
}

/**
 * Extract Java and Spring Boot versions from build.gradle or build.gradle.kts.
 * Conservative: only matches sourceCompatibility, JavaLanguageVersion.of(),
 * and Spring Boot plugin declarations.
 */
async function extractFromGradleBuild(
  readFile: ReadFileFn,
  languages: DetectedItem[],
  frameworks: DetectedItem[],
): Promise<void> {
  for (const file of ['build.gradle.kts', 'build.gradle']) {
    const content = await safeRead(readFile, file);
    if (!content) continue;

    // ── Java version ──────────────────────────────────────────────────────
    const javaItem = findItem(languages, 'java');
    if (javaItem && !javaItem.version) {
      // JavaLanguageVersion.of(21) — Gradle Kotlin DSL / Groovy toolchain API
      const toolchainVer = captureGroup(content.match(/JavaLanguageVersion\.of\(\s*(\d+)\s*\)/));
      if (toolchainVer) {
        setVersion(javaItem, toolchainVer, `${file}:JavaLanguageVersion.of`);
      } else {
        // sourceCompatibility = JavaVersion.VERSION_21 or sourceCompatibility = '21'
        const srcCompatMatch = content.match(
          /sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_(\d+)|['"](\d+)['"]|(\d+))/,
        );
        if (srcCompatMatch) {
          const ver = srcCompatMatch[1] ?? srcCompatMatch[2] ?? srcCompatMatch[3];
          if (ver) {
            setVersion(javaItem, ver, `${file}:sourceCompatibility`);
          }
        }
      }
    }

    // ── Spring Boot version from plugin declaration ───────────────────────
    // id("org.springframework.boot") version "4.0.1" (Kotlin DSL)
    // id 'org.springframework.boot' version '4.0.1' (Groovy DSL)
    const sbPluginVer = captureGroup(
      content.match(
        /id\s*\(?['"]org\.springframework\.boot['"]\)?\s+version\s+['"](\d+(?:\.\d+)*(?:[.-][A-Za-z0-9]+)*)['"]/,
      ),
    );
    if (sbPluginVer) {
      enrichFrameworkVersion(frameworks, 'spring-boot', sbPluginVer, `${file}:plugin.spring-boot`);
    } else {
      // springBootVersion = "4.0.1" or springBootVersion = '4.0.1'
      const sbVarVer = captureGroup(
        content.match(/springBootVersion\s*=\s*['"](\d+(?:\.\d+)*(?:[.-][A-Za-z0-9]+)*)['"]/),
      );
      if (sbVarVer) {
        enrichFrameworkVersion(frameworks, 'spring-boot', sbVarVer, `${file}:springBootVersion`);
      }
    }

    return; // First file with content wins (build.gradle.kts preferred)
  }
}

/**
 * Extract Go version from go.mod directive.
 * Format: `go 1.22` or `go 1.22.1`.
 */
async function extractFromGoMod(readFile: ReadFileFn, languages: DetectedItem[]): Promise<void> {
  const content = await safeRead(readFile, 'go.mod');
  if (!content) return;

  const goVer = captureGroup(content.match(/^go\s+(\d+\.\d+(?:\.\d+)?)/m));
  if (!goVer) return;

  const goItem = findItem(languages, 'go');
  if (goItem && !goItem.version) {
    setVersion(goItem, goVer, 'go.mod:go');
  }
}

// ─── Artifact Detection (pom.xml / build.gradle) ─────────────────────────────

/**
 * Add or create a detected item. First-match-wins per id.
 * If the item already exists in the array, it is not modified.
 */
function enrichDetectedItem(
  items: DetectedItem[],
  id: string,
  evidence: string,
  version?: string,
): void {
  if (findItem(items, id)) return; // Already detected — first-match-wins
  const item: DetectedItem = {
    id,
    confidence: 0.85,
    classification: 'derived_signal',
    evidence: [evidence],
  };
  if (version) {
    item.version = version;
    item.versionEvidence = evidence;
  }
  items.push(item);
}

/**
 * Enrich version on an existing item, or create a new item with version.
 *
 * Unlike enrichDetectedItem (first-match-wins, no version enrichment),
 * this function ADDS a version to an existing versionless item when one
 * is found — enabling config-detected items to be enriched from package.json.
 * If the item already has a version, the existing version is preserved.
 */
function enrichOrCreateItem(
  items: DetectedItem[],
  id: string,
  evidence: string,
  version?: string,
): void {
  const existing = findItem(items, id);
  if (existing) {
    // Enrich version if the existing item lacks one
    if (!existing.version && version) {
      setVersion(existing, version, evidence);
    }
    return;
  }
  const item: DetectedItem = {
    id,
    confidence: 0.85,
    classification: 'derived_signal',
    evidence: [evidence],
  };
  if (version) {
    item.version = version;
    item.versionEvidence = evidence;
  }
  items.push(item);
}

/** Resolve the target array for an artifact category. */
function resolveTargetArray(
  category: ArtifactCategory,
  testFrameworks: DetectedItem[],
  tools: DetectedItem[],
  qualityTools: DetectedItem[],
): DetectedItem[] {
  switch (category) {
    case 'tool':
      return tools;
    case 'testFramework':
      return testFrameworks;
    case 'qualityTool':
      return qualityTools;
  }
}

/**
 * Extract tool/testFramework/qualityTool artifacts from pom.xml.
 *
 * Scans <dependency> and <plugin> blocks for known artifact IDs.
 * Version extraction is best-effort: when a <version> tag exists in the
 * same block it is captured; BOM-managed dependencies without explicit
 * versions are still detected (without version).
 */
async function extractArtifactsFromPomXml(
  readFile: ReadFileFn,
  testFrameworks: DetectedItem[],
  tools: DetectedItem[],
  qualityTools: DetectedItem[],
): Promise<void> {
  const content = await safeRead(readFile, 'pom.xml');
  if (!content) return;

  // Extract all <dependency>...</dependency> and <plugin>...</plugin> blocks
  const blocks = [
    ...content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g),
    ...content.matchAll(/<plugin>([\s\S]*?)<\/plugin>/g),
  ];

  const detected = new Set<string>();

  for (const rule of POM_ARTIFACT_RULES) {
    if (detected.has(rule.id)) continue;

    for (const [, blockContent] of blocks) {
      if (!blockContent) continue;
      if (!new RegExp(`<artifactId>\\s*${rule.artifactId}\\s*</artifactId>`).test(blockContent)) {
        continue;
      }

      // Found artifact — try to extract version from same block
      const versionMatch = blockContent.match(
        /<version>\s*(\d+(?:\.\d+)*(?:[.-][A-Za-z0-9+]*)*)\s*<\/version>/,
      );
      const version = versionMatch?.[1];
      const evidence = `pom.xml:${rule.evidenceType}.${rule.artifactId}`;
      const targetArray = resolveTargetArray(rule.category, testFrameworks, tools, qualityTools);

      enrichDetectedItem(targetArray, rule.id, evidence, version);
      detected.add(rule.id);
      break; // Found in a block, move to next rule
    }
  }
}

/**
 * Extract tool/testFramework/qualityTool artifacts from build.gradle(.kts).
 *
 * Scans plugin declarations and dependency configurations for known artifacts.
 * Runs AFTER pom.xml extraction — Maven is authoritative; Gradle values are
 * only added for IDs not already detected (first-write-wins across files).
 */
async function extractArtifactsFromGradle(
  readFile: ReadFileFn,
  testFrameworks: DetectedItem[],
  tools: DetectedItem[],
  qualityTools: DetectedItem[],
): Promise<void> {
  let content: string | undefined;
  let file: string | undefined;

  for (const candidate of ['build.gradle.kts', 'build.gradle']) {
    content = await safeRead(readFile, candidate);
    if (content) {
      file = candidate;
      break;
    }
  }
  if (!content || !file) return;

  // ── Plugin declarations with explicit version ──────────────────────────
  for (const rule of GRADLE_PLUGIN_RULES) {
    const targetArray = resolveTargetArray(rule.category, testFrameworks, tools, qualityTools);
    if (findItem(targetArray, rule.id)) continue; // first-match-wins

    const escapedId = rule.pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // id("plugin.id") version "1.2.3" or id 'plugin.id' version '1.2.3'
    const pluginMatch = content.match(
      new RegExp(
        `id\\s*\\(?['"]${escapedId}['"]\\)?\\s+version\\s+['"](\\d+(?:\\.\\d+)*(?:[.-][A-Za-z0-9+]*)*)['"]`,
      ),
    );
    if (pluginMatch) {
      enrichDetectedItem(targetArray, rule.id, `${file}:plugin.${rule.id}`, pluginMatch[1]);
      continue;
    }

    // Built-in plugins: bare name on own line or apply plugin: 'name'
    if (rule.builtin) {
      const applied =
        new RegExp(`apply\\s+plugin:\\s*['"]${escapedId}['"]`).test(content) ||
        new RegExp(`^\\s*${escapedId}\\s*$`, 'm').test(content);
      if (applied) {
        enrichDetectedItem(targetArray, rule.id, `${file}:plugin.${rule.id}`);
      }
    }
  }

  // ── Dependency declarations: "group:artifact:version" or "group:artifact" ──
  for (const rule of GRADLE_DEPENDENCY_RULES) {
    const targetArray = resolveTargetArray(rule.category, testFrameworks, tools, qualityTools);
    if (findItem(targetArray, rule.id)) continue; // first-match-wins

    const depMatch = content.match(
      new RegExp(`['"][\\w.-]+:${rule.artifact}(?::(\\d+(?:\\.\\d+)*(?:[.-][A-Za-z0-9+]*)*))?['"]`),
    );
    if (!depMatch) continue;

    enrichDetectedItem(targetArray, rule.id, `${file}:dependency.${rule.artifact}`, depMatch[1]);
  }
}
