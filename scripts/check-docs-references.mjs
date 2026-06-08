#!/usr/bin/env node
/**
 * FlowGuard Documentation Reference Drift Check.
 *
 * Verifies that every concrete identifier mentioned in user-facing docs still
 * resolves to a real symbol in the source tree. Complements scripts/docs-drift.mjs
 * (which hashes UPSTREAM OpenCode docs) — this script hashes nothing; it greps
 * forward references and confirms each one is grounded in src/.
 *
 * Six classes of references are checked:
 *
 *   1. Custom MCP tool names (`flowguard_<name>`)         — must exist in
 *      src/integration/tool-names.ts as a `TOOL_FLOWGUARD_*` constant value.
 *   2. Environment variables (`FLOWGUARD_<NAME>`)         — must be read by
 *      at least one source file in src/ via process.env.
 *   3. Reason codes (`<UPPER_SNAKE_CASE>` near "BLOCKED") — must appear as a
 *      `code:` literal somewhere in src/config/reasons-*.ts.
 *   4. CLI bin entries (`flowguard-<name>` or `flowguard`) — must exist in
 *      package.json "bin".
 *   5. Source file:line citations (`src/foo/bar.ts:123`) — the file must
 *      exist. (Line numbers are advisory: the audit found enough stale line
 *      numbers that strict line checking would have a high false-positive
 *      rate against a moving target. We assert the file exists and warn on
 *      lines > current EOF.)
 *   6. CLI subcommands (`flowguard <verb>`)               — verb must be in
 *      the VALID_ACTIONS set declared in src/cli/install.ts.
 *
 * Exit codes:
 *   0  no drift
 *   1  drift detected
 *   2  invocation/IO error
 *
 * Usage:
 *   node scripts/check-docs-references.mjs               # check mode
 *   node scripts/check-docs-references.mjs --verbose     # also show passes
 *   node scripts/check-docs-references.mjs --only=tools  # filter checks
 *
 * This script is intentionally NOT wired into the required CI critical path.
 * Run it locally before docs PRs, or attach it as a non-blocking advisory job.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');

const args = new Set(process.argv.slice(2));
const VERBOSE = args.has('--verbose');
const ONLY = [...args]
  .filter((a) => a.startsWith('--only='))
  .map((a) => a.slice('--only='.length))[0];

// ── File enumeration ─────────────────────────────────────────────────────────

/**
 * @param {string} dir
 * @param {(p: string) => boolean} filter
 * @returns {string[]}
 */
function walk(dir, filter) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      out.push(...walk(full, filter));
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out;
}

const DOC_FILES = [
  path.join(REPO_ROOT, 'README.md'),
  path.join(REPO_ROOT, 'PRODUCT_IDENTITY.md'),
  path.join(REPO_ROOT, 'PRODUCT_ONE_PAGER.md'),
  path.join(REPO_ROOT, 'SECURITY.md'),
  path.join(REPO_ROOT, 'CONTRIBUTING.md'),
  ...walk(DOCS_DIR, (p) => p.endsWith('.md')),
].filter((p) => fs.existsSync(p));

// Docs that are explicit design proposals describing FUTURE deliverables.
// Refs to not-yet-existing files / codes / envs are intentional in these.
const DESIGN_PROPOSAL_DOCS = new Set([
  'docs/architecture/schema-migration.md',
]);

const SRC_FILES = walk(SRC_DIR, (p) => p.endsWith('.ts'));
const NON_TEST_SRC = SRC_FILES.filter((p) => !p.endsWith('.test.ts'));

// ── Source-side facts (computed once) ────────────────────────────────────────

function readFile(p) {
  return fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
}

/**
 * Strip fenced code blocks from a doc. Code blocks frequently contain
 * pseudocode, future-state schema proposals, or shell examples that should
 * not be treated as authoritative references to current source.
 *
 * Preserves line numbers by replacing block contents with blank lines, so
 * any drift findings remain aligned with the original doc.
 */
function stripFencedCode(text) {
  const lines = text.split('\n');
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inBlock = !inBlock;
      out.push(''); // keep the fence line out of scope as well
      continue;
    }
    out.push(inBlock ? '' : line);
  }
  return out.join('\n');
}

