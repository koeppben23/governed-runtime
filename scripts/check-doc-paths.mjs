/**
 * Documentation reference checker.
 *
 * Developer documentation refers to repository artifacts as inline code
 * (`src/...`, `scripts/...`, `docs/...`, `.github/...`, root files), often with
 * a symbol citation (`file.ts:fn()`) or a line citation (`file.ts:12-20`,
 * `file.ts#L12-L20`). Renames, deletions, moved symbols, and shifted line
 * ranges silently rot those references; Markdown link checks only cover
 * `[text](target)` syntax. This checker extracts inline-code references from
 * the developer documents that are governed by review and verifies that the
 * path exists, that a cited symbol is actually declared in the target file
 * (TypeScript parser, declaration-aware), and that cited line ranges are
 * inside the file. Unsupported citation forms are reported explicitly instead
 * of being silently accepted.
 *
 * Scope: `docs/development/**`, `CONTRIBUTING.md`, `docs/testing-strategy.md`,
 * and every `AGENTS.md` (root and under `src/`). Historical ledgers
 * (`CHANGELOG.md`, `KNOWN_ISSUES.md`), demos, evals, and test fixtures are
 * intentionally out of scope.
 *
 * Usage:
 *   node scripts/check-doc-paths.mjs
 *
 * The module exports its pure functions so tests can inject a repository root,
 * an existence predicate, and file readers; importing it never runs the CLI.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

import { maskFencedCodeBlocks } from './agent-instruction-linter-markdown.mjs';

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
const LINE_SUFFIX = /:(\d+)(?:-(\d+))?$/;
const SYMBOL_SUFFIX = /:([A-Za-z_$][\w$]*)\(\)$/;
const UNSUPPORTED_CALL_SUFFIX = /:([A-Za-z_$][\w$.]*)\(\)$/;
const BARE_SUFFIX = /:([A-Za-z_$][\w$.]*)$/;
const ANCHOR_SUFFIX = /^#L(\d+)(?:-L(\d+))?$/i;
const INLINE_CODE = /`([^`\n]+)`/g;

const TYPESCRIPT_EXTENSIONS = new Map([
  ['.ts', ts.ScriptKind.TS],
  ['.mts', ts.ScriptKind.TS],
  ['.cts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX],
]);
const JAVASCRIPT_EXTENSIONS = new Map([
  ['.js', ts.ScriptKind.JS],
  ['.mjs', ts.ScriptKind.JS],
  ['.cjs', ts.ScriptKind.JS],
  ['.jsx', ts.ScriptKind.JSX],
]);

/**
 * Parse an inline-code citation into its path and optional symbol/line parts.
 *
 * Supported forms: `path`, `path:fn()`, `path:12`, `path:12-20`, `path#L12`,
 * `path#L12-L20`, and combinations of one symbol with one line citation.
 * Everything else (`Class.method()`, a bare `:name` without parentheses, a
 * `#heading` fragment) is reported as `unsupported` and never ignored.
 */
export function parseReference(token) {
  const result = {
    path: token,
    symbol: undefined,
    startLine: undefined,
    endLine: undefined,
    unsupported: undefined,
  };
  let value = token.trim();

  const hashIndex = value.indexOf('#');
  if (hashIndex >= 0) {
    const fragment = value.slice(hashIndex);
    const anchor = ANCHOR_SUFFIX.exec(fragment);
    if (anchor === null) {
      return {
        ...result,
        path: value.slice(0, hashIndex).replace(/[.,;:]+$/, ''),
        unsupported: `unsupported anchor '${fragment}'`,
      };
    }
    result.startLine = Number(anchor[1]);
    result.endLine = anchor[2] === undefined ? Number(anchor[1]) : Number(anchor[2]);
    value = value.slice(0, hashIndex);
  }

  for (;;) {
    const symbol = SYMBOL_SUFFIX.exec(value);
    if (symbol !== null) {
      if (result.symbol !== undefined) {
        return { ...result, path: value, unsupported: 'multiple symbol citations' };
      }
      result.symbol = symbol[1];
      value = value.slice(0, -symbol[0].length);
      continue;
    }
    const unsupportedCall = UNSUPPORTED_CALL_SUFFIX.exec(value);
    if (unsupportedCall !== null) {
      return {
        ...result,
        path: value.slice(0, -unsupportedCall[0].length).replace(/[.,;:]+$/, ''),
        unsupported: `'${unsupportedCall[1]}()' is not a supported symbol citation`,
      };
    }
    const line = LINE_SUFFIX.exec(value);
    if (line !== null) {
      if (result.startLine !== undefined) {
        return { ...result, path: value, unsupported: 'multiple line citations' };
      }
      result.startLine = Number(line[1]);
      result.endLine = line[2] === undefined ? Number(line[1]) : Number(line[2]);
      value = value.slice(0, -line[0].length);
      continue;
    }
    const bare = BARE_SUFFIX.exec(value);
    if (bare !== null) {
      return {
        ...result,
        path: value.slice(0, -bare[0].length).replace(/[.,;:]+$/, ''),
        unsupported: `'${bare[1]}' needs '()' or a line citation`,
      };
    }
    break;
  }

  return { ...result, path: value.replace(/[.,;:]+$/, '') };
}

