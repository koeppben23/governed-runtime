#!/usr/bin/env node

/**
 * check-maintainability-ratchet.mjs
 *
 * Executable authority for the monotonic maintainability ratchet.
 *
 * The clean-code targets are `complexity: 12`, `max-lines-per-function: 80`,
 * `max-params: 5`. The ESLint configuration keeps transitional hard ceilings
 * (`25 / 120 / 5`) so the repository stays lintable while the debt is drained.
 * This check measures the ACTUAL TypeScript production program from
 * `tsconfig.json` against the targets and compares the result with the
 * committed baseline (`scripts/maintainability-baseline.json`):
 *
 * - a finding that is new or worse than the baseline fails;
 * - a finding that is better than the baseline fails until the baseline is
 *   lowered in the same change (the baseline is an exact debt snapshot, never
 *   a maximum);
 * - a finding that disappeared fails until its baseline entry is removed;
 * - a new metric `eslint-disable` suppression fails; a removed one fails until
 *   its baseline entry is removed.
 *
 * Inline configuration is disabled for the measurement (`allowInlineConfig:
 * false`), so suppressions can never hide a finding. Finding identity is
 * `rule + repo-relative file + AST-derived function identity` — line numbers are
 * diagnostics only, so moving code cannot masquerade as new debt.
 *
 * Usage:
 *   node scripts/check-maintainability-ratchet.mjs            # read-only check
 *   node scripts/check-maintainability-ratchet.mjs --update   # monotonic update
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ESLint } from 'eslint';
import ts from 'typescript';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const BASELINE_PATH = path.join(SCRIPT_DIR, 'maintainability-baseline.json');

/** Clean-code targets. The baseline must not contain values at or below them. */
export const TARGETS = Object.freeze({
  complexity: 12,
  maxLinesPerFunction: 80,
  maxParams: 5,
});

export const BASELINE_VERSION = 1;

const METRIC_RULES = ['complexity', 'max-lines-per-function', 'max-params'];

// ─── Function identity ────────────────────────────────────────────────────────

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function enclosingFunction(node) {
  let current = node;
  while (current !== undefined) {
    if (isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function deepestNodeAt(node, position, sourceFile) {
  let current = node;
  for (;;) {
    let next;
    for (const child of current.getChildren(sourceFile)) {
      if (child.getStart(sourceFile) <= position && position < child.getEnd()) {
        next = child;
        break;
      }
    }
    if (next === undefined) return current;
    current = next;
  }
}

function classNameOf(node) {
  let current = node.parent;
  while (current !== undefined) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      if (current.name !== undefined) return current.name.text;
      const variable = current.parent;
      if (ts.isVariableDeclaration(variable) && ts.isIdentifier(variable.name)) {
        return variable.name.text;
      }
      return 'anonymousClass';
    }
    current = current.parent;
  }
  return 'anonymousClass';
}

function memberName(node) {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (node.name !== undefined && ts.isIdentifier(node.name)) return node.name.text;
  return '<computed>';
}

/**
 * A stable name for a function expression / arrow, but only when it is the
 * direct initializer/property value. A callback nested inside an array, object,
 * or call argument is anonymous and gets the ordinal fallback instead.
 */
function expressionBindingName(node) {
  let current = node.parent;
  while (current !== undefined && ts.isParenthesizedExpression(current)) {
    current = current.parent;
  }
  if (current === undefined) return undefined;
  if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
  if (ts.isPropertyAssignment(current) && current.name !== undefined) {
    return current.name.getText();
  }
  if (ts.isPropertyDeclaration(current) && ts.isIdentifier(current.name)) {
    return current.name.text;
  }
  if (ts.isBindingElement(current) && ts.isIdentifier(current.name)) return current.name.text;
  return undefined;
}

function ordinalAmongKind(node) {
  const parent = node.parent;
  if (parent === undefined) return 0;
  const siblings = [];
  parent.forEachChild((child) => {
    if (isFunctionLike(child) && child.kind === node.kind) siblings.push(child);
  });
  const index = siblings.indexOf(node);
  return index === -1 ? 0 : index;
}

function functionIdentity(node) {
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
    return `function:${node.name.text}`;
  }
  if (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
    return `method:${classNameOf(node)}.${memberName(node)}`;
  }
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return `accessor:${classNameOf(node)}.${memberName(node)}`;
  }
  const binding = expressionBindingName(node);
  const label = ts.isArrowFunction(node) ? 'arrow' : 'function-expression';
  if (binding !== undefined) return `${label}:${binding}`;
  const parentKind = node.parent === undefined ? 'unknown' : ts.SyntaxKind[node.parent.kind];
  return `${label}:anonymous:${parentKind}:${ordinalAmongKind(node)}`;
}

