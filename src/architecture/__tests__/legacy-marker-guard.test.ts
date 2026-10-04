/**
 * @module architecture/legacy-marker-guard
 * @description Whole-tree fitness function for the repository rule "No Legacy
 * Compatibility in FlowGuard Source" (AGENTS.md).
 *
 * The claim is about the resulting repository tree, not about one pull-request
 * diff: every production file under `src/` is scanned on every run. This
 * replaces the former diff-only `scripts/check-legacy-compatibility.mjs` so a
 * compatibility path cannot survive by having been introduced earlier.
 *
 * Tests, fixtures, and comment-only prose are intentionally outside the guard.
 * Product templates are production authority and therefore remain inside it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeRepoPath, repoRelative } from './repo-path.js';

const SRC = join(process.cwd(), 'src');

const EXCLUDED_PATH_PARTS = [
  '/__tests__/',
  '/test/',
  '/tests/',
  '/testing/',
  '/testdata/',
  '/fixtures/',
];
const EXCLUDED_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const LEGACY_MARKERS = [
  /\bbackwards? compatibility\b/giu,
  /\blegacy compatibility\b/giu,
  /\blegacy[- ]tolerant\b/giu,
  /\bcompatibility (?:shim|alias|fallback|adapter|re-export|projection|entry point)\b/giu,
  /\b(?:retained|kept|re-exported|re-exports?) for compatibility\b/giu,
];

function productionFlowGuardFiles(directory: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      results.push(...productionFlowGuardFiles(full));
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/u.test(entry)) continue;
    if (EXCLUDED_FILE_PATTERN.test(entry)) continue;
    const normalized = normalizeRepoPath(full);
    if (EXCLUDED_PATH_PARTS.some((part) => normalized.includes(part))) continue;
    results.push(full);
  }
  return results;
}

function relative(path: string): string {
  return repoRelative(SRC, path);
}

function isCommentOnlyMatch(content: string, index: number): boolean {
  const lineStart = content.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const prefix = content.slice(lineStart, index).trimStart();
  return prefix.startsWith('//') || prefix.startsWith('/*') || prefix.startsWith('*');
}

describe('legacy-free production tree', () => {
  it('detects non-comment markers and tolerates comment-only prose', () => {
    const detect = (content: string): string[] => {
      const findings: string[] = [];
      for (const marker of LEGACY_MARKERS) {
        for (const match of content.matchAll(marker)) {
          const index = match.index ?? 0;
          if (isCommentOnlyMatch(content, index)) continue;
          findings.push(match[0]);
        }
      }
      return findings;
    };

    expect(detect('const legacyShim = "backward compatibility";')).toEqual([
      'backward compatibility',
    ]);
    expect(detect('// backward compatibility\nconst legacyShim = 1;')).toEqual([]);
  });

  it('contains no explicit legacy/backward-compatibility implementation markers', () => {
    const files = productionFlowGuardFiles(SRC);
    // A silently empty scan would make this guard vacuous.
    expect(files.length).toBeGreaterThan(200);

    const findings: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const marker of LEGACY_MARKERS) {
        for (const match of content.matchAll(marker)) {
          const index = match.index ?? 0;
          if (isCommentOnlyMatch(content, index)) continue;
          const line = content.slice(0, index).split('\n').length;
          findings.push(`${relative(file)}:${line}: ${JSON.stringify(match[0])}`);
        }
      }
    }

    expect(findings, findings.join('\n')).toEqual([]);
  });
});
