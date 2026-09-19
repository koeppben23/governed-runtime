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
import {
  extractScopePath,
  readNestedManifestFacts,
  type ReadFileFn,
  type ScopeFact,
  type ScopedFactWithEvidence,
} from './scoped-stack-extractors.js';

/** Maximum number of scopes to return (budget limit). */
const MAX_SCOPES = 20;

/** Maximum number of items per scope (budget limit). */
const MAX_ITEMS_PER_SCOPE = 25;

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

/** One projected scoped stack item. */
type ScopedStackItem = {
  kind: DetectedStackTarget;
  id: string;
  version?: string;
  evidence?: string;
};

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
