/**
 * @module discovery/scoped-stack
 * @description Module-scoped stack detection for monorepos.
 *
 * Extracts scoped stack facts from nested module roots (apps/*, packages/*, etc.)
 * without globalizing nested evidence.
 *
 * Single source of truth for scoped stack detection logic.
 */

import type { DetectedItem } from './types.js';
import type { DetectedStackTarget } from '../state/discovery-schemas.js';
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

/** Scope-indicator families paired with the number of path segments each captures. */
const SCOPE_INDICATOR_FAMILIES = [
  { indicators: SCOPE_INDICATORS, depth: 1 },
  { indicators: NESTED_SCOPE_INDICATORS, depth: 2 },
  { indicators: DEEP_NESTED_SCOPE_INDICATORS, depth: 3 },
];

/** Extract the captured segments when all are present and not in ignored directories. */
function matchScopeSegments(match: RegExpMatchArray | null, depth: number): string[] | null {
  if (match === null) return null;
  const segments: string[] = [];
  for (let index = 1; index <= depth; index += 1) {
    const segment = match[index];
    if (segment === undefined || IGNORED_DIRS.has(segment)) return null;
    segments.push(segment);
  }
  return segments;
}

/**
 * Extract the scope path from a file path.
 * Returns null if the path is not a recognized module indicator or is in an ignored directory.
 */
function extractScopePath(filePath: string): string | null {
  for (const family of SCOPE_INDICATOR_FAMILIES) {
    for (const indicator of family.indicators) {
      const segments = matchScopeSegments(filePath.match(indicator.pattern), family.depth);
      if (segments !== null) return segments.join('/');
    }
  }
  return null;
}

/**
 * Check if evidence originates from within a given scope path.
 */
function isEvidenceInScope(evidence: string[], scopePath: string): boolean {
  for (const ev of evidence) {
    const [evidenceSource = ''] = ev.split(':');
    const evPath = normalizeRepoSignalPath(evidenceSource);
    if (evPath.startsWith(scopePath + '/') || evPath === scopePath) {
      return true;
    }
  }
  return false;
}

/** ReadFile function type. */
type ReadFileFn = (relativePath: string) => Promise<string | undefined>;

/** One detected stack fact inside a scope. */
type ScopeFact = { id: string; kind: DetectedStackTarget; version?: string };

/** A stack fact bound to the manifest file it was extracted from. */
type ScopedFactWithEvidence = ScopeFact & { evidence: string };

/** One projected scoped stack item. */
type ScopedStackItem = {
  kind: DetectedStackTarget;
  id: string;
  version?: string;
  evidence?: string;
};

/** Minimal shape of a nested package.json used for fact extraction. */
interface ParsedPackageJson {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly packageManager?: string;
  readonly engines?: { readonly node?: string };
}

/** Maps one package.json dependency to a detected fact. */
interface PackageDependencyFact {
  readonly dependency: string;
  readonly id: string;
  readonly kind: DetectedStackTarget;
  readonly withVersion: boolean;
}

const PACKAGE_DEPENDENCY_FACTS: readonly PackageDependencyFact[] = [
  { dependency: 'react', id: 'react', kind: 'framework', withVersion: true },
  { dependency: 'react-dom', id: 'react-dom', kind: 'framework', withVersion: true },
  { dependency: 'vue', id: 'vue', kind: 'framework', withVersion: true },
  { dependency: 'next', id: 'next', kind: 'framework', withVersion: true },
  { dependency: '@angular/core', id: 'angular', kind: 'framework', withVersion: false },
  { dependency: 'vite', id: 'vite', kind: 'buildTool', withVersion: false },
  { dependency: 'esbuild', id: 'esbuild', kind: 'tool', withVersion: false },
  { dependency: 'typescript', id: 'typescript', kind: 'language', withVersion: false },
  { dependency: 'jest', id: 'jest', kind: 'testFramework', withVersion: false },
  { dependency: 'vitest', id: 'vitest', kind: 'testFramework', withVersion: false },
  { dependency: 'mocha', id: 'mocha', kind: 'testFramework', withVersion: false },
  { dependency: 'eslint', id: 'eslint', kind: 'qualityTool', withVersion: false },
  { dependency: 'prettier', id: 'prettier', kind: 'qualityTool', withVersion: false },
];

