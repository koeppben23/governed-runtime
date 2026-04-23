/**
 * @module discovery/scoped-stack
 * @description Module-scoped stack detection for monorepos.
 *
 * Extracts scoped stack facts from nested module roots (apps/*, packages/*, etc.)
 * without globalizing nested evidence.
 *
 * Single source of truth for scoped stack detection logic.
 */

import type { DetectedItem, DetectedStackTarget } from './types.js';
import { normalizeRepoSignalPath } from './repo-paths.js';

/** Maximum number of scopes to return (budget limit). */
const MAX_SCOPES = 20;

/** Maximum number of items per scope (budget limit). */
const MAX_ITEMS_PER_SCOPE = 25;

/** Directories to ignore when detecting module roots. */
const IGNORED_DIRS = new Set([
  'examples',
  'example',
  'fixtures',
  'fixture',
  'test',
  'tests',
  'docs',
  'scripts',
]);

/** Manifest files that indicate a module root. */
const SCOPE_INDICATORS = [
  { pattern: /^([^/]+)\/package\.json$/, type: 'package' },
  { pattern: /^([^/]+)\/pom\.xml$/, type: 'maven' },
  { pattern: /^([^/]+)\/build\.gradle(\.kts)?$/, type: 'gradle' },
  { pattern: /^([^/]+)\/Cargo\.toml$/, type: 'rust' },
  { pattern: /^([^/]+)\/pyproject\.toml$/, type: 'python' },
  { pattern: /^([^/]+)\/\.python-version$/, type: 'python' },
  { pattern: /^([^/]+)\/go\.mod$/, type: 'go' },
  { pattern: /^([^/]+)\/docker-compose.*\.ya?ml$/, type: 'compose' },
] as const;

/** Extended indicators for nested paths (depth 2). */
const NESTED_SCOPE_INDICATORS = [
  { pattern: /^([^/]+)\/([^/]+)\/package\.json$/, type: 'package' },
  { pattern: /^([^/]+)\/([^/]+)\/pom\.xml$/, type: 'maven' },
  { pattern: /^([^/]+)\/([^/]+)\/build\.gradle(\.kts)?$/, type: 'gradle' },
  { pattern: /^([^/]+)\/([^/]+)\/Cargo\.toml$/, type: 'rust' },
  { pattern: /^([^/]+)\/([^/]+)\/pyproject\.toml$/, type: 'python' },
  { pattern: /^([^/]+)\/([^/]+)\/go\.mod$/, type: 'go' },
  { pattern: /^([^/]+)\/([^/]+)\/docker-compose.*\.ya?ml$/, type: 'compose' },
] as const;

/** Extended indicators for deeper nested paths (depth 3). */
const DEEP_NESTED_SCOPE_INDICATORS = [
  { pattern: /^([^/]+)\/([^/]+)\/([^/]+)\/package\.json$/, type: 'package' },
  { pattern: /^([^/]+)\/([^/]+)\/([^/]+)\/pom\.xml$/, type: 'maven' },
  { pattern: /^([^/]+)\/([^/]+)\/([^/]+)\/build\.gradle(\.kts)?$/, type: 'gradle' },
  { pattern: /^([^/]+)\/([^/]+)\/([^/]+)\/Cargo\.toml$/, type: 'rust' },
  { pattern: /^([^/]+)\/([^/]+)\/([^/]+)\/pyproject\.toml$/, type: 'python' },
  { pattern: /^([^/]+)\/([^/]+)\/([^/]+)\/go\.mod$/, type: 'go' },
  { pattern: /^([^/]+)\/([^/]+)\/([^/]+)\/docker-compose.*\.ya?ml$/, type: 'compose' },
] as const;

/**
 * Extract the scope path from a file path.
 * Returns null if the path is not a recognized module indicator or is in an ignored directory.
 */
function extractScopePath(filePath: string): string | null {
  for (const indicator of SCOPE_INDICATORS) {
    const match = filePath.match(indicator.pattern);
    if (match && !IGNORED_DIRS.has(match[1]!)) {
      return match[1]!;
    }
  }

  for (const indicator of NESTED_SCOPE_INDICATORS) {
    const match = filePath.match(indicator.pattern);
    if (match && !IGNORED_DIRS.has(match[1]!) && !IGNORED_DIRS.has(match[2]!)) {
      return `${match[1]!}/${match[2]!}`;
    }
  }

  for (const indicator of DEEP_NESTED_SCOPE_INDICATORS) {
    const match = filePath.match(indicator.pattern);
    if (
      match &&
      !IGNORED_DIRS.has(match[1]!) &&
      !IGNORED_DIRS.has(match[2]!) &&
      !IGNORED_DIRS.has(match[3]!)
    ) {
      return `${match[1]!}/${match[2]!}/${match[3]!}`;
    }
  }

  return null;
}

