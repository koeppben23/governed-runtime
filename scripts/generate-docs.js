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

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const versionFile = join(REPO_ROOT, 'VERSION');
const version = readFileSync(versionFile, 'utf-8').trim();

// Files with version placeholders to update
const filesToUpdate = [
  'README.md',
  'PRODUCT_IDENTITY.md',
  'PRODUCT_ONE_PAGER.md',
  'CHANGELOG.md',
  'docs/installation.md',
  'docs/air-gapped-guide.md',
  'docs/delivery-scope.md',
  'docs/upgrade-rollback.md',
  'docs/release-policy.md',
  'docs/admin-model.md',
  'docs/support-model.md',
  'docs/data-classification.md',
  'docs/bsi-c5-mapping.md',
  'docs/marisk-mapping.md',
  'docs/ba-it-mapping.md',
  'docs/dora-mapping.md',
  'docs/gobd-mapping.md',
  'docs/retention-recovery.md',
  'docs/trust-boundaries.md',
  'docs/security-hardening.md',
  'docs/deployment-model.md',
  'docs/distribution-model.md',
  'docs/phases.md',
  'docs/profiles.md',
  'docs/commands.md',
  'docs/quick-start.md',
  'docs/configuration.md',
  'docs/policies.md',
  'docs/index.md',
];

function replaceVersion(content) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  content = content.replace(
    new RegExp(`FlowGuard Version: [\\d.]+`, 'g'),
    `FlowGuard Version: ${version}`,
  );
  content = content.replace(
    /\*\*Version:\*\* [\d.]+(\s*\|\s*TypeScript)/g,
    `**Version:** ${version}$1`,
  );
  content = content.replace(/^\*Version: [\d.]+\*$/gm, `**Version:** ${version}`);
  content = content.replace(
    new RegExp(`flowguard-core-[\\d.]+\\.tgz`, 'g'),
    `flowguard-core-${version}.tgz`,
  );
  content = content.replace(
    /^Current snapshot: v[\d.]+$/gm,
    `Current snapshot: ${version}`,
  );
  content = content.replace(
    /^\*\*Current snapshot: v[\d.]+\*\*$/gm,
    `**Current snapshot: ${version}**`,
  );
  return content;
}

for (const file of filesToUpdate) {
  const filePath = join(REPO_ROOT, file);
  try {
    const content = readFileSync(filePath, 'utf-8');
    const updated = replaceVersion(content);
    if (content !== updated) {
      writeFileSync(filePath, updated, 'utf-8');
      console.log(`Updated ${file} to version ${version}`);
    } else {
      console.log(`${file} already up to date`);
    }
  } catch (e) {
    console.error(`Error updating ${file}: ${e.message}`);
  }
}

console.log(`\nVersion ${version} synced across all documentation.`);
