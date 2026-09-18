/**
 * @module architecture/production-source
 * @description Single scanner for production source files under `src/`.
 *
 * Architecture guards must agree on what "production source" means. This module
 * is the operational counterpart of the semantic classification authority
 * `isTestSourcePath` (`module-classification.ts`): it walks `src/`, skips
 * `node_modules`, and excludes every path the classifier marks as test code.
 * Guards that scan production source import this instead of re-implementing the
 * walk or inventing local `*.test.ts` / `__tests__` rules.
 *
 * Non-`.ts` files are out of scope: all FlowGuard production source is TypeScript.
 *
 * @version v1
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { isTestSourcePath } from './module-classification.js';

/** A production `.ts` file with its path relative to `src/`. */
export interface ProductionSourceFile {
  readonly rel: string;
  readonly content: string;
}

/** Collect every production `.ts` file under `srcRoot` in deterministic walk order. */
export function collectProductionSources(srcRoot: string): ProductionSourceFile[] {
  const files: ProductionSourceFile[] = [];
  const walk = (absoluteDir: string): void => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const rel = relative(srcRoot, full).split(sep).join('/');
      if (isTestSourcePath(rel)) continue;
      files.push({ rel, content: readFileSync(full, 'utf8') });
    }
  };
  walk(srcRoot);
  return files;
}
