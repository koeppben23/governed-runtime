/**
 * agent-instruction-linter.mjs
 *
 * Deterministic structural checks for repository instruction files.
 *
 * This linter detects mechanically verifiable drift. It does not prove
 * semantic consistency, instruction compliance, or policy enforcement.
 *
 * Export:
 *   lintAgentInstructions({ root }) → { ok, diagnostics }
 *   normalizeRepoPath(path)        → string
 *   isRootAgentFile(path)          → boolean
 */

import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Path helpers ──────────────────────────────────────────────────────

export function normalizeRepoPath(filePath) {
  return filePath
    .replace(/^\.\//, '')
    .replace(/^\.\\/, '')
    .replace(/\\/g, '/');
}

export function isRootAgentFile(relativePath) {
  return normalizeRepoPath(relativePath) === 'AGENTS.md';
}

function repoRel(root, filePath) {
  return relative(root, join(root, filePath)).split(sep).join('/');
}

function countLines(root, filePath) {
  const raw = readFileSync(join(root, filePath), 'utf8');
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '')
    .split('\n').length;
}

function readFile(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

function walkDir(root, relativeDir, result, targetName) {
  const fullDir = join(root, relativeDir);
  let entries;
  try {
    entries = readdirSync(fullDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry === 'node_modules' ||
      entry === 'dist' ||
      entry === '.git' ||
      entry === '.codex' ||
      entry === 'coverage' ||
      entry === 'tmp'
    )
      continue;
    if (entry.startsWith('__') && entry.endsWith('__')) continue;
    const fullPath = join(fullDir, entry);
    let st;
    try {
      st = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      walkDir(root, join(relativeDir, entry), result, targetName);
    } else if (entry === targetName) {
      result.push(join(relativeDir, entry));
    }
  }
}

function allAgentsMd(root) {
  const files = [];
  walkDir(root, '.', files, 'AGENTS.md');
  return files.map((f) => repoRel(root, f));
}

function allClaudeMd(root) {
  const files = [];
  walkDir(root, '.', files, 'CLAUDE.md');
  return files.map((f) => repoRel(root, f));
}

function nestedAgentsMd(root) {
  return allAgentsMd(root).filter((f) => !isRootAgentFile(f));
}

function lineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}

// ── Main entry ────────────────────────────────────────────────────────

export function lintAgentInstructions({ root }) {
  const diagnostics = [];
  const PKG = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const pkgScripts = new Set(Object.keys(PKG.scripts ?? {}));

  // Check 1: npm run scripts referenced in AGENTS.md exist in package.json
  for (const file of allAgentsMd(root)) {
    const content = readFile(root, file);
    for (const m of content.matchAll(/`npm run ([\w:-]+)`/g)) {
      if (!pkgScripts.has(m[1])) {
        diagnostics.push({
          file,
          kind: 'error',
          message: `references missing script "npm run ${m[1]}"`,
        });
      }
    }
  }

  // Check 2: Root AGENTS.md line budget
  const rootLines = countLines(root, 'AGENTS.md');
  if (rootLines > 150) {
    diagnostics.push({
      file: 'AGENTS.md',
      kind: 'error',
      message: `${rootLines} lines (max 150)`,
    });
  }

  // Check 3: No host/model names in AGENTS.md
  const FORBIDDEN = /\b(Claude|Codex|DeepSeek|GPT-?\d?|Opus|Sonnet)\b/g;
  for (const file of allAgentsMd(root)) {
    const content = readFile(root, file);
    const cleaned = content.replace(/\[.*?\]\[.*?\]/g, '');
    FORBIDDEN.lastIndex = 0;
    let match;
    while ((match = FORBIDDEN.exec(cleaned)) !== null) {
      const before = cleaned.lastIndexOf('\n', match.index);
      const line = cleaned.slice(before + 1, cleaned.indexOf('\n', match.index));
      if (line.includes('http')) continue;
      diagnostics.push({
        file,
        kind: 'error',
        message: `contains "${match[0]}" at line ${lineNumber(cleaned, match.index)}`,
      });
    }
  }

  // Check 4: No @-import syntax in AGENTS.md
  for (const file of allAgentsMd(root)) {
    const content = readFile(root, file);
    for (const line of content.split('\n')) {
      if (/^@\S/.test(line.trim())) {
        diagnostics.push({
          file,
          kind: 'error',
          message: `contains @-import at "${line.trim()}"`,
        });
      }
    }
  }

  // Check 5: CLAUDE.md adapter purity
  for (const file of allClaudeMd(root)) {
    const content = readFile(root, file).trim();
    if (content !== '@AGENTS.md') {
      diagnostics.push({
        file,
        kind: 'error',
        message: 'contains extra content beyond @AGENTS.md',
      });
    }
  }

  // Check 6: Nested AGENTS.md do not weaken root Git rules
  for (const file of nestedAgentsMd(root)) {
    const content = readFile(root, file);
    if (/\b[Mm]ay\s+force[ -]?push\b/.test(content)) {
      diagnostics.push({
        file,
        kind: 'error',
        message: 'weakens root force-push rule',
      });
    }
    if (/\b[Mm]ay\s+commit\b/.test(content)) {
      diagnostics.push({
        file,
        kind: 'error',
        message: 'weakens root commit rule',
      });
    }
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics,
  };
}

// ── CLI entry ─────────────────────────────────────────────────────────

export function runCli() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const result = lintAgentInstructions({ root });
  for (const d of result.diagnostics) {
    const prefix = d.kind === 'error' ? 'FAIL' : 'WARN';
    const loc = d.file ? `${d.file}: ` : '';
    console.error(`   ${prefix} ${loc}${d.message}`);
  }
  if (!result.ok) {
    console.error('\nSome checks failed.');
    process.exit(1);
  }
  console.log('\nAll checks passed.');
  process.exit(0);
}
