/**
 * @module discovery/discovery-guard
 * @description Allowlist-based import guard preventing consumption of deprecated
 * `validationHints` symbols outside the discovery module.
 *
 * The guard scans all source files and fails if any file outside the
 * file-level allowlist imports or accesses ValidationHints, ValidationHintsSchema,
 * CommandHint, CommandHintSchema, or .validationHints.
 *
 * verificationCandidates from planVerificationCandidates() is the canonical
 * advisory verification source.
 *
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const DEPRECATED_SYMBOLS = [
  'ValidationHints',
  'ValidationHintsSchema',
  'CommandHint',
  'CommandHintSchema',
];

const DEPRECATED_FIELD_PATTERN = /\bvalidationHints\b/;

const ALLOWLIST = new Set([
  path.normalize('src/discovery/types.ts'),
  path.normalize('src/discovery/orchestrator.ts'),
  path.normalize('src/discovery/discovery-digest.ts'),
  // Shared test fixture: keeps the deprecated DiscoveryResult field in the
  // discovery authority layer instead of duplicating it in downstream tests.
  path.normalize('src/discovery/discovery-test-fixtures.ts'),
  path.normalize('src/discovery/discovery-guard.test.ts'),
]);

function isAllowlisted(filePath: string): boolean {
  const normalized = path.normalize(filePath);
  if (ALLOWLIST.has(normalized)) return true;
  if (normalized.includes(`${path.sep}discovery${path.sep}`) && normalized.endsWith('.test.ts')) {
    return true;
  }
  return false;
}

function scanFile(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/**')) {
      continue;
    }

    for (const sym of DEPRECATED_SYMBOLS) {
      if (line.includes(sym)) {
        violations.push(`  ${filePath}:${i + 1}: ${trimmed}`);
        break;
      }
    }

    if (DEPRECATED_FIELD_PATTERN.test(line)) {
      violations.push(`  ${filePath}:${i + 1}: ${trimmed}`);
    }
  }

  return violations;
}

function collectSourceFiles(root: string): string[] {
  const results: string[] = [];
  const srcDir = path.join(root, 'src');

  function walk(dir: string) {
    if (dir.includes('node_modules') || dir.includes('dist')) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && full.endsWith('.ts')) {
        results.push(full);
      }
    }
  }

  walk(srcDir);
  return results;
}

describe('discovery-guard', () => {
  it('no file outside the allowlist imports or accesses deprecated validationHints symbols', () => {
    const allFiles = collectSourceFiles(PROJECT_ROOT);
    const violations: string[] = [];

    for (const absPath of allFiles) {
      const relPath = path.relative(PROJECT_ROOT, absPath);
      if (isAllowlisted(relPath)) continue;

      const fileViolations = scanFile(absPath);
      violations.push(...fileViolations);
    }

    expect(violations).toEqual([]);
  });
});
