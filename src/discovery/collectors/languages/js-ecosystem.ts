/**
 * @module discovery/collectors/languages/js-ecosystem
 * @description js ecosystem ecosystem detection — extracted from stack-detection.ts.
 * @version v1
 */

import type { DetectedItem } from '../../types.js';
import type { ReadFileFn } from '../stack-detection-utils.js';
import {
  safeRead,
  findItem,
  setVersion,
  captureGroup,
  enrichOrCreateItem,
} from '../stack-detection-utils.js';
import { enrichDatabaseItem, setCompilerTarget } from '../stack-detection-utils.js';
import { enrichRuntimeVersion } from './java.js';
import { getRootBasename } from '../../repo-paths.js';
import {
  PACKAGE_MANAGER_RE,
  JS_ECOSYSTEM_DEPS,
  JS_DATABASE_DEPS,
} from '../stack-detection-rules.js';
import { LOCKFILE_RULES } from '../stack-detection-rules.js';

export async function refineFromPackageManagerField(
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
export function refineBuildToolFromLockfiles(
  allFiles: readonly string[],
  buildTools: DetectedItem[],
): void {
  const npmIndex = buildTools.findIndex((t) => t.id === 'npm');
  if (npmIndex === -1) return; // No npm build tool to refine

  // Root-level files only (normalized, cross-platform)
  const rootFiles = new Set<string>();
  for (const filePath of allFiles) {
    const rootBase = getRootBasename(filePath);
    if (rootBase) rootFiles.add(rootBase);
  }

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
export async function extractFromPackageJson(
  readFile: ReadFileFn,
  languages: DetectedItem[],
  frameworks: DetectedItem[],
  runtimes: DetectedItem[],
  testFrameworks: DetectedItem[],
  qualityTools: DetectedItem[],
  databases: DetectedItem[],
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

  // Database engine detection from dependencies/devDependencies (version intentionally omitted).
  for (const rule of JS_DATABASE_DEPS) {
    const inDeps = deps?.[rule.pkg] !== undefined;
    const inDevDeps = devDeps?.[rule.pkg] !== undefined;
    if (!inDeps && !inDevDeps) continue;

    const sourceKey = inDeps ? 'dependencies' : 'devDependencies';
    enrichDatabaseItem(databases, rule.id, `package.json:${sourceKey}.${rule.pkg}`);
  }
}
export async function extractFromTsConfig(
  readFile: ReadFileFn,
  languages: DetectedItem[],
): Promise<void> {
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
