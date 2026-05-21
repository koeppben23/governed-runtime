/**
 * OpenCode Docs Drift Detection Tool.
 *
 * Fetches raw Markdown/MDX source files from the OpenCode GitHub repository
 * and compares section hashes against a committed baseline. Detects changes
 * to code blocks, tables, and structural headers that may indicate API or
 * configuration changes requiring integration review.
 *
 * Uses raw Markdown rather than rendered HTML to avoid false positives from
 * Astro framework upgrades, CSS changes, or layout modifications.
 *
 * Usage:
 *   node scripts/docs-drift.mjs              # Check: exit 1 if drift
 *   node scripts/docs-drift.mjs --update     # Update baseline hashes
 *   node scripts/docs-drift.mjs --verbose    # Show which pages changed + diffs
 *
 * Baseline: .sdk-baselines/opencode/docs-hashes.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const BASELINE_PATH = path.join(root, '.sdk-baselines', 'opencode', 'docs-hashes.json');

const BASE_URL =
  'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs';

const PAGES = [
  { url: `${BASE_URL}/sdk.mdx`, key: 'sdk' },
  { url: `${BASE_URL}/plugins.mdx`, key: 'plugins' },
  { url: `${BASE_URL}/config.mdx`, key: 'config' },
  { url: `${BASE_URL}/commands.mdx`, key: 'commands' },
  { url: `${BASE_URL}/permissions.mdx`, key: 'permissions' },
  { url: `${BASE_URL}/agents.mdx`, key: 'agents' },
  { url: `${BASE_URL}/custom-tools.mdx`, key: 'custom-tools' },
  { url: `${BASE_URL}/skills.mdx`, key: 'skills' },
];

/**
 * Extract structurally relevant sections from Markdown/MDX source:
 * 1. Fenced code blocks (```...```)
 * 2. Markdown table rows (|...|)
 * 3. Headers (## / ### / ####)
 *
 * Ignores: prose paragraphs, frontmatter, JSX components, import statements.
 *
 * @param {string} markdown
 * @returns {{ sections: string[], content: string }}
 */
function extractRelevantSections(markdown) {
  const sections = [];

  // 1. Fenced code blocks (including language specifier)
  const codeBlockRegex = /```[\s\S]*?```/g;
  let match;
  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    sections.push(match[0].trim());
  }

  // 2. Markdown table rows
  const tableRowRegex = /^\|.+\|$/gm;
  while ((match = tableRowRegex.exec(markdown)) !== null) {
    sections.push(match[0].trim());
  }

  // 3. Headers (## through ####)
  const headerRegex = /^#{2,4}\s+.+$/gm;
  while ((match = headerRegex.exec(markdown)) !== null) {
    sections.push(match[0].trim());
  }

  const content = sections.join('\n');
  return { sections, content };
}

function sha256(content) {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Fetch a single page with retry and timeout.
 *
 * @param {string} url
 * @param {number} retries
 * @returns {Promise<string | null>}
 */
async function fetchPage(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.status === 404) {
        console.warn(`WARN: Page not found (404): ${url}`);
        return null;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      return await res.text();
    } catch (err) {
      if (attempt < retries) {
        console.warn(`WARN: Fetch failed for ${url}, retrying (${attempt + 1}/${retries})...`);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      console.error(`ERROR: Failed to fetch ${url}: ${err.message}`);
      return null;
    }
  }
  return null;
}

async function run() {
  const isUpdate = process.argv.includes('--update');
  const isVerbose = process.argv.includes('--verbose');

  // ÔöÇÔöÇ Fetch all pages ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  console.log(`Fetching ${PAGES.length} documentation pages...`);
  const results = {};
  let fetchErrors = 0;

  for (const page of PAGES) {
    const markdown = await fetchPage(page.url);
    if (markdown === null) {
      fetchErrors++;
      results[page.key] = null;
      continue;
    }

    const { sections, content } = extractRelevantSections(markdown);
    results[page.key] = {
      hash: sha256(content),
      sections: sections.length,
      content: isVerbose ? content : undefined,
    };

    if (isVerbose) {
      console.log(
        `  ${page.key}: ${sections.length} sections, hash ${results[page.key].hash.slice(0, 12)}`,
      );
    }
  }

  if (fetchErrors === PAGES.length) {
    console.error('ERROR: All page fetches failed. Network issue or repository restructured.');
    process.exit(1);
  }

  // ÔöÇÔöÇ Update mode ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  if (isUpdate) {
    const baseline = {
      generated: new Date().toISOString(),
      version: '1',
      hashes: {},
    };

    for (const [key, result] of Object.entries(results)) {
      if (result === null) {
        console.warn(`WARN: Skipping ${key} (fetch failed)`);
        continue;
      }
      baseline.hashes[key] = { hash: result.hash, sections: result.sections };
    }

    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
    console.log(`Baseline updated: ${Object.keys(baseline.hashes).length} pages hashed.`);
    process.exit(0);
  }

  // ÔöÇÔöÇ Check mode ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error('ERROR: Baseline file missing: .sdk-baselines/opencode/docs-hashes.json');
    console.error('Run "node scripts/docs-drift.mjs --update" to create it.');
    process.exit(1);
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
  let drifted = false;
  const changed = [];

  for (const page of PAGES) {
    const result = results[page.key];
    const base = baseline.hashes[page.key];

    if (result === null) {
      if (base) {
        console.warn(`WARN: Could not fetch ${page.key} ÔÇö skipping (was in baseline).`);
      }
      continue;
    }

    if (!base) {
      console.error(
        `DRIFT: New page ${page.key} not in baseline (hash: ${result.hash.slice(0, 12)})`,
      );
      changed.push(page.key);
      drifted = true;
      continue;
    }

    if (result.hash !== base.hash) {
      console.error(`DRIFT: ${page.key}`);
      console.error(`  Baseline: ${base.hash.slice(0, 12)} (${base.sections} sections)`);
      console.error(`  Current:  ${result.hash.slice(0, 12)} (${result.sections} sections)`);
      changed.push(page.key);
      drifted = true;
    } else {
      console.log(`OK: ${page.key} (${result.hash.slice(0, 12)})`);
    }
  }

  if (drifted) {
    console.error('');
    console.error(`Docs drift detected in: ${changed.join(', ')}`);
    console.error('Review the changes, then run:');
    console.error('  node scripts/docs-drift.mjs --update');
    process.exit(1);
  }

  console.log(`All ${PAGES.length} documentation baselines match.`);
  process.exit(0);
}

run();