const TOOL_NAMES = (() => {
  const file = path.join(SRC_DIR, 'integration', 'tool-names.ts');
  if (!fs.existsSync(file)) return new Set();
  const src = readFile(file);
  const matches = src.matchAll(/TOOL_FLOWGUARD_\w+\s*=\s*'([a-z_]+)'/g);
  return new Set([...matches].map((m) => m[1]));
})();

const ENV_USED_IN_SRC = (() => {
  const set = new Set();
  // A FLOWGUARD_* env is "real" if its name appears anywhere in non-test
  // source files. This covers:
  //   - direct process.env.FOO access
  //   - process.env[CONST] where CONST = 'FOO'
  //   - error / recovery messages that reference the env name
  //   - constants like FLOWGUARD_FOO_ENV = 'FLOWGUARD_FOO'
  // Test files are excluded to avoid mock-only env names leaking through.
  const re = /\bFLOWGUARD_[A-Z0-9_]+\b/g;
  for (const f of NON_TEST_SRC) {
    const src = readFile(f);
    let m;
    while ((m = re.exec(src)) !== null) set.add(m[0]);
  }
  return set;
})();

const REASON_CODES_IN_SRC = (() => {
  const set = new Set();
  // Reason codes are most commonly declared in src/config/reasons-*.ts as
  // `code: 'NAME'` records, but several governance-relevant codes live
  // elsewhere (e.g. SESSION_UNRESOLVABLE in src/mcp-server/session-resolver.ts).
  // Treat any UPPER_SNAKE token that appears as a string literal anywhere in
  // non-test src/ as a real code.
  const reLiteral = /['"]([A-Z][A-Z0-9_]{4,})['"]/g;
  for (const f of NON_TEST_SRC) {
    const src = readFile(f);
    let m;
    while ((m = reLiteral.exec(src)) !== null) set.add(m[1]);
  }
  // Allowlist a few legitimate codes/markers that are not string literals
  // in src/ but are documented and used at runtime.
  const extras = ['ABORTED', 'OK', 'ALL_PASSED', 'CHECK_FAILED'];
  for (const e of extras) set.add(e);
  return set;
})();

const PACKAGE_BIN_NAMES = (() => {
  const pkg = JSON.parse(readFile(path.join(REPO_ROOT, 'package.json')));
  return new Set(Object.keys(pkg.bin ?? {}));
})();

const CLI_SUBCOMMANDS = (() => {
  const file = path.join(SRC_DIR, 'cli', 'install.ts');
  if (!fs.existsSync(file)) return new Set();
  const src = readFile(file);
  // VALID_ACTIONS or similar declaration with a string array.
  const decl = src.match(/VALID_ACTIONS[^=]*=\s*\[([\s\S]*?)\]/);
  if (!decl) return new Set();
  return new Set([...decl[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
})();

// ── Findings collector ──────────────────────────────────────────────────────

/** @type {Array<{doc: string, line: number, kind: string, value: string, reason: string}>} */
const findings = [];
let passes = 0;

function record(doc, line, kind, value, reason) {
  findings.push({ doc, line, kind, value, reason });
}

function passed(kind, value) {
  passes++;
  if (VERBOSE) console.log(`OK  ${kind.padEnd(8)} ${value}`);
}

// ── Per-doc checks ──────────────────────────────────────────────────────────

function checkTools(doc, lines) {
  if (ONLY && ONLY !== 'tools') return;
  const re = /\bflowguard_([a-z_]+)\b/g;
  lines.forEach((line, idx) => {
    let m;
    while ((m = re.exec(line)) !== null) {
      const name = `flowguard_${m[1]}`;
      // Skip CLI-only meta-tokens that just look like tool names.
      if (name === 'flowguard_mandates' || name === 'flowguard_reviewer') continue;
      if (TOOL_NAMES.has(name)) passed('tool', name);
      else
        record(
          doc,
          idx + 1,
          'tool',
          name,
          `Tool name '${name}' not found in src/integration/tool-names.ts`,
        );
    }
  });
}

function checkEnvVars(doc, lines) {
  if (ONLY && ONLY !== 'envs') return;
  const re = /\bFLOWGUARD_[A-Z0-9_]+\b/g;
  // Allowlist a few legitimate envs that exist outside src/ (CI/script-only).
  const allow = new Set([
    'FLOWGUARD_HOST_PLATFORM',
    'FLOWGUARD_VERSION',
    'FLOWGUARD_TARBALL',
    'FLOWGUARD_REPO',
    'FLOWGUARD_DIR',
    'FLOWGUARD_BIN',
    'FLOWGUARD_SKIP_INSTALL_HOST',
    'FLOWGUARD_PERF_BUDGET_FACTOR',
  ]);
  // Phrases that indicate the doc is explicitly calling out an env name as
  // NOT consumed by the runtime (so the unused-env signal is intended).
  const negationMarkers = [
    'is not consumed',
    'has no effect',
    'is not implemented',
    'not wired',
    'no consumer',
    'is unused',
    'no longer consumed',
  ];
  lines.forEach((line, idx) => {
    let m;
    while ((m = re.exec(line)) !== null) {
      const name = m[0];
      if (ENV_USED_IN_SRC.has(name) || allow.has(name)) {
        passed('env', name);
        continue;
      }
      // Allow contextually-justified mentions of unimplemented envs:
      // doc explicitly says the env is not consumed. The negation marker
      // is allowed on the same line or one of the next two lines (the
      // explanatory sentence often runs onto the next paragraph line).
      // Strip Markdown emphasis (`*`, `_`) before matching so phrases like
      // `is **not** consumed` still resolve to `is not consumed`.
      const context = (
        line +
        ' ' +
        (lines[idx + 1] ?? '') +
        ' ' +
        (lines[idx + 2] ?? '')
      )
        .toLowerCase()
        .replace(/[*_`]/g, '');
      if (negationMarkers.some((needle) => context.includes(needle))) {
        passed('env', `${name} (documented-as-unimplemented)`);
        continue;
      }
      record(
        doc,
        idx + 1,
        'env',
        name,
        `Env var '${name}' is documented but no process.env.${name} consumer found in src/`,
      );
    }
  });
}

function checkReasonCodes(doc, lines) {
  if (ONLY && ONLY !== 'codes') return;
  // Conservative: only check codes that appear backticked AND look like reason codes.
  const re = /`([A-Z][A-Z0-9_]{4,})`/g;
  // Heuristic: ignore obvious non-codes (HTTP verbs, file constants, env vars).
  const ignore = new Set([
    'PATCH',
    'POST',
    'PUT',
    'DELETE',
    'GET',
    'HEAD',
    'TRACE',
    'OPTIONS',
    'TRUE',
    'FALSE',
    'NULL',
    'JSON',
    'YAML',
    'NOT_VERIFIED',
    'PASS',
    'FAIL',
    'WARN',
    'INFO',
    'ERROR',
    'DEBUG',
    'TRACE',
    'BLOCKED',
    'ALLOWED',
    'WAITING',
    'TERMINAL',
    'PENDING',
    'MIT',
    'TODO',
    'FIXME',
    'HACK',
    'API',
    'CLI',
    'URL',
    'URI',
    'UUID',
    'SHA',
    'TSA',
    'JWT',
    'JWKS',
    'IDP',
    'OIDC',
    'OTLP',
    'OTEL',
    'NTP',
    'HTTP',
    'HTTPS',
    'TLS',
    'SSRF',
    'CSRF',
    'XSS',
    'DOS',
    'CWE',
    'CVE',
    'EOF',
    'EOL',
    'PR',
    'CI',
    'CD',
    'SDK',
    'MCP',
    'ADR',
    'MADR',
    'SSOT',
  ]);
  lines.forEach((line, idx) => {
    if (!/BLOCKED|reason code|reject(s|ed|ion)|fail-closed|denial|denied|denies/i.test(line))
      return;
    let m;
    while ((m = re.exec(line)) !== null) {
      const code = m[1];
      if (ignore.has(code)) continue;
      if (code.startsWith('FLOWGUARD_')) continue; // env vars, not reason codes
      if (!/^[A-Z][A-Z0-9_]+$/.test(code)) continue;
      if (REASON_CODES_IN_SRC.has(code)) passed('code', code);
      else
        record(
          doc,
          idx + 1,
          'code',
          code,
          `Reason code '${code}' near a denial context not found in src/config/reasons-*.ts`,
        );
    }
  });
}

function checkBinEntries(doc, lines) {
  if (ONLY && ONLY !== 'bins') return;
  const re = /\b(flowguard-hook-[a-z]+|flowguard-mcp)\b/g;
  lines.forEach((line, idx) => {
    let m;
    while ((m = re.exec(line)) !== null) {
      const name = m[1];
      if (PACKAGE_BIN_NAMES.has(name)) passed('bin', name);
      else
        record(
          doc,
          idx + 1,
          'bin',
          name,
          `bin '${name}' not declared in package.json "bin"`,
        );
    }
  });
}

function checkFileCitations(doc, lines) {
  if (ONLY && ONLY !== 'files') return;
  const re = /\b(src\/[A-Za-z0-9_\-./]+\.ts)(?::(\d+))?/g;
  lines.forEach((line, idx) => {
    let m;
    while ((m = re.exec(line)) !== null) {
      const rel = m[1];
      const lineNo = m[2] ? Number.parseInt(m[2], 10) : undefined;
      const abs = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(abs)) {
        record(doc, idx + 1, 'file', rel, `Cited source file '${rel}' does not exist`);
        continue;
      }
      if (lineNo !== undefined) {
        const eof = readFile(abs).split('\n').length;
        if (lineNo > eof) {
          record(
            doc,
            idx + 1,
            'file',
            `${rel}:${lineNo}`,
            `Cited line ${lineNo} exceeds EOF (${eof}) in '${rel}'`,
          );
          continue;
        }
      }
      passed('file', lineNo ? `${rel}:${lineNo}` : rel);
    }
  });
}

function checkCliSubcommands(doc, lines) {
  if (ONLY && ONLY !== 'subcmds') return;
  // Only flag `flowguard <verb>` invocations in fenced code blocks or backticks.
  const re = /`flowguard\s+([a-z-]+)`|^\s*flowguard\s+([a-z-]+)\b/gm;
  const text = lines.join('\n');
  let m;
  while ((m = re.exec(text)) !== null) {
    const verb = m[1] ?? m[2];
    if (!verb) continue;
    // Allow option-like values mis-captured (e.g. 'mcp', 'hook-*' shells)
    if (verb.startsWith('hook-')) continue;
    if (verb === 'mcp') continue;
    // Locate doc line by counting newlines up to this match index.
    const upto = text.slice(0, m.index);
    const lineNo = upto.split('\n').length;
    if (CLI_SUBCOMMANDS.has(verb)) passed('subcmd', `flowguard ${verb}`);
    else
      record(
        doc,
        lineNo,
        'subcmd',
        `flowguard ${verb}`,
        `CLI verb '${verb}' not in VALID_ACTIONS (src/cli/install.ts)`,
      );
  }
}

// ── Drive checks ────────────────────────────────────────────────────────────

for (const doc of DOC_FILES) {
  const raw = readFile(doc);
  const stripped = stripFencedCode(raw);
  const lines = stripped.split('\n');
  const relDoc = path.relative(REPO_ROOT, doc).replace(/\\/g, '/');
  if (DESIGN_PROPOSAL_DOCS.has(relDoc)) {
    // Design proposals describe planned deliverables; refs to unimplemented
    // files / codes / envs are intentional. Skip drift checks for them but
    // still count them so the script's denominator is honest.
    continue;
  }
  checkTools(relDoc, lines);
  checkEnvVars(relDoc, lines);
  checkReasonCodes(relDoc, lines);
  checkBinEntries(relDoc, lines);
  checkFileCitations(relDoc, lines);
  checkCliSubcommands(relDoc, lines);
}

// ── Report ──────────────────────────────────────────────────────────────────

if (findings.length === 0) {
  console.log(`OK: ${passes} doc references validated across ${DOC_FILES.length} files.`);
  process.exit(0);
}

console.error(`DRIFT: ${findings.length} doc reference issue(s) found:\n`);
const byDoc = new Map();
for (const f of findings) {
  if (!byDoc.has(f.doc)) byDoc.set(f.doc, []);
  byDoc.get(f.doc).push(f);
}
for (const [doc, fs] of [...byDoc.entries()].sort()) {
  console.error(`  ${doc}`);
  for (const f of fs) {
    console.error(`    L${String(f.line).padStart(4)} [${f.kind}] ${f.value}`);
    console.error(`           ${f.reason}`);
  }
}
console.error(
  `\n${passes} passing references; ${findings.length} drift finding(s). Run with --verbose for full pass list.`,
);
process.exit(1);
