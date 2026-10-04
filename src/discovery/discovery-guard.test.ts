/**
 * @module discovery/discovery-guard
 * @description Guard preventing restoration of removed validation hint symbols.
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

function scanFile(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
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
  it('no production file imports or accesses removed validationHints symbols', () => {
    const allFiles = collectSourceFiles(PROJECT_ROOT);
    const violations: string[] = [];

    for (const absPath of allFiles) {
      const relPath = path.relative(PROJECT_ROOT, absPath);
      if (relPath === path.normalize('src/discovery/discovery-guard.test.ts')) continue;
      if (relPath.endsWith('.test.ts')) continue;

      const fileViolations = scanFile(absPath);
      violations.push(...fileViolations);
    }

    expect(violations).toEqual([]);
  });
});
