/**
 * @module documentation/__tests__/full-repo-links
 * @description Full-repository Markdown relative-link checker.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const IGNORED_DIRS = new Set([
  '.git',
  '.opencode',
  'coverage',
  'dist',
  'node_modules',
  'sessions',
  'tmp',
  'vendor',
]);

type MarkdownLink = Readonly<{
  source: string;
  line: number;
  target: string;
}>;

function collectMarkdownFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        files.push(...collectMarkdownFiles(absPath));
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(absPath);
    }
  }

  return files.sort();
}

function isExternalLink(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function stripFragmentAndQuery(target: string): string {
  return target.split('#')[0]!.split('?')[0]!;
}

function extractMarkdownLinks(filePath: string): MarkdownLink[] {
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  const links: MarkdownLink[] = [];

  lines.forEach((line, index) => {
    for (const match of line.matchAll(/(?<!!)[^[]*\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].trim();
      if (target.length > 0) {
        links.push({ source: filePath, line: index + 1, target });
      }
    }
  });

  return links;
}

describe('documentation/full-repo-links', () => {
  describe('HAPPY — markdown files are discoverable', () => {
    it('collects committed Markdown documentation candidates', () => {
      expect(collectMarkdownFiles(REPO_ROOT).length).toBeGreaterThan(10);
    });
  });

  describe('BAD — relative file links cannot be broken', () => {
    it('all local Markdown links resolve to existing files or directories', () => {
      const brokenLinks: string[] = [];

      for (const file of collectMarkdownFiles(REPO_ROOT)) {
        for (const link of extractMarkdownLinks(file)) {
          if (link.target.startsWith('#') || isExternalLink(link.target)) {
            continue;
          }

          const targetWithoutFragment = stripFragmentAndQuery(link.target);
          if (targetWithoutFragment.length === 0) {
            continue;
          }

          const resolvedTarget = resolve(dirname(link.source), targetWithoutFragment);
          if (!existsSync(resolvedTarget)) {
            brokenLinks.push(`${link.source}:${link.line} -> ${link.target}`);
          }
        }
      }

      expect(brokenLinks).toEqual([]);
    });
  });

  describe('CORNER — anchors and external links are not treated as files', () => {
    it('accepts same-file anchors and URL schemes', () => {
      expect(stripFragmentAndQuery('#local-anchor')).toBe('');
      expect(stripFragmentAndQuery('./docs/index.md#installation')).toBe('./docs/index.md');
      expect(isExternalLink('https://example.com')).toBe(true);
      expect(isExternalLink('mailto:security@example.com')).toBe(true);
    });
  });

  describe('EDGE — resolved targets stay inside known filesystem entries', () => {
    it('resolved markdown file targets are files or directories', () => {
      const invalidTargets: string[] = [];

      for (const file of collectMarkdownFiles(REPO_ROOT)) {
        for (const link of extractMarkdownLinks(file)) {
          if (link.target.startsWith('#') || isExternalLink(link.target)) continue;
          const targetWithoutFragment = stripFragmentAndQuery(link.target);
          if (targetWithoutFragment.length === 0) continue;

          const resolvedTarget = resolve(dirname(link.source), targetWithoutFragment);
          if (existsSync(resolvedTarget)) {
            const stat = statSync(resolvedTarget);
            if (!stat.isFile() && !stat.isDirectory()) {
              invalidTargets.push(`${link.source}:${link.line} -> ${link.target}`);
            }
          }
        }
      }

      expect(invalidTargets).toEqual([]);
    });
  });
});
