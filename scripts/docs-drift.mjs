/**
 * OpenCode Docs Drift Detection Tool.
 *
 * Compares structurally relevant OpenCode documentation sections against a
 * committed baseline. Documentation is fetched from the EXACT pinned host
 * version tag recorded in `.sdk-baselines/opencode/host-version.json`, never
 * from a moving branch: the integration is pinned to one host contract, so
 * unreviewed `dev` documentation changes must not masquerade as drift.
 *
 * Usage:
 *   node scripts/docs-drift.mjs              # Check: exit 1 if drift
 *   node scripts/docs-drift.mjs --update     # Update baseline for the pinned tag
 *   node scripts/docs-drift.mjs --verbose    # Show which pages changed
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
const HOST_VERSION_PATH = path.join(root, '.sdk-baselines', 'opencode', 'host-version.json');

const BASELINE_SCHEMA_VERSION = '1';
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;
const PAGE_FILES = [
  'sdk',
  'plugins',
  'config',
  'commands',
  'permissions',
  'agents',
  'custom-tools',
  'skills',
];

/** Raw-docs base URL for one exact OpenCode tag. Never a mutable branch. */
export function docsBaseUrl(version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid OpenCode version for docs URL: ${String(version)}`);
  }
  return `https://raw.githubusercontent.com/anomalyco/opencode/v${version}/packages/web/src/content/docs`;
}

/** All pinned documentation pages for one host version. */
export function derivePages(version) {
  return PAGE_FILES.map((file) => ({
    key: file,
    url: `${docsBaseUrl(version)}/${file}.mdx`,
  }));
}

/** The exact host version the integration is pinned to. */
export function readPinnedHostVersion(filePath = HOST_VERSION_PATH) {
  const meta = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const version = typeof meta.version === 'string' ? meta.version.replace(/^v/, '') : '';
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid pinned OpenCode host version in ${filePath}: ${String(meta.version)}`);
  }
  return version;
}

/**
 * Extract structurally relevant sections from Markdown/MDX source:
 * fenced code blocks, table rows, and headers. Prose, frontmatter, JSX, and
 * imports are ignored so formatting-only edits do not create drift.
 */
export function extractRelevantSections(markdown) {
  const sections = [];
  let match;

  const codeBlockRegex = /```[\s\S]*?```/g;
  while ((match = codeBlockRegex.exec(markdown)) !== null) sections.push(match[0].trim());

  const tableRowRegex = /^\|.+\|$/gm;
  while ((match = tableRowRegex.exec(markdown)) !== null) sections.push(match[0].trim());

  const headerRegex = /^#{2,4}\s+.+$/gm;
  while ((match = headerRegex.exec(markdown)) !== null) sections.push(match[0].trim());

  return { sections, content: sections.join('\n') };
}

function sha256(content) {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

async function fetchPage(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.text();
    } catch (err) {
      if (attempt < retries) {
        console.warn(`WARN: Fetch failed for ${url}, retrying (${attempt + 1}/${retries})...`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      console.error(`ERROR: Failed to fetch ${url}: ${err.message}`);
      return null;
    }
  }
  return null;
}

/** Fetch and hash every page. A missing page is a failure, never a skip. */
export async function collectHashes(pages, fetchImpl = fetchPage) {
  const results = {};
  const failures = [];
  for (const page of pages) {
    const markdown = await fetchImpl(page.url);
    if (markdown === null) {
      failures.push(page.key);
      results[page.key] = null;
      continue;
    }
    const { sections, content } = extractRelevantSections(markdown);
    results[page.key] = { hash: sha256(content), sections: sections.length };
  }
  return { results, failures };
}

/** Reject a baseline that does not describe the currently pinned host tag. */
export function assertBaselineMetadata(baseline, pinnedVersion) {
  if (!baseline || typeof baseline !== 'object') throw new Error('Baseline is not an object.');
  if (baseline.version !== BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported docs baseline schema version ${String(baseline.version)}; expected ${BASELINE_SCHEMA_VERSION}.`,
    );
  }
  if (baseline.opencodeVersion !== pinnedVersion) {
    throw new Error(
      `Docs baseline is pinned to OpenCode ${String(baseline.opencodeVersion)}, but the host is pinned ` +
        `to ${pinnedVersion}. Run "node scripts/docs-drift.mjs --update" after reviewing the pinned-tag diff.`,
    );
  }
  const expected = [...PAGE_FILES].sort();
  const actual = Object.keys(baseline.hashes ?? {}).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error(
      `Docs baseline page set is stale (expected ${expected.join(', ')}, found ${actual.join(', ')}). ` +
        'Run "node scripts/docs-drift.mjs --update".',
    );
  }
  for (const key of expected) {
    const entry = baseline.hashes[key];
    if (
      typeof entry?.hash !== 'string' ||
      entry.hash.length === 0 ||
      !Number.isInteger(entry.sections) ||
      entry.sections < 0
    ) {
      throw new Error(
        `Docs baseline entry "${key}" is invalid; run "node scripts/docs-drift.mjs --update".`,
      );
    }
  }
}