/**
 * AST-derived identity of the innermost function containing `line`/`column`
 * (1-based), or `undefined` when the position is not inside a function.
 */
export function functionIdentityAt(sourceFile, line, column) {
  const position = ts.getPositionOfLineAndCharacter(sourceFile, line - 1, column - 1);
  const fn = enclosingFunction(deepestNodeAt(sourceFile, position, sourceFile));
  return fn === undefined ? undefined : functionIdentity(fn);
}

// ─── Metric suppression inventory ─────────────────────────────────────────────

function lineOfIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function nextCodeLine(text, fromLine) {
  const lines = text.split('\n');
  for (let i = fromLine; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    return i + 1;
  }
  return undefined;
}

function commentsOf(text) {
  const out = [];
  const regex = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    out.push({ text: match[0], index: match.index });
  }
  return out;
}

function directiveRules(comment) {
  const body = comment
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .replace(/^\s*\/\/\s?/, '');
  const directive = /^\s*eslint-disable(-next-line|-line)?\b([^\n]*)$/.exec(body);
  if (directive === null) return undefined;
  const suffix = directive[1] ?? '';
  const rulesText = (directive[2] ?? '').split('--')[0].trim();
  const rules =
    rulesText.length === 0
      ? [...METRIC_RULES]
      : rulesText
          .split(/[\s,]+/)
          .filter((rule) => METRIC_RULES.includes(rule));
  if (rules.length === 0) return { suffix, rules: [] };
  return { suffix, rules };
}

/**
 * Rule-granular metric suppression inventory. One directive suppressing two
 * metric rules produces two entries; a bare `eslint-disable` is treated as
 * suppressing every metric rule (fail-closed).
 */
export function collectMetricSuppressions(sourceFile, relativePath) {
  const text = sourceFile.getFullText();
  const out = [];
  for (const comment of commentsOf(text)) {
    const directive = directiveRules(comment.text);
    if (directive === undefined || directive.rules.length === 0) continue;
    const commentLine = lineOfIndex(text, comment.index);
    let identity;
    if (directive.suffix === '-next-line') {
      const target = nextCodeLine(text, commentLine);
      identity =
        target === undefined ? undefined : functionIdentityAt(sourceFile, target, 1);
    } else if (directive.suffix === '-line') {
      identity = functionIdentityAt(sourceFile, commentLine, 1);
    }
    // File/block-level directives have no function anchor.
    const anchor = identity ?? `file:${relativePath}`;
    for (const rule of directive.rules) {
      out.push({ file: relativePath, function: anchor, rule });
    }
  }
  return out;
}

// ─── Measurement ──────────────────────────────────────────────────────────────

