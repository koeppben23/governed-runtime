/**
 * @module documentation/__tests__/markdown-code-blocks
 * @description Markdown fenced-code-block syntax guard.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
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

const ALLOWED_LANGUAGES = new Set([
  '',
  'bash',
  'console',
  'json',
  'jsonc',
  'markdown',
  'mermaid',
  'sh',
  'text',
  'ts',
  'typescript',
  'yaml',
  'yml',
]);

type CodeBlock = Readonly<{
  file: string;
  startLine: number;
  language: string;
  body: string;
}>;

function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) files.push(...collectMarkdownFiles(absPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(absPath);
    }
  }
  return files.sort();
}

function extractCodeBlocks(file: string): { blocks: CodeBlock[]; errors: string[] } {
  const lines = readFileSync(file, 'utf-8').split('\n');
  const blocks: CodeBlock[] = [];
  const errors: string[] = [];
  let current: { startLine: number; language: string; body: string[] } | undefined;

  lines.forEach((line, index) => {
    const fence = line.match(/^```\s*([^`]*)\s*$/);
    if (!fence) {
      current?.body.push(line);
      return;
    }

    if (current === undefined) {
      current = { startLine: index + 1, language: fence[1].trim(), body: [] };
      return;
    }

    blocks.push({
      file,
      startLine: current.startLine,
      language: current.language,
      body: current.body.join('\n'),
    });
    current = undefined;
  });

  if (current !== undefined) {
    errors.push(`${file}:${current.startLine} has an unclosed fenced code block`);
  }

  return { blocks, errors };
}

describe('documentation/markdown-code-blocks', () => {
  const markdownFiles = collectMarkdownFiles(REPO_ROOT);

  describe('HAPPY — fences are discoverable', () => {
    it('finds Markdown files to check', () => {
      expect(markdownFiles.length).toBeGreaterThan(10);
    });
  });

  describe('BAD — fenced blocks must close', () => {
    it('has no unclosed fenced code blocks', () => {
      const errors = markdownFiles.flatMap((file) => extractCodeBlocks(file).errors);
      expect(errors).toEqual([]);
    });
  });

  describe('CORNER — language tags stay intentional', () => {
    it('uses only known code-fence language tags', () => {
      const unknownLanguages = markdownFiles.flatMap((file) =>
        extractCodeBlocks(file)
          .blocks.filter((block) => !ALLOWED_LANGUAGES.has(block.language))
          .map(
            (block) => `${block.file}:${block.startLine} uses unknown language "${block.language}"`,
          ),
      );

      expect(unknownLanguages).toEqual([]);
    });
  });

  describe('EDGE — JSON examples are parseable JSON', () => {
    it('all json fenced code blocks parse with JSON.parse', () => {
      const invalidJsonBlocks: string[] = [];

      for (const file of markdownFiles) {
        for (const block of extractCodeBlocks(file).blocks) {
          if (block.language !== 'json') continue;
          try {
            JSON.parse(block.body);
          } catch (error) {
            invalidJsonBlocks.push(`${block.file}:${block.startLine} ${String(error)}`);
          }
        }
      }

      expect(invalidJsonBlocks).toEqual([]);
    });
  });
});