/** Compare freshly fetched results against a validated baseline. */
export function compareAgainstBaseline(pages, results, baseline) {
  const changed = [];
  for (const page of pages) {
    const result = results[page.key];
    const base = baseline.hashes[page.key];
    if (result.hash !== base.hash) changed.push(page.key);
  }
  return changed;
}

/** Build a complete baseline; partial fetch results are refused. */
export function buildBaseline({ pages, results, pinnedVersion, generatedAt }) {
  const missing = pages.filter((page) => results[page.key] === null).map((page) => page.key);
  if (missing.length > 0) {
    throw new Error(`Refusing a partial docs baseline; fetch failed for: ${missing.join(', ')}.`);
  }
  const hashes = {};
  for (const page of pages) {
    hashes[page.key] = {
      hash: results[page.key].hash,
      sections: results[page.key].sections,
    };
  }
  return {
    generated: generatedAt,
    version: BASELINE_SCHEMA_VERSION,
    opencodeVersion: pinnedVersion,
    hashes,
  };
}

async function run(argv = process.argv.slice(2), fetchImpl = fetchPage) {
  const isUpdate = argv.includes('--update');
  const isVerbose = argv.includes('--verbose');
  const pinnedVersion = readPinnedHostVersion();
  const pages = derivePages(pinnedVersion);

  console.log(`Fetching ${pages.length} documentation pages for OpenCode v${pinnedVersion}...`);
  const { results, failures } = await collectHashes(pages, fetchImpl);
  if (failures.length > 0) {
    console.error(`ERROR: Documentation fetch failed for: ${failures.join(', ')}.`);
    return 1;
  }

  if (isVerbose) {
    for (const page of pages) {
      const result = results[page.key];
      console.log(`  ${page.key}: ${result.sections} sections, hash ${result.hash.slice(0, 12)}`);
    }
  }

  if (isUpdate) {
    const baseline = buildBaseline({
      pages,
      results,
      pinnedVersion,
      generatedAt: new Date().toISOString(),
    });
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
    console.log(
      `Baseline updated for OpenCode v${pinnedVersion}: ${Object.keys(baseline.hashes).length} pages hashed.`,
    );
    return 0;
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error('ERROR: Baseline file missing: .sdk-baselines/opencode/docs-hashes.json');
    console.error('Run "node scripts/docs-drift.mjs --update" to create it.');
    return 1;
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
  assertBaselineMetadata(baseline, pinnedVersion);
  const changed = compareAgainstBaseline(pages, results, baseline);

  for (const page of pages) {
    const key = page.key;
    if (changed.includes(key)) {
      console.error(`DRIFT: ${key}`);
      console.error(
        `  Baseline: ${baseline.hashes[key].hash.slice(0, 12)} (${baseline.hashes[key].sections} sections)`,
      );
      console.error(
        `  Current:  ${results[key].hash.slice(0, 12)} (${results[key].sections} sections)`,
      );
    } else {
      console.log(`OK: ${key} (${results[key].hash.slice(0, 12)})`);
    }
  }

  if (changed.length > 0) {
    console.error('');
    console.error(`Docs drift detected in: ${changed.join(', ')}`);
    console.error(
      `The pinned tag v${pinnedVersion} is immutable. Treat changed bytes as a tag-mutation ` +
        'or fetch-integrity incident: verify the tag commit before updating the baseline.',
    );
    return 1;
  }

  console.log(`All ${pages.length} documentation baselines match OpenCode v${pinnedVersion}.`);
  return 0;
}

export { run, fetchPage, sha256 };

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  run().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
