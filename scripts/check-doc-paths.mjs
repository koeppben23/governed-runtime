/**
 * Documentation path checker.
 *
 * Developer documentation refers to repository artifacts as inline code
 * (`src/...`, `scripts/...`, `docs/...`, `.github/...`, root files). Renames
 * and deletions silently rot those references; Markdown link checks only cover
 * `[text](target)` syntax. This checker extracts inline-code path references
 * from the developer documents that are governed by review, verifies that each
 * target exists, and ignores everything that is not a concrete repository path
 * (globs, placeholders, URLs, fenced code blocks, illustrative prose).
 *
 * Scope: `docs/development/**`, `CONTRIBUTING.md`, `docs/testing-strategy.md`,
 * and every `AGENTS.md` (root and under `src/`). Historical ledgers
 * (`CHANGELOG.md`, `KNOWN_ISSUES.md`), demos, evals, and test fixtures are
 * intentionally out of scope.
 *
 * Usage:
 *   node scripts/check-doc-paths.mjs
 *
 * The module exports its pure functions so tests can inject a repository root
 * and an existence predicate; importing it never runs the CLI.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const SCOPE_FILES = ['AGENTS.md', 'CONTRIBUTING.md', 'docs/testing-strategy.md'];
const SCOPE_DIRS = ['docs/development', 'src'];
const WALKED_AGENT_DIRS = new Set(['node_modules', '__tests__', '__fixtures__']);
const PATH_PREFIXES = ['src/', 'scripts/', 'docs/', 'test/', '.github/'];
const ROOT_FILES = new Set([
  'AGENTS.md',
  'CONTRIBUTING.md',
  'README.md',
  'SECURITY.md',
  'PRODUCT_IDENTITY.md',
  'package.json',
]);
const GLOB_OR_PLACEHOLDER = /[*?{}<>[\]]/;
const URL_PATTERN = /:\/\//;
const LINE_SUFFIX = /:\d+(?:-\d+)?$/;
const SYMBOL_SUFFIX = /:[A-Za-z_$][\w$]*\(\)$/;
const FENCED_BLOCK = /^ {0,3}```[\s\S]*?^ {0,3}```[ \t]*$/gm;
const INLINE_CODE = /`([^`\n]+)`/g;

/** Blank fenced blocks while keeping line numbers stable. */
function maskFencedBlocks(markdown) {
  return markdown.replace(FENCED_BLOCK, (block) => block.replace(/[^\n]/g, ' '));
}

/** Strip `:symbol()`, `:line`, and `:start-end` citations from a reference. */
export function normalizeReferencePath(token) {
  let value = token;
  for (;;) {
    const stripped = value.replace(SYMBOL_SUFFIX, '').replace(LINE_SUFFIX, '');
    if (stripped === value) break;
    value = stripped;
  }
  return value.replace(/[.,;:]+$/, '');
}

function looksLikeRepoPath(token) {
  if (token.length === 0 || /\s/.test(token) || URL_PATTERN.test(token)) return false;
  if (GLOB_OR_PLACEHOLDER.test(token)) return false;
  if (token.startsWith('./') || token.startsWith('../') || token.startsWith('/')) return false;
  const normalized = normalizeReferencePath(token);
  return (
    PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix)) || ROOT_FILES.has(normalized)
  );
}

/** Extract repository path references from inline code, with 1-based lines. */
export function extractPathReferences(markdown) {
  const masked = maskFencedBlocks(markdown);
  const references = [];
  for (const match of masked.matchAll(INLINE_CODE)) {
    const token = match[1].trim();
    if (!looksLikeRepoPath(token)) continue;
    references.push({
      token,
      path: normalizeReferencePath(token),
      line: masked.slice(0, match.index).split('\n').length,
    });
  }
  return references;
}

/** Report every inline-code path reference that does not exist. */
export function findMissingPathReferences({
  docs,
  repoRoot = REPO_ROOT,
  exists = (absolutePath) => existsSync(absolutePath),
}) {
  const missing = [];
  for (const doc of docs) {
    for (const reference of extractPathReferences(doc.content)) {
      if (!exists(resolve(repoRoot, reference.path))) {
        missing.push({ doc: doc.path, ...reference });
      }
    }
  }
  return missing;
}

function walkMarkdownFiles(root, directory, documents, read, list) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return;
  for (const entry of list(absolute, { withFileTypes: true })) {
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (WALKED_AGENT_DIRS.has(entry.name)) continue;
      walkMarkdownFiles(root, relativePath, documents, read, list);
      continue;
    }
    if (
      entry.name === 'AGENTS.md' ||
      (directory === 'docs/development' && entry.name.endsWith('.md'))
    ) {
      documents.push({ path: relativePath, content: read(join(root, relativePath), 'utf8') });
    }
  }
}

/** Collect the governed documents (paths plus contents). */
export function collectScopeDocuments({
  repoRoot = REPO_ROOT,
  read = (path) => readFileSync(path, 'utf8'),
  list = readdirSync,
} = {}) {
  const documents = [];
  for (const relativePath of SCOPE_FILES) {
    documents.push({ path: relativePath, content: read(join(repoRoot, relativePath)) });
  }
  for (const directory of SCOPE_DIRS) {
    walkMarkdownFiles(repoRoot, directory, documents, read, list);
  }
  return documents;
}

export function runCli({ repoRoot = REPO_ROOT, log = console.log, error = console.error } = {}) {
  const documents = collectScopeDocuments({ repoRoot });
  const missing = findMissingPathReferences({ docs: documents, repoRoot });
  if (missing.length > 0) {
    error(`[check-doc-paths] ${missing.length} documented path(s) do not exist:`);
    for (const entry of missing) {
      error(`  - ${entry.doc}:${entry.line}: '${entry.token}' (${entry.path})`);
    }
    return 1;
  }
  const references = documents.reduce(
    (total, doc) => total + extractPathReferences(doc.content).length,
    0,
  );
  log(`[check-doc-paths] ${documents.length} document(s), ${references} reference(s) OK`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli());
}