function metricValueFor(rule, message) {
  const pattern =
    rule === 'complexity'
      ? /complexity of (\d+)/
      : rule === 'max-lines-per-function'
        ? /too many lines \((\d+)\)/
        : /too many parameters \((\d+)\)/;
  const match = pattern.exec(message);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function parseProductionProgram() {
  const configPath = path.join(REPO_ROOT, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) {
    throw new Error(
      `Cannot read tsconfig.json: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, REPO_ROOT);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const srcPrefix = `${path.join(REPO_ROOT, 'src')}${path.sep}`;
  return program
    .getSourceFiles()
    .filter((sourceFile) => !sourceFile.isDeclarationFile && sourceFile.fileName.startsWith(srcPrefix));
}

function relativeRepoPath(fileName) {
  return path.relative(REPO_ROOT, fileName).split(path.sep).join('/');
}

/** Measure the production program against the clean-code targets. */
export async function measureMaintainability() {
  const programSources = parseProductionProgram();
  // Program source files do not carry parent pointers; re-parse with
  // `setParentNodes` so AST identity can walk the containment chain.
  const sourceFiles = programSources.map((sourceFile) =>
    ts.createSourceFile(sourceFile.fileName, sourceFile.text, ts.ScriptTarget.Latest, true),
  );
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    warnIgnored: false,
    allowInlineConfig: false,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        rules: {
          complexity: ['warn', { max: TARGETS.complexity }],
          'max-lines-per-function': [
            'warn',
            { max: TARGETS.maxLinesPerFunction, skipBlankLines: true, skipComments: true },
          ],
          'max-params': ['warn', { max: TARGETS.maxParams }],
        },
      },
    ],
  });

  const results = await eslint.lintFiles(sourceFiles.map((sourceFile) => sourceFile.fileName));
  const sourceByPath = new Map(sourceFiles.map((sourceFile) => [sourceFile.fileName, sourceFile]));
  const entries = [];
  for (const result of results) {
    const sourceFile = sourceByPath.get(result.filePath);
    if (sourceFile === undefined) continue;
    const file = relativeRepoPath(result.filePath);
    for (const message of result.messages) {
      if (message.ruleId === null || !METRIC_RULES.includes(message.ruleId)) continue;
      const value = metricValueFor(message.ruleId, message.message);
      if (value === undefined) {
        throw new Error(`Cannot parse ${message.ruleId} value from: ${message.message}`);
      }
      const identity = functionIdentityAt(sourceFile, message.line, message.column);
      if (identity === undefined) {
        throw new Error(`${file}:${message.line}: ${message.ruleId} has no function identity`);
      }
      entries.push({ file, function: identity, rule: message.ruleId, value });
    }
  }

  const metricSuppressions = [];
  for (const sourceFile of sourceFiles) {
    metricSuppressions.push(
      ...collectMetricSuppressions(sourceFile, relativeRepoPath(sourceFile.fileName)),
    );
  }

  return {
    targets: { ...TARGETS },
    entries: sortEntries(entries),
    metricSuppressions: sortSuppressions(metricSuppressions),
  };
}

// ─── Baseline + comparison ────────────────────────────────────────────────────

function compareKeys(a, b) {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.function !== b.function) return a.function < b.function ? -1 : 1;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  return 0;
}

function sortEntries(entries) {
  return [...entries].sort(compareKeys);
}

function sortSuppressions(metricSuppressions) {
  return [...metricSuppressions].sort(compareKeys);
}

function findingKey(entry) {
  return `${entry.rule}\u0000${entry.file}\u0000${entry.function}`;
}

export function buildBaseline(current) {
  return {
    version: BASELINE_VERSION,
    targets: { ...current.targets },
    entries: sortEntries(current.entries),
    metricSuppressions: sortSuppressions(current.metricSuppressions),
  };
}

function targetsMatch(targets) {
  return (
    targets !== null &&
    typeof targets === 'object' &&
    targets.complexity === TARGETS.complexity &&
    targets.maxLinesPerFunction === TARGETS.maxLinesPerFunction &&
    targets.maxParams === TARGETS.maxParams
  );
}

function validateBaseline(baseline) {
  if (baseline === null || typeof baseline !== 'object') return 'baseline is not an object';
  if (baseline.version !== BASELINE_VERSION) return `unsupported baseline version ${baseline.version}`;
  if (!targetsMatch(baseline.targets)) {
    return 'baseline targets do not match the clean-code targets (12 / 80 / 5)';
  }
  for (const entry of baseline.entries ?? []) {
    if (
      typeof entry.file !== 'string' ||
      typeof entry.function !== 'string' ||
      typeof entry.rule !== 'string' ||
      typeof entry.value !== 'number'
    ) {
      return 'malformed baseline finding entry';
    }
  }
  for (const suppression of baseline.metricSuppressions ?? []) {
    if (
      typeof suppression.file !== 'string' ||
      typeof suppression.function !== 'string' ||
      typeof suppression.rule !== 'string'
    ) {
      return 'malformed baseline suppression entry';
    }
  }
  return undefined;
}

/**
 * Compare the committed baseline with the current measurement.
 *
 * Returns an empty array when the baseline is an exact snapshot of the current
 * debt. Every deviation is a failure:
 * - `new` / `worsened`: new or increased debt;
 * - `improved` / `resolved`: improvement not yet locked into the baseline;
 * - `new-suppression` / `stale-suppression`: suppression inventory drift.
 */
export function diffMaintainability(baseline, current) {
  const problems = [];
  const baselineFindings = new Map((baseline.entries ?? []).map((entry) => [findingKey(entry), entry]));
  const currentFindings = new Map((current.entries ?? []).map((entry) => [findingKey(entry), entry]));

  for (const [key, entry] of currentFindings) {
    const base = baselineFindings.get(key);
    if (base === undefined) {
      problems.push({ kind: 'new', ...entry });
    } else if (entry.value > base.value) {
      problems.push({ kind: 'worsened', baselineValue: base.value, ...entry });
    } else if (entry.value < base.value) {
      problems.push({ kind: 'improved', baselineValue: base.value, ...entry });
    }
  }
  for (const [key, entry] of baselineFindings) {
    if (!currentFindings.has(key)) {
      problems.push({ kind: 'resolved', baselineValue: entry.value, ...entry });
    }
  }

  const baselineSuppressions = new Map(
    (baseline.metricSuppressions ?? []).map((entry) => [findingKey(entry), entry]),
  );
  const currentSuppressions = new Map(
    (current.metricSuppressions ?? []).map((entry) => [findingKey(entry), entry]),
  );
  for (const [key, entry] of currentSuppressions) {
    if (!baselineSuppressions.has(key)) problems.push({ kind: 'new-suppression', ...entry });
  }
  for (const [key, entry] of baselineSuppressions) {
    if (!currentSuppressions.has(key)) problems.push({ kind: 'stale-suppression', ...entry });
  }

  return problems;
}

/**
 * Monotonic `--update`: an existing baseline may only be lowered or shrunk.
 * New findings, worsened values, and new suppressions are refused, so the
 * ratchet cannot be laundered through an update.
 */
export function applyMonotonicUpdate(baseline, current) {
  const violations = [];
  const baselineFindings = new Map((baseline.entries ?? []).map((entry) => [findingKey(entry), entry]));
  const baselineSuppressions = new Set(
    (baseline.metricSuppressions ?? []).map((entry) => findingKey(entry)),
  );

  const entries = [];
  for (const entry of current.entries ?? []) {
    const base = baselineFindings.get(findingKey(entry));
    if (base === undefined) {
      violations.push({ kind: 'new', ...entry });
      continue;
    }
    if (entry.value > base.value) {
      violations.push({ kind: 'worsened', baselineValue: base.value, ...entry });
      continue;
    }
    entries.push(entry);
  }
  const metricSuppressions = [];
  for (const entry of current.metricSuppressions ?? []) {
    if (!baselineSuppressions.has(findingKey(entry))) {
      violations.push({ kind: 'new-suppression', ...entry });
      continue;
    }
    metricSuppressions.push(entry);
  }

  return {
    violations,
    next: buildBaseline({ targets: current.targets, entries, metricSuppressions }),
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    throw new Error(`Cannot parse ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
  }
  return parsed;
}

function describeProblem(problem) {
  const target = `${problem.rule}(${problem.function}) in ${problem.file}`;
  switch (problem.kind) {
    case 'new':
      return `NEW       ${target} = ${problem.value} (target ${TARGETS[targetKey(problem.rule)]})`;
    case 'worsened':
      return `WORSENED  ${target}: baseline ${problem.baselineValue} -> ${problem.value}`;
    case 'improved':
      return `IMPROVED  ${target}: baseline ${problem.baselineValue} -> ${problem.value}; lower the baseline entry`;
    case 'resolved':
      return `RESOLVED  ${target}: baseline ${problem.baselineValue} is gone; remove the baseline entry`;
    case 'new-suppression':
      return `SUPPRESS  new metric suppression ${problem.rule} in ${problem.file}`;
    case 'stale-suppression':
      return `SUPPRESS  suppression ${problem.rule} in ${problem.file} is gone; remove the baseline entry`;
    default:
      return `${problem.kind}      ${target}`;
  }
}

function targetKey(rule) {
  if (rule === 'complexity') return 'complexity';
  if (rule === 'max-lines-per-function') return 'maxLinesPerFunction';
  return 'maxParams';
}

function writeBaseline(baseline) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
}

async function main() {
  const update = process.argv.includes('--update');
  const current = await measureMaintainability();
  const baseline = readBaseline();
  const baselineProblem = baseline === null ? undefined : validateBaseline(baseline);
  if (baselineProblem !== undefined) {
    console.error(`[maintainability-ratchet] ERROR: ${baselineProblem}`);
    process.exit(1);
  }

  if (update) {
    if (baseline === null) {
      writeBaseline(buildBaseline(current));
      console.log(
        `[maintainability-ratchet] baseline bootstrapped: ${current.entries.length} findings, ` +
          `${current.metricSuppressions.length} suppressions`,
      );
      return;
    }
    const { violations, next } = applyMonotonicUpdate(baseline, current);
    if (violations.length > 0) {
      console.error('[maintainability-ratchet] --update refused: it would increase debt:');
      for (const violation of violations) console.error(`  - ${describeProblem(violation)}`);
      process.exit(1);
    }
    writeBaseline(next);
    console.log(
      `[maintainability-ratchet] baseline updated: ${next.entries.length} findings, ` +
        `${next.metricSuppressions.length} suppressions`,
    );
    return;
  }

  if (baseline === null) {
    console.error(
      '[maintainability-ratchet] ERROR: baseline missing; run --update once to bootstrap it',
    );
    process.exit(1);
  }

  const problems = diffMaintainability(baseline, current);
  if (problems.length > 0) {
    console.error(`[maintainability-ratchet] ${problems.length} violation(s):`);
    for (const problem of problems) console.error(`  - ${describeProblem(problem)}`);
    process.exit(1);
  }
  console.log(
    `[maintainability-ratchet] OK: ${current.entries.length} findings, ` +
      `${current.metricSuppressions.length} suppressions match the baseline`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
