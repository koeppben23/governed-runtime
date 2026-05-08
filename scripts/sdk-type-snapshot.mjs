/**
 * SDK Type Baseline Snapshot Tool.
 *
 * Compares the installed @opencode-ai/plugin type definitions against
 * committed baseline files. Fails with exit 1 if any drift is detected.
 *
 * Usage:
 *   node scripts/sdk-type-snapshot.mjs           # Check: exit 1 if drift
 *   node scripts/sdk-type-snapshot.mjs --update   # Update baseline files
 *
 * Baseline files:
 *   .opencode-sdk-baseline/plugin-index.d.ts
 *   .opencode-sdk-baseline/plugin-tool.d.ts
 *
 * Source files:
 *   node_modules/@opencode-ai/plugin/dist/index.d.ts
 *   node_modules/@opencode-ai/plugin/dist/tool.d.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const FILES = [
  {
    source: path.join(root, 'node_modules', '@opencode-ai', 'plugin', 'dist', 'index.d.ts'),
    baseline: path.join(root, '.opencode-sdk-baseline', 'plugin-index.d.ts'),
    label: 'plugin/dist/index.d.ts',
  },
  {
    source: path.join(root, 'node_modules', '@opencode-ai', 'plugin', 'dist', 'tool.d.ts'),
    baseline: path.join(root, '.opencode-sdk-baseline', 'plugin-tool.d.ts'),
    label: 'plugin/dist/tool.d.ts',
  },
];

/**
 * Normalize content for comparison: convert CRLF to LF, trim trailing
 * whitespace per line, ensure single trailing newline.
 */
function normalize(content) {
  return (
    content
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .replace(/\n+$/, '') + '\n'
  );
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Produce a minimal unified-diff-style output showing which lines changed.
 */
function simpleDiff(label, baselineContent, sourceContent) {
  const baseLines = baselineContent.split('\n');
  const srcLines = sourceContent.split('\n');
  const lines = [];
  const maxLen = Math.max(baseLines.length, srcLines.length);
  for (let i = 0; i < maxLen; i++) {
    const bl = baseLines[i] ?? '';
    const sl = srcLines[i] ?? '';
    if (bl !== sl) {
      lines.push(`  Line ${i + 1}:`);
      lines.push(`    - ${bl}`);
      lines.push(`    + ${sl}`);
    }
  }
  return [`--- ${label} (baseline)`, `+++ ${label} (installed)`, ...lines].join('\n');
}

function run() {
  const isUpdate = process.argv.includes('--update');

  // ÔöÇÔöÇ Pre-flight: source files must exist ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  for (const f of FILES) {
    if (!fs.existsSync(f.source)) {
      console.error(`ERROR: Source file not found: ${f.source}`);
      console.error('Run "npm ci" to install dependencies first.');
      process.exit(1);
    }
  }

  if (isUpdate) {
    // ÔöÇÔöÇ Update mode ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    for (const f of FILES) {
      const content = normalize(fs.readFileSync(f.source, 'utf-8'));
      fs.mkdirSync(path.dirname(f.baseline), { recursive: true });
      fs.writeFileSync(f.baseline, content, 'utf-8');
      console.log(`Updated: ${path.relative(root, f.baseline)} (${sha256(content).slice(0, 12)})`);
    }

    // Write version metadata
    let version = 'unknown';
    try {
      const pkg = JSON.parse(
        fs.readFileSync(
          path.join(root, 'node_modules', '@opencode-ai', 'plugin', 'package.json'),
          'utf-8',
        ),
      );
      version = pkg.version;
    } catch {
      /* best-effort */
    }
    const meta = {
      updated: new Date().toISOString(),
      version,
      files: FILES.map((f) => ({
        label: f.label,
        hash: sha256(normalize(fs.readFileSync(f.source, 'utf-8'))),
      })),
    };
    fs.writeFileSync(
      path.join(root, '.opencode-sdk-baseline', 'version.json'),
      JSON.stringify(meta, null, 2) + '\n',
      'utf-8',
    );
    console.log(`Baseline updated for @opencode-ai/plugin@${version}`);
    process.exit(0);
  }

  // ÔöÇÔöÇ Check mode ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  let drifted = false;
  for (const f of FILES) {
    if (!fs.existsSync(f.baseline)) {
      console.error(`ERROR: Baseline file missing: ${path.relative(root, f.baseline)}`);
      console.error('Run "node scripts/sdk-type-snapshot.mjs --update" to create the baseline.');
      drifted = true;
      continue;
    }

    const sourceContent = normalize(fs.readFileSync(f.source, 'utf-8'));
    const baselineContent = normalize(fs.readFileSync(f.baseline, 'utf-8'));

    if (sourceContent !== baselineContent) {
      console.error(`DRIFT DETECTED: ${f.label}`);
      console.error(`  Baseline hash: ${sha256(baselineContent).slice(0, 12)}`);
      console.error(`  Installed hash: ${sha256(sourceContent).slice(0, 12)}`);
      console.error('');
      console.error(simpleDiff(f.label, baselineContent, sourceContent));
      console.error('');
      drifted = true;
    } else {
      console.log(`OK: ${f.label} (${sha256(sourceContent).slice(0, 12)})`);
    }
  }

  if (drifted) {
    console.error('');
    console.error('SDK type drift detected. Review the changes above, then run:');
    console.error('  node scripts/sdk-type-snapshot.mjs --update');
    process.exit(1);
  }

  console.log('All SDK type baselines match.');
  process.exit(0);
}

run();
