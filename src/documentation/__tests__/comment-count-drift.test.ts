/**
 * @module documentation/__tests__/comment-count-drift
 * @description Prevents reintroduction of stale hardcoded numeric counts in
 *              source-code comments and test names. After the clean-up in this
 *              branch, no comment should claim an exact number of tools, phases,
 *              or commands — the live code is the authority.
 *
 * This test scans all .ts files for stale-count patterns. If a future
 * developer adds a comment like "all 12 tools" without updating this
 * test, the build fails.
 *
 * @test-policy HAPPY, BAD — both categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

// ─── Helpers ───────────────────────────────────────────────────────────────────

function walkTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      files.push(...walkTsFiles(full));
    } else if (entry.isFile() && (extname(entry.name) === '.ts' || extname(entry.name) === '.tsx')) {
      files.push(full);
    }
  }
  return files;
}

function readRel(file: string): string {
  return readFileSync(file, 'utf-8');
}

// ─── Stale-count patterns (derived from the patterns we cleaned up) ────────────

/**
 * Patterns that claim an exact count of FlowGuard tools/commands in comments.
 * These are stale-by-construction — only the live registries are authoritative.
 *
 * Exceptions (allowlist):
 * - 'all 4' in `profile.ts` (the built-in profile count assertion is tested)
 * - product-inventory.ts itself (it IS the SSOT for counts)
 * - product-inventory.test.ts (the test that verifies counts)
 * - Testing strategy docs referencing stryker counts
 */
const STALE_COUNT_PATTERNS = [
  /\ball \d+ FlowGuard\b/,
  /\bexposes all \d+\b.*\bFlowGuard\b/,
  /\bRegisters all \d+\b.*\bFlowGuard\b/,
  /\ball \d+ tools exported\b/i,
  /\ball \d+ tools are importable\b/i,
  /\breturns all \d+ tools\b/i,
  /\breturns all \d+ FlowGuard\b/,
];

const ALLOWLISTED_FILES = new Set([
  'src/shared/product-inventory.ts',
  'src/documentation/__tests__/product-inventory.test.ts',
  'src/documentation/__tests__/comment-count-drift.test.ts',
]);

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('source-code comment drift prevention', () => {
  const allFiles = walkTsFiles(join(REPO_ROOT, 'src'));

  it('no source file contains stale hardcoded FlowGuard tool/command counts', () => {
    const violations: string[] = [];

    for (const file of allFiles) {
      const rel = file.slice(REPO_ROOT.length + 1);
      if (ALLOWLISTED_FILES.has(rel)) continue;

      const content = readRel(file);

      for (const pattern of STALE_COUNT_PATTERNS) {
        const match = content.match(pattern);
        if (match) {
          const line = content.slice(0, match.index!).split('\n').length;
          violations.push(
            `${rel}:${line}: "${match[0]}" matches stale-count pattern`,
          );
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} stale hardcoded count(s) in source comments.\n` +
        'Remove or update the comment — use PRODUCT_INVENTORY for canonical counts.\n' +
        violations.join('\n'),
    ).toHaveLength(0);
  });

  it('no newly-stale counts were overlooked in known-stale files', () => {
    // These files were cleaned up in this branch. Verify the clean-up is
    // complete by checking they still contain no stale patterns.
    const guardFiles = [
      'src/mcp-server/server.ts',
      'src/mcp-server/index.ts',
      'src/mcp-server/tool-adapter.ts',
      'src/integration/tools.test.ts',
    ];

    for (const rel of guardFiles) {
      const content = readRel(join(REPO_ROOT, rel));
      for (const pattern of STALE_COUNT_PATTERNS) {
        expect(content.match(pattern)).toBeNull();
      }
    }
  });
});
