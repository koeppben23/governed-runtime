/**
 * @module architecture-boundary.test
 * @description Architecture boundary tests for FlowGuard layer enforcement.
 *
 * P2d: Ensures that inner layers (state/, machine/) do not depend on
 * outer layers (discovery/, integration/, adapters/).
 *
 * These tests scan import statements in source files to detect violations.
 * Test files (*.test.ts) are excluded — test coupling is acceptable,
 * production code coupling is not.
 *
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_DIR = path.resolve(import.meta.dirname, '.');

/**
 * Recursively collect all .ts files in a directory, excluding test files.
 */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract import paths from a TypeScript source file.
 * Returns array of { line, importPath } for all import statements.
 */
function extractImports(filePath: string): Array<{ line: number; importPath: string }> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const imports: Array<{ line: number; importPath: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]?.match(/(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]/);
    if (match?.[1]) {
      imports.push({ line: i + 1, importPath: match[1] });
    }
  }

  return imports;
}

/**
 * Check if an import path refers to a forbidden layer.
 * Only checks relative imports (starting with './' or '../').
 */
function resolvesToForbiddenLayer(
  filePath: string,
  importPath: string,
  forbiddenLayers: string[],
): string | null {
  if (!importPath.startsWith('.')) return null; // external package — allowed

  const dir = path.dirname(filePath);
  const resolved = path.resolve(dir, importPath.replace(/\.js$/, '.ts'));
  const relative = path.relative(SRC_DIR, resolved).replace(/\\/g, '/');

  for (const layer of forbiddenLayers) {
    if (relative.startsWith(layer + '/') || relative === layer) {
      return layer;
    }
  }
  return null;
}

describe('Architecture Boundaries', () => {
  describe('state/ must not import from outer layers', () => {
    const forbidden = ['discovery', 'integration', 'adapters'];
    const stateDir = path.join(SRC_DIR, 'state');
    const sourceFiles = collectSourceFiles(stateDir);

    it('has source files to check', () => {
      expect(sourceFiles.length).toBeGreaterThan(0);
    });

    for (const file of sourceFiles) {
      const relPath = path.relative(SRC_DIR, file).replace(/\\/g, '/');

      it(`${relPath} has no forbidden imports`, () => {
        const imports = extractImports(file);
        const violations: string[] = [];

        for (const imp of imports) {
          const layer = resolvesToForbiddenLayer(file, imp.importPath, forbidden);
          if (layer) {
            violations.push(`line ${imp.line}: imports from '${layer}/' — ${imp.importPath}`);
          }
        }

        expect(violations, `Forbidden imports in ${relPath}:\n${violations.join('\n')}`).toEqual(
          [],
        );
      });
    }
  });

  describe('machine/ must not import from outer layers', () => {
    const forbidden = ['discovery', 'integration', 'adapters'];
    const machineDir = path.join(SRC_DIR, 'machine');
    const sourceFiles = collectSourceFiles(machineDir);

    it('has source files to check', () => {
      expect(sourceFiles.length).toBeGreaterThan(0);
    });

    for (const file of sourceFiles) {
      const relPath = path.relative(SRC_DIR, file).replace(/\\/g, '/');

      it(`${relPath} has no forbidden imports`, () => {
        const imports = extractImports(file);
        const violations: string[] = [];

        for (const imp of imports) {
          const layer = resolvesToForbiddenLayer(file, imp.importPath, forbidden);
          if (layer) {
            violations.push(`line ${imp.line}: imports from '${layer}/' — ${imp.importPath}`);
          }
        }

        expect(violations, `Forbidden imports in ${relPath}:\n${violations.join('\n')}`).toEqual(
          [],
        );
      });
    }
  });

  describe('rails/ must not import from integration/ or adapters/', () => {
    const forbidden = ['integration', 'adapters'];
    const railsDir = path.join(SRC_DIR, 'rails');
    const sourceFiles = collectSourceFiles(railsDir);

    it('has source files to check', () => {
      expect(sourceFiles.length).toBeGreaterThan(0);
    });

    for (const file of sourceFiles) {
      const relPath = path.relative(SRC_DIR, file).replace(/\\/g, '/');

      it(`${relPath} has no forbidden imports`, () => {
        const imports = extractImports(file);
        const violations: string[] = [];

        for (const imp of imports) {
          const layer = resolvesToForbiddenLayer(file, imp.importPath, forbidden);
          if (layer) {
            violations.push(`line ${imp.line}: imports from '${layer}/' — ${imp.importPath}`);
          }
        }

        expect(violations, `Forbidden imports in ${relPath}:\n${violations.join('\n')}`).toEqual(
          [],
        );
      });
    }
  });
});
