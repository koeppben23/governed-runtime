/**
 * Historical OpenCode V1 documentation integrity check. NOT V2 acceptance.
 *
 * Compares structurally relevant OpenCode documentation sections against a
 * committed baseline. Documentation is fetched from the EXACT pinned host
 * version tag recorded in `.sdk-baselines/opencode/host-version.json`, never
 * from a moving branch. These are retained historical evidence, not the
 * current V2 integration contract. V2 docs drift remains NOT_VERIFIED.
 *
 * Usage:
 *   node scripts/docs-drift.mjs --historical --verbose
 * No default V2 check or baseline-write mode exists.
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

class DocsIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.code = 'HISTORICAL_DOCS_INTEGRITY_FAILED';
  }
}

const BASELINE_SCHEMA_VERSION = '1';
const VERSION_PATTERN = /^1\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
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
    throw new DocsIntegrityError(`Invalid OpenCode version for docs URL: ${String(version)}`);
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

/** The historical host version; never the active V2 candidate. */
export function readPinnedHostVersion(filePath = HOST_VERSION_PATH) {
  const meta = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const version = typeof meta.version === 'string' ? meta.version.replace(/^v/, '') : '';
  if (meta.package !== 'opencode-ai' || !VERSION_PATTERN.test(version)) {
    throw new DocsIntegrityError(
      `Invalid pinned OpenCode host version in ${filePath}: ${String(meta.version)}`,
    );
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
      if (!res.ok) throw new DocsIntegrityError(`HTTP ${res.status}: ${res.statusText}`);
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
  /** @type {Record<string, {hash: string, sections: number} | null>} */
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
  if (!baseline || typeof baseline !== 'object')
    throw new DocsIntegrityError('Baseline is not an object.');
  if (baseline.version !== BASELINE_SCHEMA_VERSION) {
    throw new DocsIntegrityError(
      `Unsupported docs baseline schema version ${String(baseline.version)}; expected ${BASELINE_SCHEMA_VERSION}.`,
    );
  }
  if (baseline.opencodeVersion !== pinnedVersion) {
    throw new DocsIntegrityError(
      `Docs baseline is pinned to OpenCode ${String(baseline.opencodeVersion)}, but the host is pinned ` +
        `to ${pinnedVersion}. Restore the original historical evidence after verifying its provenance; do not rewrite it.`,
    );
  }
  const expected = [...PAGE_FILES].sort();
  const actual = Object.keys(baseline.hashes ?? {}).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new DocsIntegrityError(
      `Docs baseline page set is stale (expected ${expected.join(', ')}, found ${actual.join(', ')}). ` +
        'Restore the original historical evidence; no baseline-write mode is available.',
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
      throw new DocsIntegrityError(
        `Docs baseline entry "${key}" is invalid; restore trusted historical evidence.`,
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

async function run(argv = process.argv.slice(2), fetchImpl = fetchPage) {
  if (
    !argv.includes('--historical') ||
    argv.some((arg) => !['--historical', '--verbose'].includes(arg))
  ) {
    console.error(
      'NOT_VERIFIED: no V2 docs-drift contract is configured. Only --historical [--verbose] is supported; historical baselines cannot be rewritten.',
    );
    return 1;
  }
  console.log(
    'HISTORICAL V1 integrity only. V2 docs drift: NOT_VERIFIED. This is not an SDK compatibility or host acceptance check.',
  );
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

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error('ERROR: Baseline file missing: .sdk-baselines/opencode/docs-hashes.json');
    console.error('Restore trusted historical evidence. V2 docs drift remains NOT_VERIFIED.');
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
        'or fetch-integrity incident: verify the original tag commit; do not rewrite the historical baseline.',
    );
    return 1;
  }

  console.log(
    `Historical documentation matches OpenCode v${pinnedVersion} (${pages.length} pages). V2 docs drift remains NOT_VERIFIED.`,
  );
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
