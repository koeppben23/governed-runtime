#!/usr/bin/env node
/**
 * @module scripts/generate-docs
 * @description Generates README.md and syncs version placeholders in docs.
 *
 * Usage:
 *   npm run generate-docs
 *
 * This script reads VERSION and replaces placeholders in markdown files.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const versionFile = join(REPO_ROOT, "VERSION");
const version = readFileSync(versionFile, "utf-8").trim();

// Files with version placeholders to update
const filesToUpdate = [
  "README.md",
  "PRODUCT_IDENTITY.md",
  "docs/installation.md",
  "docs/air-gapped-guide.md",
  "docs/delivery-scope.md",
  "docs/upgrade-rollback.md",
  "docs/release-policy.md",
  "docs/admin-model.md",
  "docs/support-model.md",
  "docs/data-classification.md",
  "docs/bsi-c5-mapping.md",
  "docs/retention-recovery.md",
  "docs/trust-boundaries.md",
  "docs/security-hardening.md",
  "docs/deployment-model.md",
];

function replaceVersion(content) {
  // Replace patterns like "v1.3.0" or "1.3.0" in version contexts
  return content.replace(/\bv?1\.3\.\d+\b/g, version);
}

for (const file of filesToUpdate) {
  const filePath = join(REPO_ROOT, file);
  try {
    const content = readFileSync(filePath, "utf-8");
    const updated = replaceVersion(content);
    if (content !== updated) {
      writeFileSync(filePath, updated, "utf-8");
      console.log(`Updated ${file} to version ${version}`);
    } else {
      console.log(`${file} already up to date`);
    }
  } catch (e) {
    console.error(`Error updating ${file}: ${e.message}`);
  }
}

console.log(`\nVersion ${version} synced across all documentation.`);
