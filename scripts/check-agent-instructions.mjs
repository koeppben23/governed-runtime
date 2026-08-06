#!/usr/bin/env node

/**
 * check-agent-instructions.mjs
 *
 * Drift checks for AGENTS.md and CLAUDE.md instruction files.
 * Run via: node scripts/check-agent-instructions.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const pkgScripts = new Set(Object.keys(PKG.scripts ?? {}));

// --- Helpers ---

function countLines(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  return raw.split('\n').length;
}

function countNonBlankLines(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  return raw.split('\n').filter((l) => l.trim().length > 0).length;
}

// --- Check 1: npm run scripts referenced in AGENTS.md exist in package.json ---
console.log('1. npm run script references...');
let ok = true;
for (const file of ['AGENTS.md', ...nestedAgentsMd()]) {
  const content = readFileSync(join(ROOT, file), 'utf8');
  const matches = content.matchAll(/`npm run ([\w:-]+)`/g);
  for (const m of matches) {
    if (!pkgScripts.has(m[1])) {
      console.error(`   FAIL ${file}: references missing script "npm run ${m[1]}"`);
      ok = false;
    }
  }
}
if (ok) console.log('   PASS');

// --- Check 2: Root AGENTS.md line count ---
console.log('2. Root AGENTS.md line budget (< 150 lines)...');
const rootLines = countLines('AGENTS.md');
if (rootLines > 150) {
  console.error(`   FAIL: ${rootLines} lines (max 150)`);
  ok = false;
} else {
  console.log(`   PASS: ${rootLines} lines`);
}

// --- Check 3: No host/model names in AGENTS.md files ---
console.log('3. No host/model names in AGENTS.md...');
const FORBIDDEN = /\b(Claude|Codex|DeepSeek|GPT-?\d?|Opus|Sonnet)\b/g;
for (const file of allAgentsMd()) {
  const content = readFileSync(join(ROOT, file), 'utf8');
  // Exclude reference-style links like [Claude][3] or [OpenAI Developers][2]
  const cleaned = content.replace(/\[.*?\]\[.*?\]/g, '');
  let match;
  while ((match = FORBIDDEN.exec(cleaned)) !== null) {
    // Skip if inside a markdown link URL
    const before = cleaned.lastIndexOf('\n', match.index);
    const line = cleaned.slice(before + 1, cleaned.indexOf('\n', match.index));
    if (line.includes('http')) continue;
    console.error(`   FAIL ${file}:${lineNumber(content, match.index)}: "${match[0]}"`);
    ok = false;
  }
}
if (ok) console.log('   PASS');

// --- Check 4: @-import syntax only in CLAUDE.md, not AGENTS.md ---
console.log('4. No @-import syntax in AGENTS.md...');
for (const file of allAgentsMd()) {
  const content = readFileSync(join(ROOT, file), 'utf8');
  if (/^@\S/.test(content)) {
    console.error(`   FAIL ${file}: contains @-import syntax`);
    ok = false;
  }
}
if (ok) console.log('   PASS');

// --- Check 5: CLAUDE.md files import AGENTS.md without extra content ---
console.log('5. CLAUDE.md adapter purity...');
for (const file of allClaudeMd()) {
  const content = readFileSync(join(ROOT, file), 'utf8').trim();
  if (content !== '@AGENTS.md') {
    console.error(`   FAIL ${file}: contains extra content beyond @AGENTS.md`);
    ok = false;
  }
}
if (ok) console.log('   PASS');

// --- Check 6: Nested AGENTS.md do not weaken root Safety/Evidence/Git rules ---
console.log('6. Nested AGENTS.md rule strength...');
const rootAgents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
for (const file of nestedAgentsMd()) {
  const content = readFileSync(join(ROOT, file), 'utf8');
  // Check: nested must not contradict "MUST NOT" from root about safety, evidence, git
  if (/\b[Mm]ay\s+force[ -]?push\b/.test(content)) {
    console.error(`   FAIL ${file}: weakens root force-push rule`);
    ok = false;
  }
  if (/\b[Mm]ay\s+commit\b/.test(content)) {
    console.error(`   FAIL ${file}: weakens root commit rule`);
    ok = false;
  }
  if (/\b[Mm]ay\s+(invent|fake|fabricate)\b/.test(content)) {
    console.error(`   FAIL ${file}: weakens root evidence rule`);
    ok = false;
  }
}
if (ok) console.log('   PASS');

// --- Summary ---
if (!ok) {
  console.error('\nSome checks failed.');
  process.exit(1);
}
console.log('\nAll checks passed.');
process.exit(0);

// --- Utility functions ---

function allAgentsMd() {
  const files = ['AGENTS.md'];
  for (const dir of ['src/config', 'src/integration', 'src/machine']) {
    if (existsSync(join(ROOT, dir, 'AGENTS.md'))) files.push(`${dir}/AGENTS.md`);
  }
  return files;
}

function nestedAgentsMd() {
  return allAgentsMd().filter((f) => f !== 'AGENTS.md');
}

function allClaudeMd() {
  const files = [];
  for (const dir of ['', 'src/config', 'src/integration', 'src/machine']) {
    const p = join(ROOT, dir, 'CLAUDE.md');
    if (existsSync(p)) files.push(`${dir ? dir + '/' : ''}CLAUDE.md`);
  }
  return files;
}

function lineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}
