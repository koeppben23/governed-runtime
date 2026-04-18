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
  let original = fs.readFileSync(filePath, 'utf-8');
  let changed = false;

  original = original.replace(/from\s+['"](\.\.?\/[^"']+)['"](?=\s*[;,}])/g, (match, specifier) => {
    if (specifier.endsWith('.js')) return match;
    
    const dir = path.dirname(filePath);
    const resolved = path.resolve(dir, specifier);
    const hasDir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
    const hasIndex = hasDir && fs.existsSync(path.join(resolved, 'index.js'));
    
    let suffix = '.js';
    if (hasDir && hasIndex) suffix = '/index.js';
    
    const newSpecifier = specifier + suffix;
    const newMatch = match.replace(specifier, newSpecifier);
    changed = true;
    return newMatch;
  });

  if (changed && !checkOnly) {
    fs.writeFileSync(filePath, original);
    console.log('Fixed:', filePath);
  }

  if (changed && checkOnly) {
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
