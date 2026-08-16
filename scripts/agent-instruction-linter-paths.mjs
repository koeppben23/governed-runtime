/**
 * agent-instruction-linter-paths.mjs
 *
 * Path reference existence, CLAUDE.md adjacency, instruction chain
 * budget checks, and path normalization for repository instruction files.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { maskFencedCodeBlocks } from './agent-instruction-linter-markdown.mjs';

const PATH_PREFIXES = ['src/', 'docs/', 'scripts/', '.github/'];
const ROOT_FILES = new Set(['package.json', 'CONTRIBUTING.md']);
const BACKTICK = /`([^`]+)`/g;
const LINE_SUFFIX = /:\d+(:\d+)?$/;
const GLOB_OR_PLACEHOLDER = /[*?{}<>]/;
const URL_PATTERN = /:\/\//;

const CHAIN_WARN_BYTES = 16 * 1024;
const CHAIN_MAX_BYTES = 20 * 1024;

// ── Path normalization ───────────────────────────────────────────────

export function normalizeRepoPath(filePath) {
  return filePath
    .replace(/^\.\//, '')
    .replace(/^\.\\/, '')
    .replace(/\\/g, '/');
}

export function isRootAgentFile(relativePath) {
  return normalizeRepoPath(relativePath) === 'AGENTS.md';
}

// ── Chain helpers ─────────────────────────────────────────────────────

export function classifyInstructionChainBytes(bytes) {
  if (bytes >= CHAIN_MAX_BYTES) return 'error';
  if (bytes >= CHAIN_WARN_BYTES) return 'warn';
  return null;
}

export function applicableAgentChain(root, file) {
  const candidates = ['AGENTS.md', ...ancestorsUpTo(file)];
  if (file !== 'AGENTS.md') candidates.push(file);

  return [...new Set(candidates)].filter((candidate) => {
    const full = join(root, candidate);
    try {
      return statSync(full).isFile();
    } catch {
      return false;
    }
  });
}

function ancestorsUpTo(file) {
  const parts = normalizeRepoPath(file).split('/');
  const result = [];
  for (let i = 1; i < parts.length; i++) {
    result.push(parts.slice(0, i).join('/') + '/AGENTS.md');
  }
  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────

function readFile(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

function fileBytes(root, path) {
  return statSync(join(root, path)).size;
}

function isConservativePath(ref) {
  if (PATH_PREFIXES.some((p) => ref.startsWith(p))) return true;
  return ROOT_FILES.has(ref);
}

function cleanRef(ref) {
  const stripped = ref.trim().replace(LINE_SUFFIX, '');
  if (GLOB_OR_PLACEHOLDER.test(stripped)) return null;
  if (URL_PATTERN.test(stripped)) return null;
  if (/\s/.test(stripped)) return null;
  return stripped;
}

function isRegularFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// ── Check 7: Path references exist ────────────────────────────────────

export function checkPathReferences(root, agents, diagnostics) {
  const resolvedRoot = resolve(root);

  for (const file of agents) {
    const content = readFile(root, file);
    const body = maskFencedCodeBlocks(content);
    const seen = new Set();
    for (const m of body.matchAll(BACKTICK)) {
      const ref = cleanRef(m[1]);
      if (!ref || !isConservativePath(ref)) continue;
      const key = `${file}:${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Traversal protection
      const resolved = resolve(resolvedRoot, ref);
      const rel = relative(resolvedRoot, resolved);
      if (rel.startsWith(`..${sep}`) || rel === '..') {
        diagnostics.push({
          file,
          kind: 'error',
          check: 'repository-path-reference',
          message: `path reference escapes repository root: "${ref}"`,
        });
        continue;
      }

      if (!existsSync(resolved)) {
        diagnostics.push({
          file,
          kind: 'error',
          message: `references missing path "${ref}"`,
        });
      }
    }
  }
}

// ── Check 8: CLAUDE.md adjacency ──────────────────────────────────────

export function checkClaudeAdjacency(root, claudes, diagnostics) {
  for (const file of claudes) {
    const dir = dirname(join(root, file));
    const adjacent = join(dir, 'AGENTS.md');
    if (!isRegularFile(adjacent)) {
      diagnostics.push({
        file,
        kind: 'error',
        message: 'missing adjacent AGENTS.md',
      });
    }
  }
}

// ── Check 10: Instruction chain byte budget ───────────────────────────

export function checkInstructionChainBudgets(root, nested, diagnostics) {
  for (const file of nested) {
    const files = applicableAgentChain(root, file);
    const total = files.reduce((sum, f) => sum + fileBytes(root, f), 0);
    const classification = classifyInstructionChainBytes(total);

    if (classification === 'error') {
      diagnostics.push({
        file,
        kind: 'error',
        check: 'instruction-chain-budget',
        message: `applicable instruction chain is ${(total / 1024).toFixed(1)} KiB (maximum 20 KiB)`,
        details: { bytes: total, files },
      });
    } else if (classification === 'warn') {
      diagnostics.push({
        file,
        kind: 'warn',
        check: 'instruction-chain-budget',
        message: `applicable instruction chain is ${(total / 1024).toFixed(1)} KiB (warning threshold 16 KiB)`,
        details: { bytes: total, files },
      });
    }
  }
}