/** Strip `:symbol()`, `:line`, `:start-end`, and `#L…` citations. */
export function normalizeReferencePath(token) {
  return parseReference(token).path.replace(/[.,;:]+$/, '');
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
  const masked = maskFencedCodeBlocks(markdown);
  const references = [];
  for (const match of masked.matchAll(INLINE_CODE)) {
    const token = match[1].trim();
    if (!looksLikeRepoPath(token)) continue;
    references.push({
      token,
      ...parseReference(token),
      line: masked.slice(0, match.index).split('\n').length,
    });
  }
  return references;
}

function lineCount(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
}

/** Declaration-aware symbol lookup in a TypeScript/JavaScript source text. */
export function collectDeclaredSymbols(sourceText, scriptKind) {
  const source = ts.createSourceFile(
    'documented-reference-target',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const names = new Set();
  for (const statement of source.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      names.add(statement.name.getText(source));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text);
      }
    }
  }
  return names;
}

function scriptKindForPath(referencePath) {
  const extension = extname(referencePath).toLowerCase();
  return TYPESCRIPT_EXTENSIONS.get(extension) ?? JAVASCRIPT_EXTENSIONS.get(extension) ?? null;
}

/**
 * Classify a path reference: `null` when it resolves inside the repository and
 * exists (and every citation is valid), otherwise the violation reason.
 * Traversal segments and paths that resolve outside the repository are invalid
 * references, never accepted just because a same-named file exists outside the
 * tree.
 */
function referenceProblem(reference, { repoRoot, exists, isFile, readFile }) {
  if (reference.path.split('/').includes('..')) {
    return { reason: 'traversal', message: undefined };
  }
  const resolved = resolve(repoRoot, reference.path);
  const relativePath = relative(repoRoot, resolved);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return { reason: 'outside-repository', message: undefined };
  }
  if (!exists(resolved)) {
    return { reason: 'missing', message: undefined };
  }
  if (reference.unsupported !== undefined) {
    return { reason: 'unsupported-reference-form', message: reference.unsupported };
  }

  const hasLine = reference.startLine !== undefined || reference.endLine !== undefined;
  if (reference.symbol === undefined && !hasLine) return null;

  if (!isFile(resolved)) {
    return {
      reason: 'unsupported-reference-form',
      message: 'symbol or line citation on a non-file target',
    };
  }
  const text = readFile(resolved);
  if (text === null) {
    return { reason: 'unsupported-reference-form', message: 'target file is not readable' };
  }

  if (reference.symbol !== undefined) {
    const scriptKind = scriptKindForPath(reference.path);
    if (scriptKind === null) {
      return {
        reason: 'unsupported-reference-form',
        message: `symbol citation on '${extname(reference.path) || 'extensionless'}' is not supported`,
      };
    }
    if (!collectDeclaredSymbols(text, scriptKind).has(reference.symbol)) {
      return {
        reason: 'missing-symbol',
        message: `'${reference.symbol}' is not declared in ${reference.path}`,
      };
    }
  }

  if (hasLine) {
    const startLine = reference.startLine ?? 0;
    const endLine = reference.endLine ?? startLine;
    const total = lineCount(text);
    if (startLine < 1 || endLine < startLine || endLine > total) {
      return {
        reason: 'invalid-line-range',
        message: `${startLine}-${endLine} outside 1-${total} of ${reference.path}`,
      };
    }
  }

  return null;
}

/** Report every inline-code reference that is missing, malformed, or stale. */
export function findMissingPathReferences({
  docs,
  repoRoot = REPO_ROOT,
  exists = (absolutePath) => existsSync(absolutePath),
  isFile = (absolutePath) => {
    try {
      return statSync(absolutePath).isFile();
    } catch {
      return false;
    }
  },
  readFile = (absolutePath) => {
    try {
      return readFileSync(absolutePath, 'utf8');
    } catch {
      return null;
    }
  },
}) {
  const invalid = [];
  for (const doc of docs) {
    for (const reference of extractPathReferences(doc.content)) {
      const problem = referenceProblem(reference, { repoRoot, exists, isFile, readFile });
      if (problem !== null) {
        invalid.push({ doc: doc.path, ...reference, ...problem });
      }
    }
  }
  return invalid;
}

function walkMarkdownFiles(root, directory, documents, read, list) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return;
  const inDevelopmentDocs =
    directory === 'docs/development' || directory.startsWith('docs/development/');
  for (const entry of list(absolute, { withFileTypes: true })) {
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (WALKED_AGENT_DIRS.has(entry.name)) continue;
      walkMarkdownFiles(root, relativePath, documents, read, list);
      continue;
    }
    if (entry.name === 'AGENTS.md' || (inDevelopmentDocs && entry.name.endsWith('.md'))) {
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
  const invalid = findMissingPathReferences({ docs: documents, repoRoot });
  if (invalid.length > 0) {
    error(`[check-doc-paths] ${invalid.length} invalid documented reference(s):`);
    for (const entry of invalid) {
      const detail = entry.message === undefined ? '' : `: ${entry.message}`;
      error(`  - ${entry.doc}:${entry.line}: '${entry.token}' (${entry.reason}${detail})`);
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
