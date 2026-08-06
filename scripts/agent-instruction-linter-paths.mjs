/**
 * agent-instruction-linter-paths.mjs
 *
 * Path reference existence, CLAUDE.md adjacency, and instruction chain
 * budget checks for repository instruction files.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { normalizeRepoPath } from './agent-instruction-linter.mjs';

const PATH_PREFIXES = ['src/', 'docs/', 'scripts/', '.github/'];
const ROOT_FILES = new Set(['package.json', 'CONTRIBUTING.md']);
const CODE_BLOCK = /```[\s\S]*?```/g;
const BACKTICK = /`([^`]+)`/g;
const LINE_SUFFIX = /:\d+(:\d+)?$/;
const GLOB_OR_PLACEHOLDER = /[*?{}<>]/;
const URL_PATTERN = /:\/\//;

const CHAIN_WARN_BYTES = 16 * 1024;
const CHAIN_MAX_BYTES = 20 * 1024;

// ── Helpers ───────────────────────────────────────────────────────────

function readFile(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

function fileBytes(root, path) {
  return statSync(join(root, path)).size;
}

function stripCodeBlocks(content) {
  return content.replace(CODE_BLOCK, '');
}

function isConservativePath(ref) {
  if (PATH_PREFIXES.some((p) => ref.startsWith(p))) return true;
  return ROOT_FILES.has(ref);
}

function cleanRef(ref) {
  const stripped = ref.replace(LINE_SUFFIX, '').trim();
  if (GLOB_OR_PLACEHOLDER.test(stripped)) return null;
  if (URL_PATTERN.test(stripped)) return null;
  if (/\s/.test(stripped)) return null;
  return stripped;
}

// ── Check 7: Path references exist ────────────────────────────────────

export function checkPathReferences(root, agents, diagnostics) {
  for (const file of agents) {
    const content = readFile(root, file);
    const body = stripCodeBlocks(content);
    const seen = new Set();
    for (const m of body.matchAll(BACKTICK)) {
      const ref = cleanRef(m[1]);
      if (!ref || !isConservativePath(ref)) continue;
      const key = `${file}:${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fullPath = join(root, ref);
      if (!existsSync(fullPath)) {
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
    if (!existsSync(adjacent)) {
      diagnostics.push({
        file,
        kind: 'error',
        message: 'missing adjacent AGENTS.md',
      });
    }
  }
}

// ── Check 10: Instruction chain byte budget ───────────────────────────

function ancestorsUpTo(file) {
  const parts = normalizeRepoPath(file).split('/');
  const result = [];
  for (let i = 1; i < parts.length; i++) {
    result.push(parts.slice(0, i).join('/') + '/AGENTS.md');
  }
  return result;
}

export function checkInstructionChainBudgets(root, nested, diagnostics) {
  for (const file of nested) {
    const ancestorFiles = ancestorsUpTo(file);
    const files = ['AGENTS.md', ...ancestorFiles.filter((f) => f !== file)];
    if (file !== 'AGENTS.md') files.push(file);

    let total = 0;
    for (const f of files) {
      if (existsSync(join(root, f))) {
        total += fileBytes(root, f);
      }
    }

    if (total >= CHAIN_MAX_BYTES) {
      diagnostics.push({
        file,
        kind: 'error',
        message: `applicable instruction chain is ${(total / 1024).toFixed(1)} KiB (maximum 20 KiB)`,
        details: { bytes: total, files },
      });
    } else if (total >= CHAIN_WARN_BYTES) {
      diagnostics.push({
        file,
        kind: 'warn',
        message: `applicable instruction chain is ${(total / 1024).toFixed(1)} KiB (warning threshold 16 KiB)`,
        details: { bytes: total, files },
      });
    }
  }
}