/** Content markers mapped to pom.xml facts; each entry matches any marker. */
const POM_CONTENT_FACTS: ReadonlyArray<{
  readonly id: string;
  readonly kind: DetectedStackTarget;
  readonly needles: readonly string[];
}> = [
  {
    id: 'spring-boot',
    kind: 'framework',
    needles: [
      '<groupId>org.springframework.boot</groupId>',
      '<artifactId>spring-boot</artifactId>',
    ],
  },
  {
    id: 'maven',
    kind: 'buildTool',
    needles: ['<artifactId>maven</artifactId>', '<artifactId>maven-compiler-plugin</artifactId>'],
  },
  {
    id: 'gradle',
    kind: 'buildTool',
    needles: ['<artifactId>gradle</artifactId>', 'gradle.plugin', 'com.github.gradle'],
  },
  { id: 'junit', kind: 'testFramework', needles: ['<artifactId>junit</artifactId>'] },
  { id: 'testng', kind: 'testFramework', needles: ['<artifactId>testng</artifactId>'] },
];

const SPRING_PARENT_PATTERN =
  /<parent>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<version>([^<]+)<\/version>[\s\S]*?<\/parent>/;

function extractNumericVersion(raw: string | undefined): string | undefined {
  return raw?.match(/(\d+(?:\.\d+)*)/)?.[1];
}

function includesAny(content: string, needles: readonly string[]): boolean {
  for (const needle of needles) {
    if (content.includes(needle)) return true;
  }
  return false;
}

function pushNodeRuntimeFact(facts: ScopeFact[], pkg: ParsedPackageJson): void {
  const node = pkg.engines?.node;
  if (!node) return;
  const version = extractNumericVersion(node);
  facts.push({ id: 'node', kind: 'runtime', ...(version !== undefined ? { version } : {}) });
}

function pushPackageDependencyFact(
  facts: ScopeFact[],
  deps: Readonly<Record<string, string>>,
  spec: PackageDependencyFact,
): void {
  const raw = deps[spec.dependency];
  if (!raw) return;
  if (!spec.withVersion) {
    facts.push({ id: spec.id, kind: spec.kind });
    return;
  }
  const version = extractNumericVersion(raw);
  facts.push({ id: spec.id, kind: spec.kind, ...(version !== undefined ? { version } : {}) });
}

function resolvePackageManagerFact(packageManager: string | undefined): ScopeFact | null {
  if (!packageManager) return null;
  const pm = packageManager.replace(/@.*$/, '').toLowerCase();
  if (!['pnpm', 'yarn', 'npm', 'bun'].includes(pm)) return null;
  return { id: pm, kind: 'buildTool' };
}

/**
 * Extract obvious facts from nested package.json content.
 */
function extractFromNestedPackageJson(content: string): ScopeFact[] {
  const facts: ScopeFact[] = [];
  try {
    const pkg: ParsedPackageJson = JSON.parse(content);
    const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
    pushNodeRuntimeFact(facts, pkg);
    for (const spec of PACKAGE_DEPENDENCY_FACTS) {
      pushPackageDependencyFact(facts, deps, spec);
    }
    const managerFact = resolvePackageManagerFact(pkg.packageManager);
    if (managerFact) facts.push(managerFact);
  } catch {
    // Invalid JSON, skip
  }
  return facts;
}

function pushJavaVersionFact(facts: ScopeFact[], content: string): void {
  const match = content.match(/<java\.version>([^<]+)<\/java\.version>/);
  if (!match) return;
  const version = match[1];
  facts.push({ id: 'java', kind: 'language', ...(version !== undefined ? { version } : {}) });
}

function pushSpringParentFact(facts: ScopeFact[], content: string): void {
  const match = content.match(SPRING_PARENT_PATTERN);
  if (!match) return;
  const parentGroupId = match[1];
  const parentArtifactId = match[2];
  const parentVersion = match[3];
  if (
    parentGroupId !== 'org.springframework.boot' &&
    parentArtifactId !== 'spring-boot-starter-parent'
  ) {
    return;
  }
  facts.push({
    id: 'spring-boot',
    kind: 'framework',
    ...(parentVersion !== undefined ? { version: parentVersion } : {}),
  });
}

/**
 * Extract obvious facts from nested pom.xml content.
 */
