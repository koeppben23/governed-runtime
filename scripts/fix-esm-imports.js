/**
 * Fix ESM import extensions in compiled JavaScript.
 *
 * TypeScript compiles relative imports without .js extensions.
 * Node.js ESM requires explicit .js extensions. Additionally,
 * Node.js ESM does not auto-resolve directory imports to index.js.
 *
 * This script:
 * - Adds .js to relative imports targeting files.
 * - Rewrites directory imports to /index.js (for barrel re-exports).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');
const checkOnly = process.argv.includes('--check');
let pendingIssues = 0;

function fixImports(filePath) {
  const original = fs.readFileSync(filePath, 'utf-8');
  const fileDir = path.dirname(filePath);

  const lines = original.split('\n');
  const fixed = lines.map((line) => {
    const match = line.match(/^(\s*(?:import|export)\b.*\sfrom\s+)(["'])(\.\.?\/[^"']+)(["'])/);
    if (!match) return line;

    const [, prefix, openQuote, specifier, closeQuote] = match;
    if (openQuote !== closeQuote || specifier.endsWith('.js')) return line;

    const resolved = path.resolve(fileDir, specifier);
    const normalizedSpecifier =
      fs.existsSync(resolved) &&
      fs.statSync(resolved).isDirectory() &&
      fs.existsSync(path.join(resolved, 'index.js'))
        ? `${specifier}/index.js`
        : `${specifier}.js`;

    return line.replace(`${openQuote}${specifier}${closeQuote}`, `${openQuote}${normalizedSpecifier}${closeQuote}`);
  });

  const content = fixed.join('\n');

  if (content !== original && !checkOnly) {
    fs.writeFileSync(filePath, content);
    console.log('Fixed:', filePath);
  }

  if (content !== original && checkOnly) {
    pendingIssues++;
    console.log('Needs fix:', filePath);
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name.endsWith('.js')) {
      fixImports(full);
    }
  }
}

if (!fs.existsSync(distDir)) {
  console.log('No dist directory found - skipping ESM fix');
  process.exit(0);
}

console.log(checkOnly ? 'Checking ESM imports in dist/...' : 'Fixing ESM imports in dist/...');
walk(distDir);

if (checkOnly && pendingIssues > 0) {
  console.error(`ESM import check failed: ${pendingIssues} file(s) need extension fixes.`);
  process.exit(1);
}

console.log('Done.');