/**
 * Check if evidence originates from within a given scope path.
 */
function isEvidenceInScope(evidence: string[], scopePath: string): boolean {
  for (const ev of evidence) {
    const evPath = normalizeRepoSignalPath(ev.split(':')[0]!);
    if (evPath.startsWith(scopePath + '/') || evPath === scopePath) {
      return true;
    }
  }
  return false;
}

/** ReadFile function type. */
type ReadFileFn = (relativePath: string) => Promise<string | undefined>;

/**
 * Extract obvious facts from nested package.json content.
 */
function extractFromNestedPackageJson(
  content: string,
): Array<{ id: string; kind: DetectedStackTarget; version?: string }> {
  const facts: Array<{ id: string; kind: DetectedStackTarget; version?: string }> = [];

  const extractNumericVersion = (raw: string | undefined): string | undefined =>
    raw?.match(/(\d+(?:\.\d+)*)/)?.[1];

  try {
    const pkg = JSON.parse(content);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    const packageManager = pkg.packageManager;

    if (pkg.engines?.node) {
      const nodeVersion = extractNumericVersion(pkg.engines.node);
      if (nodeVersion) {
        facts.push({ id: 'node', kind: 'runtime', version: nodeVersion });
      } else {
        facts.push({ id: 'node', kind: 'runtime' });
      }
    }

    if (deps.react) {
      facts.push({ id: 'react', kind: 'framework', version: extractNumericVersion(deps.react) });
    }
    if (deps['react-dom']) {
      facts.push({
        id: 'react-dom',
        kind: 'framework',
        version: extractNumericVersion(deps['react-dom']),
      });
    }
    if (deps.vue) {
      facts.push({ id: 'vue', kind: 'framework', version: extractNumericVersion(deps.vue) });
    }
    if (deps.next) {
      facts.push({ id: 'next', kind: 'framework', version: extractNumericVersion(deps.next) });
    }
    if (deps['@angular/core']) {
      facts.push({ id: 'angular', kind: 'framework' });
    }
    if (deps.vite) {
      facts.push({ id: 'vite', kind: 'buildTool' });
    }
    if (deps.esbuild) {
      facts.push({ id: 'esbuild', kind: 'tool' });
    }
    if (deps.typescript) {
      facts.push({ id: 'typescript', kind: 'language' });
    }
    if (deps.jest) {
      facts.push({ id: 'jest', kind: 'testFramework' });
    }
    if (deps.vitest) {
      facts.push({ id: 'vitest', kind: 'testFramework' });
    }
    if (deps.mocha) {
      facts.push({ id: 'mocha', kind: 'testFramework' });
    }
    if (deps.eslint) {
      facts.push({ id: 'eslint', kind: 'qualityTool' });
    }
    if (deps.prettier) {
      facts.push({ id: 'prettier', kind: 'qualityTool' });
    }

    if (packageManager) {
      const pm = packageManager.replace(/@.*$/, '').toLowerCase();
      if (['pnpm', 'yarn', 'npm', 'bun'].includes(pm)) {
        facts.push({ id: pm, kind: 'buildTool' });
      }
    }
  } catch {
    // Invalid JSON, skip
  }

  return facts;
}

/**
 * Extract obvious facts from nested pom.xml content.
 */