function extractFromNestedPomXml(content: string): ScopeFact[] {
  const facts: ScopeFact[] = [{ id: 'maven', kind: 'buildTool' }];
  pushJavaVersionFact(facts, content);
  pushSpringParentFact(facts, content);
  if (content.includes('<maven.compiler.source>')) {
    facts.push({ id: 'java', kind: 'language' });
  }
  for (const spec of POM_CONTENT_FACTS) {
    if (includesAny(content, spec.needles)) {
      facts.push({ id: spec.id, kind: spec.kind });
    }
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

/** Compose image names mapped to the database id they indicate. */
const COMPOSE_IMAGE_DATABASE_IDS: Readonly<Record<string, string>> = {
  postgres: 'postgresql',
  postgresql: 'postgresql',
  mysql: 'mysql',
  mongo: 'mongodb',
  mongodb: 'mongodb',
  redis: 'redis',
};

/** Parsed image name and optional numeric version from a compose image reference. */
interface ParsedComposeImage {
  readonly imageName: string;
  readonly version: string | undefined;
}

function parseComposeImageRef(imageRef: string): ParsedComposeImage | null {
  const withoutDigest = imageRef.split('@')[0] ?? imageRef;
  const lastSegment = withoutDigest.split('/').pop()?.toLowerCase();
  if (!lastSegment) return null;

  const [imageName, rawTag] = lastSegment.split(':');
  if (imageName === undefined) return null;

  let version: string | undefined;
  if (rawTag && rawTag !== 'latest' && !rawTag.includes('${')) {
    version = rawTag.match(/^(\d+(?:\.\d+)*)/)?.[1];
  }

  return { imageName, version };
}

/**
 * Extract database facts from nested docker-compose content.
 * Only extracts from explicit image: lines, not from arbitrary text matches.
 */
function extractFromNestedDockerCompose(content: string): ScopeFact[] {
  const facts: ScopeFact[] = [];

  const imageMatches = content.matchAll(/^\s*image\s*:\s*['"]?([^'"\s]+)['"]?/gm);
  for (const match of imageMatches) {
    const imageRef = match[1]?.trim();
    if (!imageRef || imageRef.includes('${')) continue;

    const image = parseComposeImageRef(imageRef);
    if (image === null) continue;

    const databaseId = COMPOSE_IMAGE_DATABASE_IDS[image.imageName];
    if (!databaseId) continue;

    facts.push({
      id: databaseId,
      kind: 'database',
      ...(image.version ? { version: image.version } : {}),
    });
  }

  return facts;
}

/** Matches a manifest path and extracts its nested stack facts from content. */
interface NestedManifestExtractor {
  readonly matches: (normalizedPath: string) => boolean;
  readonly extract: (content: string) => ScopeFact[];
}

function isDockerComposeBasename(normalizedPath: string): boolean {
  return /^docker-compose(?:[.-][a-z0-9_.-]+)?\.ya?ml$/.test(
    normalizedPath.split('/').pop()?.toLowerCase() ?? '',
  );
}

const NESTED_MANIFEST_EXTRACTORS: readonly NestedManifestExtractor[] = [
  { matches: (path) => path.endsWith('/package.json'), extract: extractFromNestedPackageJson },
  { matches: (path) => path.endsWith('/pom.xml'), extract: extractFromNestedPomXml },
  { matches: (path) => path.endsWith('/Cargo.toml'), extract: extractFromNestedCargoToml },
  { matches: (path) => path.endsWith('/pyproject.toml'), extract: extractFromNestedPyprojectToml },
  { matches: isDockerComposeBasename, extract: extractFromNestedDockerCompose },
];

async function readNestedManifestFacts(
  normalizedPath: string,
  readFile: ReadFileFn,
): Promise<ScopeFact[]> {
  const extractor = NESTED_MANIFEST_EXTRACTORS.find((candidate) =>
    candidate.matches(normalizedPath),
  );
  if (extractor === undefined) return [];
  const content = await readFile(normalizedPath);
  if (!content) return [];
  return extractor.extract(content);
}

function appendScopedFacts(
  scopeFacts: Map<string, ScopedFactWithEvidence[]>,
  scopePath: string,
  facts: readonly ScopeFact[],
  evidence: string,
): void {
  let scopedFacts = scopeFacts.get(scopePath);
  if (scopedFacts === undefined) {
    scopedFacts = [];
    scopeFacts.set(scopePath, scopedFacts);
  }
  for (const fact of facts) {
    scopedFacts.push({ ...fact, evidence });
  }
}

/**
 * Detect nested stack facts from manifest files.
 * Returns a map of scope path -> detected facts.
 */
async function detectNestedStackFacts(
  allFiles: readonly string[],
  readFile: ReadFileFn,
): Promise<Map<string, ScopedFactWithEvidence[]>> {
  const scopeFacts = new Map<string, ScopedFactWithEvidence[]>();

  for (const file of allFiles) {
    const normalizedPath = normalizeRepoSignalPath(file);
    const scopePath = extractScopePath(normalizedPath);
    if (!scopePath) continue;

    try {
      const facts = await readNestedManifestFacts(normalizedPath, readFile);
      if (facts.length === 0) continue;
      appendScopedFacts(scopeFacts, scopePath, facts, normalizedPath);
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
    const aKind = kindOrder.indexOf(a.kind);
    const bKind = kindOrder.indexOf(b.kind);
    if (aKind !== bKind) return aKind - bKind;
    return a.id.localeCompare(b.id);
  });

  return sorted.map((item) => (item.version ? `${item.id}=${item.version}` : item.id)).join(', ');
}

/** Detected stack groups the scoped projection reads from. */
interface DetectedStackGroups {
  readonly languages: DetectedItem[];
  readonly frameworks: DetectedItem[];
  readonly buildTools: DetectedItem[];
  readonly testFrameworks: DetectedItem[];
  readonly runtimes: DetectedItem[];
  readonly tools: DetectedItem[];
  readonly qualityTools: DetectedItem[];
  readonly databases: DetectedItem[];
}

/** One stack item paired with its detection category. */
type StackItemWithCategory = { category: DetectedStackTarget; item: DetectedItem };

/** A scoped item draft whose optional fields may be explicitly undefined. */
interface ScopedItemDraft {
  readonly kind: DetectedStackTarget;
  readonly id: string;
  readonly version: string | undefined;
  readonly evidence: string | undefined;
}

function collectScopePaths(allFiles: readonly string[]): Map<string, Set<string>> {
  const scopeMap = new Map<string, Set<string>>();
  for (const file of allFiles) {
    const normalizedPath = normalizeRepoSignalPath(file);
    const scope = extractScopePath(normalizedPath);
    if (!scope) continue;
    const paths = scopeMap.get(scope);
    if (paths) {
      paths.add(normalizedPath);
    } else {
      scopeMap.set(scope, new Set([normalizedPath]));
    }
  }
  return scopeMap;
}

function collectStackItems(stackInfo: DetectedStackGroups): StackItemWithCategory[] {
  const groups: ReadonlyArray<readonly [DetectedStackTarget, readonly DetectedItem[]]> = [
    ['language', stackInfo.languages],
    ['framework', stackInfo.frameworks],
    ['buildTool', stackInfo.buildTools],
    ['testFramework', stackInfo.testFrameworks],
    ['runtime', stackInfo.runtimes],
    ['tool', stackInfo.tools],
    ['qualityTool', stackInfo.qualityTools],
    ['database', stackInfo.databases],
  ];
  const items: StackItemWithCategory[] = [];
  for (const [category, group] of groups) {
    for (const item of group) {
      items.push({ category, item });
    }
  }
  return items;
}

function pushScopedItem(
  target: ScopedStackItem[],
  seen: Set<string>,
  draft: ScopedItemDraft,
): void {
  if (target.length >= MAX_ITEMS_PER_SCOPE) return;
  const key = `${draft.kind}:${draft.id}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push({
    kind: draft.kind,
    id: draft.id,
    ...(draft.version !== undefined ? { version: draft.version } : {}),
    ...(draft.evidence !== undefined ? { evidence: draft.evidence } : {}),
  });
}

function collectScopedItems(
  scopePath: string,
  allItems: ReadonlyArray<StackItemWithCategory>,
  nestedFacts: ReadonlyArray<ScopedFactWithEvidence> | undefined,
): ScopedStackItem[] {
  const scopedItems: ScopedStackItem[] = [];
  const seenItems = new Set<string>();
  for (const { category, item } of allItems) {
    if (!isEvidenceInScope(item.evidence, scopePath)) continue;
    pushScopedItem(scopedItems, seenItems, {
      kind: category,
      id: item.id,
      version: item.version,
      evidence: item.evidence[0],
    });
  }
  if (nestedFacts) {
    for (const fact of nestedFacts) {
      pushScopedItem(scopedItems, seenItems, {
        kind: fact.kind,
        id: fact.id,
        version: fact.version,
        evidence: fact.evidence,
      });
    }
  }
  return scopedItems;
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
  }>
> {
  const scopeMap = collectScopePaths(allFiles);

  // Detect nested manifest facts if readFile is available
  let nestedFacts = new Map<string, ScopedFactWithEvidence[]>();
  if (readFile) {
    nestedFacts = await detectNestedStackFacts(allFiles, readFile);
  }

  const allItems = collectStackItems(stackInfo);
  const scopedResults: Array<{ path: string; summary: string; items: ScopedStackItem[] }> = [];
  const scopePaths = Array.from(scopeMap.keys()).sort();

  for (const scopePath of scopePaths) {
    if (scopedResults.length >= MAX_SCOPES) break;
    const scopedItems = collectScopedItems(scopePath, allItems, nestedFacts.get(scopePath));
    if (scopedItems.length > 0) {
      scopedResults.push({
        path: scopePath,
        summary: generateSummary(scopedItems),
        items: scopedItems,
      });
    }
  }

  return scopedResults;
}
