#!/usr/bin/env node

/**
 * check-agent-instructions.mjs
 *
 * Deterministic structural checks for repository instruction files.
 * Performs 6 static checks on AGENTS.md and CLAUDE.md files.
 * Does not prove semantic consistency or policy compliance.
 *
 * Run via: node scripts/check-agent-instructions.mjs
 */

import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function repoRel(filePath) {
  return relative(ROOT, join(ROOT, filePath)).split(sep).join('/');
}

const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const pkgScripts = new Set(Object.keys(PKG.scripts ?? {}));

let globalOk = true;

// --- Helpers ---

function countLines(filePath) {
  const raw = readFileSync(join(ROOT, filePath), 'utf8');
  return raw.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
}

function readFile(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function walkDir(relativeDir, result, targetName) {
  const fullDir = join(ROOT, relativeDir);
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
    const fullPath = join(fullDir, entry);
    let st;
    try {
      st = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      walkDir(join(relativeDir, entry), result, targetName);
    } else if (entry === targetName) {
      result.push(join(relativeDir, entry));
    }
  }
}

function allAgentsMd() {
  const files = [];
  walkDir('.', files, 'AGENTS.md');
  return files.map(repoRel);
}

function allClaudeMd() {
  const files = [];
  walkDir('.', files, 'CLAUDE.md');
  return files.map(repoRel);
}

function nestedAgentsMd() {
  return allAgentsMd().filter((f) => f !== 'AGENTS.md');
}

function check(name, fn) {
  console.log(`${name}...`);
  const ok = fn();
  if (ok) console.log('   PASS');
  if (!ok) globalOk = false;
}

// --- Check 1: npm run scripts referenced in AGENTS.md exist in package.json ---
check('1. npm run script references', () => {
  let ok = true;
  for (const file of allAgentsMd()) {
    const content = readFile(file);
    const matches = content.matchAll(/`npm run ([\w:-]+)`/g);
    for (const m of matches) {
      if (!pkgScripts.has(m[1])) {
        console.error(`   FAIL ${file}: references missing script "npm run ${m[1]}"`);
        ok = false;
      }
    }
  }
  return ok;
});

// --- Check 2: Root AGENTS.md line count ---
check('2. Root AGENTS.md line budget (< 150 lines)', () => {
  const rootLines = countLines('AGENTS.md');
  if (rootLines > 150) {
    console.error(`   FAIL: ${rootLines} lines (max 150)`);
    return false;
  }
  console.log(`   ${rootLines} lines`);
  return true;
});

// --- Check 3: No host/model names in AGENTS.md files ---
check('3. No host/model names in AGENTS.md', () => {
  let ok = true;
  const FORBIDDEN = /\b(Claude|Codex|DeepSeek|GPT-?\d?|Opus|Sonnet)\b/g;
  for (const file of allAgentsMd()) {
    const content = readFile(file);
    const cleaned = content.replace(/\[.*?\]\[.*?\]/g, '');
    let match;
    while ((match = FORBIDDEN.exec(cleaned)) !== null) {
      const before = cleaned.lastIndexOf('\n', match.index);
      const line = cleaned.slice(before + 1, cleaned.indexOf('\n', match.index));
      if (line.includes('http')) continue;
      console.error(`   FAIL ${file}:${lineNumber(cleaned, match.index)}: "${match[0]}"`);
      ok = false;
    }
  }
  return ok;
});

// --- Check 4: @-import syntax only in CLAUDE.md, not AGENTS.md ---
check('4. No @-import syntax in AGENTS.md', () => {
  let ok = true;
  for (const file of allAgentsMd()) {
    const content = readFile(file);
    const lines = content.split('\n');
    for (const line of lines) {
      if (/^@\S/.test(line.trim())) {
        console.error(`   FAIL ${file}: contains @-import at "${line.trim()}"`);
        ok = false;
      }
    }
  }
  return ok;
});

// --- Check 5: CLAUDE.md files import AGENTS.md without extra content ---
check('5. CLAUDE.md adapter purity', () => {
  let ok = true;
  for (const file of allClaudeMd()) {
    const content = readFile(file).trim();
    if (content !== '@AGENTS.md') {
      console.error(`   FAIL ${file}: contains extra content beyond @AGENTS.md`);
      ok = false;
    }
  }
  return ok;
});

// --- Check 6: Nested AGENTS.md do not weaken root Git rules ---
check('6. Nested AGENTS.md Git rule strength', () => {
  let ok = true;
  for (const file of nestedAgentsMd()) {
    const content = readFile(file);
    if (/\b[Mm]ay\s+force[ -]?push\b/.test(content)) {
      console.error(`   FAIL ${file}: weakens root force-push rule`);
      ok = false;
    }
    if (/\b[Mm]ay\s+commit\b/.test(content)) {
      console.error(`   FAIL ${file}: weakens root commit rule`);
      ok = false;
    }
  }
  return ok;
});

// --- Summary ---
if (!globalOk) {
  console.error('\nSome checks failed.');
  process.exit(1);
}
console.log('\nAll checks passed.');
process.exit(0);

function lineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}