function extractFromNestedPomXml(
  content: string,
): Array<{ id: string; kind: DetectedStackTarget; version?: string }> {
  const facts: Array<{ id: string; kind: DetectedStackTarget; version?: string }> = [];

  facts.push({ id: 'maven', kind: 'buildTool' });

  const javaVersionMatch = content.match(/<java\.version>([^<]+)<\/java\.version>/);
  if (javaVersionMatch) {
    facts.push({ id: 'java', kind: 'language', version: javaVersionMatch[1] });
  }

  const parentBlockMatch = content.match(
    /<parent>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<version>([^<]+)<\/version>[\s\S]*?<\/parent>/,
  );
  if (parentBlockMatch) {
    const [, parentGroupId, parentArtifactId, parentVersion] = parentBlockMatch;
    if (
      parentGroupId === 'org.springframework.boot' ||
      parentArtifactId === 'spring-boot-starter-parent'
    ) {
      facts.push({ id: 'spring-boot', kind: 'framework', version: parentVersion });
    }
  }

  if (content.includes('<maven.compiler.source>')) {
    facts.push({ id: 'java', kind: 'language' });
  }

  if (
    content.includes('<groupId>org.springframework.boot</groupId>') ||
    content.includes('<artifactId>spring-boot</artifactId>')
  ) {
    facts.push({ id: 'spring-boot', kind: 'framework' });
  }

  if (
    content.includes('<artifactId>maven</artifactId>') ||
    content.includes('<artifactId>maven-compiler-plugin</artifactId>')
  ) {
    facts.push({ id: 'maven', kind: 'buildTool' });
  }

  if (
    content.includes('<artifactId>gradle</artifactId>') ||
    content.includes('gradle.plugin') ||
    content.includes('com.github.gradle')
  ) {
    facts.push({ id: 'gradle', kind: 'buildTool' });
  }

  if (content.includes('<artifactId>junit</artifactId>')) {
    facts.push({ id: 'junit', kind: 'testFramework' });
  }
  if (content.includes('<artifactId>testng</artifactId>')) {
    facts.push({ id: 'testng', kind: 'testFramework' });
  }

  return facts;
}

/**
 * Extract obvious facts from nested Cargo.toml content.
 */
function extractFromNestedCargoToml(
  content: string,
): Array<{ id: string; kind: DetectedStackTarget; version?: string }> {
  const facts: Array<{ id: string; kind: DetectedStackTarget; version?: string }> = [];
  if (content.includes('[package]')) {
    facts.push({ id: 'rust', kind: 'language' });
    facts.push({ id: 'cargo', kind: 'buildTool' });
  }

  if (content.includes('[dev-dependencies]') || content.includes('[dependencies]')) {
    if (!facts.find((f) => f.id === 'rust')) {
      facts.push({ id: 'rust', kind: 'language' });
    }
  }

  return facts;
}

/**
 * Extract obvious facts from nested pyproject.toml content.
 */
function extractFromNestedPyprojectToml(
  content: string,
): Array<{ id: string; kind: DetectedStackTarget; version?: string }> {
  const facts: Array<{ id: string; kind: DetectedStackTarget; version?: string }> = [];

  const requiresPython = content.match(/requires-python\s*=\s*"([^"]+)"/);
  const pythonVersion = requiresPython?.[1]?.match(/(\d+)/)?.[1];
  if (pythonVersion) {
    facts.push({ id: 'python', kind: 'language', version: pythonVersion });
  }

  if (
    content.includes('[project]') ||
    content.includes('[tool.poetry]') ||
    content.includes('[tool.hatch]')
  ) {
    facts.push({ id: 'python', kind: 'language' });
  }

  if (content.includes('[tool.pytest')) {
    facts.push({ id: 'pytest', kind: 'testFramework' });
  }
  if (content.includes('[tool.ruff]')) {
    facts.push({ id: 'ruff', kind: 'qualityTool' });
  }
  if (content.includes('[tool.black]')) {
    facts.push({ id: 'black', kind: 'qualityTool' });
  }
  if (content.includes('[tool.mypy]')) {
    facts.push({ id: 'mypy', kind: 'qualityTool' });
  }

  return facts;
}

/**
 * Extract database facts from nested docker-compose content.
 * Only extracts from explicit image: lines, not from arbitrary text matches.
 */
function extractFromNestedDockerCompose(
  content: string,
): Array<{ id: string; kind: DetectedStackTarget; version?: string }> {
  const facts: Array<{ id: string; kind: DetectedStackTarget; version?: string }> = [];

  const imageMatches = content.matchAll(/^\s*image\s*:\s*['"]?([^'"\s]+)['"]?/gm);
  for (const match of imageMatches) {
    const imageRef = match[1]?.trim();
    if (!imageRef || imageRef.includes('${')) continue;

    const withoutDigest = imageRef.split('@')[0] ?? imageRef;
    const lastSegment = withoutDigest.split('/').pop()?.toLowerCase();
    if (!lastSegment) continue;

    const [imageName, rawTag] = lastSegment.split(':');
    let version: string | undefined;
    if (rawTag && rawTag !== 'latest' && !rawTag.includes('${')) {
      version = rawTag.match(/^(\d+(?:\.\d+)*)/)?.[1];
    }

    if (imageName === 'postgres' || imageName === 'postgresql') {
      facts.push({ id: 'postgresql', kind: 'database', ...(version ? { version } : {}) });
    } else if (imageName === 'mysql') {
      facts.push({ id: 'mysql', kind: 'database', ...(version ? { version } : {}) });
    } else if (imageName === 'mongo' || imageName === 'mongodb') {
      facts.push({ id: 'mongodb', kind: 'database', ...(version ? { version } : {}) });
    } else if (imageName === 'redis') {
      facts.push({ id: 'redis', kind: 'database', ...(version ? { version } : {}) });
    }
  }

  return facts;
}

