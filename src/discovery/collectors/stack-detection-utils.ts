/**
 * @module discovery/collectors/stack-detection-utils
 * @description Shared detection utilities — no dependencies on collectors or language modules.
 * Breaks the circular dependency between stack-detection.ts and languages/java.ts.
 * @version v1
 */

import type { DetectedItem } from '../types.js';
import { getRootBasename } from '../repo-paths.js';
import { type ArtifactCategory, DOCKER_IMAGE_DATABASES } from './stack-detection-rules.js';

export type ReadFileFn = (relativePath: string) => Promise<string | undefined>;

export async function safeRead(
  readFile: ReadFileFn,
  relativePath: string,
): Promise<string | undefined> {
  try {
    return await readFile(relativePath);
  } catch {
    return undefined;
  }
}

export function setVersion(item: DetectedItem, version: string, evidence: string): void {
  item.version = version;
  item.versionEvidence = evidence;
}

export function captureGroup(
  match: RegExpMatchArray | null,
  group: number = 1,
): string | undefined {
  return match?.[group] ?? undefined;
}

export function findItem(items: DetectedItem[], id: string): DetectedItem | undefined {
  return items.find((i) => i.id === id);
}

export function resolveTargetArray(
  category: ArtifactCategory,
  testFrameworks: DetectedItem[],
  tools: DetectedItem[],
  qualityTools: DetectedItem[],
  databases: DetectedItem[],
): DetectedItem[] {
  switch (category) {
    case 'tool':
      return tools;
    case 'testFramework':
      return testFrameworks;
    case 'qualityTool':
      return qualityTools;
    case 'database':
      return databases;
  }
}

export function enrichDetectedItem(
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

export function enrichDatabaseItem(
  databases: DetectedItem[],
  id: string,
  evidence: string,
  version?: string,
): void {
  const existing = findItem(databases, id);
  if (!existing) {
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
    databases.push(item);
    return;
  }

  if (!existing.evidence.includes(evidence)) {
    existing.evidence.push(evidence);
  }

  if (!existing.version && version) {
    existing.version = version;
    existing.versionEvidence = evidence;
  }
}

export function mapComposeImageToDatabase(
  imageRef: string,
): { id: string; version?: string } | null {
  const normalized = imageRef.toLowerCase();

  // Conservative: skip interpolated tags/references
  if (normalized.includes('${')) {
    return null;
  }

  // SQL Server images often use mcr.microsoft.com/mssql/server:...
  if (normalized.includes('mssql/server')) {
    const version = extractComposeTagVersion(imageRef, { allowRegistryVersion: false });
    return {
      id: 'sqlserver',
      ...(version ? { version } : {}),
    };
  }

  const withoutDigest = imageRef.split('@')[0] ?? imageRef;
  const hadRegistryPath = withoutDigest.includes('/');
  const lastSegment = (withoutDigest.split('/').pop() ?? '').toLowerCase();
  if (!lastSegment) return null;

  const [imageName] = lastSegment.split(':');
  const mapped = DOCKER_IMAGE_DATABASES.find((rule) => rule.image === imageName);
  if (!mapped) return null;

  const version = extractComposeTagVersion(imageRef, { allowRegistryVersion: !hadRegistryPath });
  return {
    id: mapped.id,
    ...(version ? { version } : {}),
  };
}

export function extractComposeTagVersion(
  imageRef: string,
  options: { allowRegistryVersion: boolean },
): string | undefined {
  const withoutDigest = imageRef.split('@')[0] ?? imageRef;
  const lastSegment = withoutDigest.split('/').pop() ?? '';
  const tag = lastSegment.includes(':') ? (lastSegment.split(':')[1] ?? '') : '';
  if (!tag || tag === 'latest' || tag.includes('${')) return undefined;

  // Conservative: for registry-prefixed images, do not trust tag version.
  if (!options.allowRegistryVersion && withoutDigest.includes('/')) {
    return undefined;
  }

  const version = captureGroup(tag.match(/^(\d+(?:\.\d+)*)/));
  return version;
}

export function setCompilerTarget(item: DetectedItem, target: string, evidence: string): void {
  item.compilerTarget = target;
  item.compilerTargetEvidence = evidence;
}

export function enrichOrCreateItem(
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

export function collectRootBasenames(allFiles: readonly string[]): Set<string> {
  const rootFiles = new Set<string>();
  for (const filePath of allFiles) {
    const base = getRootBasename(filePath);
    if (base) rootFiles.add(base);
  }
  return rootFiles;
}
