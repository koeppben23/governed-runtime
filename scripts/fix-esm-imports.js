/**
 * Fix ESM import extensions in compiled JavaScript.
 *
 * TypeScript compiles relative imports without .js extensions.
 * Node.js ESM requires explicit .js extensions.
 *
 * This script adds .js to all relative imports in dist/*.js files.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");

function fixImports(filePath) {
  let content = fs.readFileSync(filePath, "utf-8");
  const original = content;

  content = content.replace(/from "(\.\.?\/[^"]+)"/g, (match, p1) => {
    if (p1.endsWith(".js")) return match;
    return `from "${p1}.js"`;
  });

  if (content !== original) {
    fs.writeFileSync(filePath, content);
    console.log("Fixed:", filePath);
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name.endsWith(".js")) {
      fixImports(full);
    }
  }
}

if (!fs.existsSync(distDir)) {
  console.log("No dist directory found - skipping ESM fix");
  process.exit(0);
}

console.log("Fixing ESM imports in dist/...");
walk(distDir);
console.log("Done.");
