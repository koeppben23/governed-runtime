/**
 * Validate ESM import specifiers in compiled dist output.
 *
 * Enforces Node.js ESM-compatible relative imports:
 * - file imports must end in `.js`
 * - directory imports must explicitly end in `/index.js`
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');

const importRegex = /from\s+['"](\.{1,2}\/[^'"\n]+)['"]/g;
const dynamicImportRegex = /import\(\s*['"](\.{1,2}\/[^'"\n]+)['"]\s*\)/g;

/**
 * Strip JS comments to avoid matching example strings in comments.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * Return true when a relative specifier is ESM-safe for Node.
 */
function isValidRelativeSpecifier(specifier) {
  if (specifier.endsWith('.js')) return true;
  if (specifier.endsWith('/index.js')) return true;
  return false;
}

/**
 * Collect all .js files recursively.
 */
function walkJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Validate a single file and return invalid specifiers.
 */
function validateFile(filePath) {
  const src = stripComments(fs.readFileSync(filePath, 'utf8'));
  const invalid = [];

  for (const re of [importRegex, dynamicImportRegex]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(src)) !== null) {
      const specifier = match[1];
      if (!isValidRelativeSpecifier(specifier)) {
        invalid.push(specifier);
      }
    }
  }

  return invalid;
}

if (!fs.existsSync(distDir)) {
  console.error('ESM import check failed: dist/ directory not found. Run build first.');
  process.exit(1);
}

const files = walkJsFiles(distDir);
let issues = 0;

for (const file of files) {
  const invalid = validateFile(file);
  if (invalid.length === 0) continue;
  issues += invalid.length;
  console.error(`Invalid ESM import specifier(s) in ${file}:`);
  for (const specifier of invalid) {
    console.error(`  - ${specifier}`);
  }
}

if (issues > 0) {
  console.error(`ESM import check failed: ${issues} invalid specifier(s).`);
  process.exit(1);
}

console.log('ESM import check passed.');