/**
 * Detect nested stack facts from manifest files.
 * Returns a map of scope path -> detected facts.
 */
async function detectNestedStackFacts(
  allFiles: readonly string[],
  readFile: ReadFileFn,
): Promise<
  Map<string, Array<{ id: string; kind: DetectedStackTarget; version?: string; evidence: string }>>
> {
  const scopeFacts = new Map<
    string,
    Array<{ id: string; kind: DetectedStackTarget; version?: string; evidence: string }>
  >();

  for (const file of allFiles) {
    const normalizedPath = normalizeRepoSignalPath(file);
    const scopePath = extractScopePath(normalizedPath);
    if (!scopePath) continue;

    try {
      let facts: Array<{ id: string; kind: DetectedStackTarget; version?: string }> = [];

      if (normalizedPath.endsWith('/package.json')) {
        const content = await readFile(normalizedPath);
        if (content) {
          facts = extractFromNestedPackageJson(content);
        }
      } else if (normalizedPath.endsWith('/pom.xml')) {
        const content = await readFile(normalizedPath);
        if (content) {
          facts = extractFromNestedPomXml(content);
        }
      } else if (normalizedPath.endsWith('/Cargo.toml')) {
        const content = await readFile(normalizedPath);
        if (content) {
          facts = extractFromNestedCargoToml(content);
        }
      } else if (normalizedPath.endsWith('/pyproject.toml')) {
        const content = await readFile(normalizedPath);
        if (content) {
          facts = extractFromNestedPyprojectToml(content);
        }
      } else if (
        /^docker-compose(?:[.-][a-z0-9_.-]+)?\.ya?ml$/.test(
          normalizedPath.split('/').pop()?.toLowerCase() ?? '',
        )
      ) {
        const content = await readFile(normalizedPath);
        if (content) {
          facts = extractFromNestedDockerCompose(content);
        }
      }

      if (facts.length > 0) {
        if (!scopeFacts.has(scopePath)) {
          scopeFacts.set(scopePath, []);
        }
        for (const fact of facts) {
          scopeFacts.get(scopePath)!.push({ ...fact, evidence: normalizedPath });
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return scopeFacts;
}

/**
 * Generate a summary string from detected items.
 */
function generateSummary(
  items: Array<{ kind: DetectedStackTarget; id: string; version?: string }>,
): string {
  const kindOrder = [
    'language',
    'framework',
    'runtime',
    'buildTool',
    'tool',
    'testFramework',
    'qualityTool',
    'database',
  ] as const;

  const sorted = [...items].sort((a, b) => {
    const aKind = kindOrder.indexOf(a.kind as (typeof kindOrder)[number]);
    const bKind = kindOrder.indexOf(b.kind as (typeof kindOrder)[number]);
    if (aKind !== bKind) return aKind - bKind;
    return a.id.localeCompare(b.id);
  });

  return sorted.map((item) => (item.version ? `${item.id}=${item.version}` : item.id)).join(', ');
}

/**
 * Extract scoped stack items from a list of detected items based on allFiles.
 * Optionally detects nested manifest facts if readFile is provided.
 *
 * @param allFiles - All files in the repository
 * @param stackInfo - The detected stack information containing items per category
 * @param readFile - Optional function to read file contents (enables nested manifest detection)
 * @returns Array of scoped stack items
 */
export async function extractScopedStack(
  allFiles: readonly string[],
  stackInfo: {
    languages: DetectedItem[];
    frameworks: DetectedItem[];
    buildTools: DetectedItem[];
    testFrameworks: DetectedItem[];
    runtimes: DetectedItem[];
    tools: DetectedItem[];
    qualityTools: DetectedItem[];
    databases: DetectedItem[];
  },
  readFile?: ReadFileFn,
): Promise<
  Array<{
    path: string;
    summary: string;
    items: Array<{ kind: DetectedStackTarget; id: string; version?: string; evidence?: string }>;
    versions: Array<{
      id: string;
      version: string;
      target: DetectedStackTarget;
      evidence?: string;
    }>;
  }>
> {
  const scopeMap = new Map<string, Set<string>>();

  for (const file of allFiles) {
    const normalizedPath = normalizeRepoSignalPath(file);
    const scope = extractScopePath(normalizedPath);
    if (scope) {
      if (!scopeMap.has(scope)) {
        scopeMap.set(scope, new Set());
      }
      scopeMap.get(scope)!.add(normalizedPath);
    }
  }

  // Detect nested manifest facts if readFile is available
  let nestedFacts: Map<
    string,
    Array<{ id: string; kind: DetectedStackTarget; version?: string; evidence: string }>
  > = new Map();
  if (readFile) {
    nestedFacts = await detectNestedStackFacts(allFiles, readFile);
  }

  const allItems: Array<{ category: DetectedStackTarget; item: DetectedItem }> = [];
  for (const item of stackInfo.languages) {
    allItems.push({ category: 'language', item });
  }
  for (const item of stackInfo.frameworks) {
    allItems.push({ category: 'framework', item });
  }
  for (const item of stackInfo.buildTools) {
    allItems.push({ category: 'buildTool', item });
  }
  for (const item of stackInfo.testFrameworks) {
    allItems.push({ category: 'testFramework', item });
  }
  for (const item of stackInfo.runtimes) {
    allItems.push({ category: 'runtime', item });
  }
  for (const item of stackInfo.tools ?? []) {
    allItems.push({ category: 'tool', item });
  }
  for (const item of stackInfo.qualityTools ?? []) {
    allItems.push({ category: 'qualityTool', item });
  }
  for (const item of stackInfo.databases ?? []) {
    allItems.push({ category: 'database', item });
  }

  const scopedResults: Array<{
    path: string;
    summary: string;
    items: Array<{ kind: DetectedStackTarget; id: string; version?: string; evidence?: string }>;
    versions: Array<{
      id: string;
      version: string;
      target: DetectedStackTarget;
      evidence?: string;
    }>;
  }> = [];

  const scopePaths = Array.from(scopeMap.keys()).sort();

  for (const scopePath of scopePaths) {
    if (scopedResults.length >= MAX_SCOPES) break;

    const scopedItems: Array<{
      kind: DetectedStackTarget;
      id: string;
      version?: string;
      evidence?: string;
    }> = [];
    const scopedVersions: Array<{
      id: string;
      version: string;
      target: DetectedStackTarget;
      evidence?: string;
    }> = [];
    const seenItems = new Set<string>();

    // First: Add projected items from existing stackInfo
    for (const { category, item } of allItems) {
      if (isEvidenceInScope(item.evidence, scopePath)) {
        if (scopedItems.length >= MAX_ITEMS_PER_SCOPE) continue;

        const key = `${category}:${item.id}`;
        if (seenItems.has(key)) continue;
        seenItems.add(key);

        scopedItems.push({
          kind: category,
          id: item.id,
          version: item.version,
          evidence: item.evidence[0],
        });

        if (item.version) {
          scopedVersions.push({
            id: item.id,
            version: item.version,
            target: category,
            evidence: item.versionEvidence,
          });
        }
      }
    }

    // Second: Add nested manifest-detected facts
    const nestedScopeFacts = nestedFacts.get(scopePath);
    if (nestedScopeFacts) {
      for (const fact of nestedScopeFacts) {
        if (scopedItems.length >= MAX_ITEMS_PER_SCOPE) break;

        const key = `${fact.kind}:${fact.id}`;
        if (seenItems.has(key)) continue;
        seenItems.add(key);

        scopedItems.push({
          kind: fact.kind,
          id: fact.id,
          version: fact.version,
          evidence: fact.evidence,
        });

        if (fact.version) {
          scopedVersions.push({
            id: fact.id,
            version: fact.version,
            target: fact.kind,
            evidence: fact.evidence,
          });
        }
      }
    }

    if (scopedItems.length > 0) {
      scopedResults.push({
        path: scopePath,
        summary: generateSummary(scopedItems),
        items: scopedItems,
        versions: scopedVersions,
      });
    }
  }

  return scopedResults;
}
