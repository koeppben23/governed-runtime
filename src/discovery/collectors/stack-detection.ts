/**
 * @module discovery/collectors/stack-detection
 * @description Collector: technology stack detection.
 *
 * Detects languages, frameworks, build tools, test frameworks, and runtimes
 * by analyzing file patterns, package manifests, and config files.
 *
 * Detection strategy:
 * - File extensions → languages (fact)
 * - Package files → build tools (fact)
 * - Config files → frameworks, test frameworks (fact or derived_signal)
 * - Manifest content → version extraction (fact, requires readFile on input)
 *
 * Each detected item carries confidence, classification, and evidence.
 * Version extraction is optional: when readFile is absent, items have no version.
 *
 * @version v2
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

/** Config file → framework/tool mapping. */
const FRAMEWORK_CONFIG_RULES: ReadonlyArray<{
  id: string;
  configFiles: readonly string[];
  category: 'framework' | 'testFramework' | 'runtime';
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
];

// ─── Collector ────────────────────────────────────────────────────────────────

/**
 * Collect technology stack information.
 *
 * Scans file list, package files, and config files to detect:
 * - Languages (by file extension frequency)
 * - Build tools (by package manifest presence)
 * - Frameworks (by config file presence)
 * - Test frameworks (by config file presence)
 * - Runtimes (by config file presence)
 *
 * When `input.readFile` is provided, also extracts version information
 * from manifest file contents. Version extraction is fail-soft: unreadable
 * or unparseable files result in `version: undefined`, never errors.
 */
export async function collectStack(input: CollectorInput): Promise<CollectorOutput<StackInfo>> {
  try {
    const languages = detectLanguages(input.allFiles);
    const buildTools = detectBuildTools(input.packageFiles);
    const { frameworks, testFrameworks, runtimes } = detectFromConfigs(input.configFiles);

    // Version extraction post-pass (requires readFile capability)
    if (input.readFile) {
      await extractVersions(input.readFile, languages, frameworks, runtimes);
    }

    return {
      status: 'complete',
      data: { languages, frameworks, buildTools, testFrameworks, runtimes },
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
 * Detect frameworks, test frameworks, and runtimes from config files.
 * Confidence is 0.85 (config file presence is a strong signal).
 */
function detectFromConfigs(configFiles: readonly string[]): {
  frameworks: DetectedItem[];
  testFrameworks: DetectedItem[];
  runtimes: DetectedItem[];
} {
  const configSet = new Set(configFiles);
  const frameworks: DetectedItem[] = [];
  const testFrameworks: DetectedItem[] = [];
  const runtimes: DetectedItem[] = [];

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
    }
  }

  return { frameworks, testFrameworks, runtimes };
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
 * Execution order matters for deterministic priority:
 * 1. .nvmrc / .node-version (highest Node version authority)
 * 2. package.json (engines.node, TS dep version, framework deps)
 * 3. All other extractors in parallel (no shared write targets)
 */
async function extractVersions(
  readFile: ReadFileFn,
  languages: DetectedItem[],
  frameworks: DetectedItem[],
  runtimes: DetectedItem[],
): Promise<void> {
  // Serial: runtime version precedence must be deterministic.
  // .nvmrc / .node-version > package.json engines.node
  await extractFromNodeVersionFiles(readFile, runtimes);
  await extractFromPackageJson(readFile, languages, frameworks, runtimes);

  // Parallel: remaining extractors have no shared write targets.
  await Promise.all([
    extractFromTsConfig(readFile, languages),
    extractFromPomXml(readFile, languages, frameworks),
    extractFromGradleBuild(readFile, languages, frameworks),
    extractFromGoMod(readFile, languages),
  ]);
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
 * devDependencies.typescript.
 */
async function extractFromPackageJson(
  readFile: ReadFileFn,
  languages: DetectedItem[],
  frameworks: DetectedItem[],
  runtimes: DetectedItem[],
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

  // Framework version extraction from dependencies
  const deps = pkg.dependencies as Record<string, string> | undefined;
  const devDeps = pkg.devDependencies as Record<string, string> | undefined;

  const FRAMEWORK_DEPS: ReadonlyArray<{
    pkg: string;
    id: string;
    evidenceKey: string;
  }> = [
    { pkg: '@angular/core', id: 'angular', evidenceKey: 'dependencies.@angular/core' },
    { pkg: 'react', id: 'react', evidenceKey: 'dependencies.react' },
    { pkg: 'next', id: 'next', evidenceKey: 'dependencies.next' },
    { pkg: 'vue', id: 'vue', evidenceKey: 'dependencies.vue' },
    { pkg: 'nuxt', id: 'nuxt', evidenceKey: 'dependencies.nuxt' },
  ];

  for (const fw of FRAMEWORK_DEPS) {
    const range = deps?.[fw.pkg];
    if (!range) continue;

    const fwItem = findItem(frameworks, fw.id);
    if (fwItem && !fwItem.version) {
      const ver = captureGroup(range.match(/(\d+(?:\.\d+)*)/));
      if (ver) {
        setVersion(fwItem, ver, `package.json:${fw.evidenceKey}`);
      }
    }
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
