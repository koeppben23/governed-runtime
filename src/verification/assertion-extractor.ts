import { readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve, sep, dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';

import type { ExecutionEvidence } from './executor.js';
import type {
  AssertionExtractionResult,
  AssertionExtractionSummary,
} from '../state/evidence-validation.js';
import type { AssertionReportFormat, AssertionReportSpec } from '../state/discovery-schemas.js';

import { parseJUnitXml } from './assertion-parsers/junit-xml.js';
import { parseJestJson } from './assertion-parsers/jest-json.js';
import { parseVitestJson } from './assertion-parsers/vitest-json.js';
import { parseGoTestJson } from './assertion-parsers/go-test-json.js';

const MAX_FILES_PER_PATTERN = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

interface ReportFileSnapshot {
  path: string;
  digest: string;
  size: number;
}

export interface PreparedAssertionExtraction {
  attemptId: string;
  spec: AssertionReportSpec;
  cwd: string;
  preExecutionSnapshot?: ReportFileSnapshot[];
  runSpecificPattern?: string;
  runSpecificOutputArg?: string;
}

interface ParserResult {
  assertions: import('../state/evidence-validation.js').StructuredAssertionEvidence[];
  summary: AssertionExtractionSummary;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function commandSuffix(spec: AssertionReportSpec, attemptId: string): string {
  if (spec.collection !== 'run_specific') return '';
  return spec.outputArgumentTemplate.replace(/\{attemptId\}/g, attemptId);
}

export async function prepareAssertionExtraction(
  spec: AssertionReportSpec,
  cwd: string,
  attemptId: string,
): Promise<PreparedAssertionExtraction> {
  const base: Omit<PreparedAssertionExtraction, 'spec'> = {
    attemptId,
    cwd,
  };

  switch (spec.collection) {
    case 'run_specific': {
      const runSpecificPattern = spec.resultPatternTemplate.replace(/\{attemptId\}/g, attemptId);
      const runSpecificOutputArg = spec.outputArgumentTemplate.replace(/\{attemptId\}/g, attemptId);
      return { ...base, spec, runSpecificPattern, runSpecificOutputArg };
    }
    case 'snapshot_diff': {
      const preExecutionSnapshot = await takeSnapshot(cwd, spec.standardPatterns);
      return { ...base, spec, preExecutionSnapshot };
    }
    case 'stdout':
      return { ...base, spec };
  }
}

export async function completeAssertionExtraction(
  prepared: PreparedAssertionExtraction,
  execution: ExecutionEvidence,
): Promise<AssertionExtractionResult> {
  const { attemptId, spec, cwd } = prepared;

  try {
    switch (spec.collection) {
      case 'stdout':
        return extractFromStdout(attemptId, spec.format, execution.stdout);

      case 'run_specific':
        return extractFromRunSpecific(attemptId, spec.format, cwd, prepared.runSpecificPattern!);

      case 'snapshot_diff':
        return extractFromSnapshotDiff(
          attemptId,
          spec.format,
          cwd,
          spec.standardPatterns,
          prepared.preExecutionSnapshot ?? [],
        );
    }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'blocked', attemptId, reason };
  }
}

// ─── Extraction Strategies ──────────────────────────────────────────────────

async function extractFromStdout(
  attemptId: string,
  format: AssertionReportFormat,
  stdout: string,
): Promise<AssertionExtractionResult> {
  const parsed = parseWithFormat(format, stdout, '<stdout>');
  if (!parsed.assertions.length) {
    return {
      status: 'inconclusive',
      attemptId,
      reason: 'report parsing produced no test results',
    };
  }
  const digest = sha256(stdout);
  return {
    status: 'extracted',
    attemptId,
    format,
    reportDigests: [digest],
    assertions: parsed.assertions,
    summary: parsed.summary,
  };
}

async function extractFromRunSpecific(
  attemptId: string,
  format: AssertionReportFormat,
  cwd: string,
  pattern: string,
): Promise<AssertionExtractionResult> {
  const paths = await globFiles(cwd, pattern);
  if (paths.length === 0) {
    return { status: 'blocked', attemptId, reason: 'expected reports not found' };
  }
  if (paths.length > MAX_FILES_PER_PATTERN) {
    return {
      status: 'blocked',
      attemptId,
      reason: `too many report files: ${paths.length} (max ${MAX_FILES_PER_PATTERN})`,
    };
  }
  return parseAndMergeFiles(attemptId, format, cwd, paths);
}

async function extractFromSnapshotDiff(
  attemptId: string,
  format: AssertionReportFormat,
  cwd: string,
  patterns: string[],
  preSnapshot: ReportFileSnapshot[],
): Promise<AssertionExtractionResult> {
  const postSnapshot = await takeSnapshot(cwd, patterns);
  const changedPaths = diffSnapshots(preSnapshot, postSnapshot);

  if (changedPaths.length === 0) {
    return {
      status: 'blocked',
      attemptId,
      reason: 'no new report files produced',
    };
  }
  if (changedPaths.length > MAX_FILES_PER_PATTERN) {
    return {
      status: 'blocked',
      attemptId,
      reason: `too many changed report files: ${changedPaths.length} (max ${MAX_FILES_PER_PATTERN})`,
    };
  }
  return parseAndMergeFiles(attemptId, format, cwd, changedPaths);
}

// ─── Snapshot & Diff ────────────────────────────────────────────────────────

async function takeSnapshot(cwd: string, patterns: string[]): Promise<ReportFileSnapshot[]> {
  const snapshot: ReportFileSnapshot[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    const paths = await globFiles(cwd, pattern);
    for (const relPath of paths) {
      if (seen.has(relPath)) continue;
      seen.add(relPath);

      const fullPath = resolve(cwd, relPath);
      if (!isWithinCwd(fullPath, cwd)) continue;

      const info = await stat(fullPath);
      if (info.size > MAX_FILE_BYTES) continue;

      const content = await readFile(fullPath);
      const digest = sha256(content);
      snapshot.push({ path: relPath, digest, size: info.size });
    }
  }
  return snapshot;
}

function diffSnapshots(pre: ReportFileSnapshot[], post: ReportFileSnapshot[]): string[] {
  const preByPath = new Map(pre.map((s) => [s.path, s]));
  const changed: string[] = [];

  for (const postEntry of post) {
    const preEntry = preByPath.get(postEntry.path);
    if (!preEntry || preEntry.digest !== postEntry.digest || preEntry.size !== postEntry.size) {
      changed.push(postEntry.path);
    }
  }
  return changed;
}

// ─── File Parsing ───────────────────────────────────────────────────────────

async function parseAndMergeFiles(
  attemptId: string,
  format: AssertionReportFormat,
  cwd: string,
  paths: string[],
): Promise<AssertionExtractionResult> {
  const allAssertions: ParserResult['assertions'] = [];
  const allSummaries: AssertionExtractionSummary[] = [];
  const digests: string[] = [];

  for (const relPath of paths) {
    const fullPath = resolve(cwd, relPath);
    if (!isWithinCwd(fullPath, cwd)) {
      return {
        status: 'blocked',
        attemptId,
        reason: `path traversal rejected: ${relPath}`,
      };
    }

    const info = await stat(fullPath);
    if (info.size > MAX_FILE_BYTES) {
      return {
        status: 'blocked',
        attemptId,
        reason: `file too large: ${relPath} (${info.size} bytes, max ${MAX_FILE_BYTES})`,
      };
    }

    const content = await readFile(fullPath, 'utf-8');
    const parsed = parseWithFormat(format, content, relPath);
    allAssertions.push(...parsed.assertions);
    allSummaries.push(parsed.summary);
    digests.push(sha256(content));
  }

  if (allAssertions.length === 0) {
    return {
      status: 'inconclusive',
      attemptId,
      reason: 'report parsing produced no test results',
    };
  }

  return {
    status: 'extracted',
    attemptId,
    format,
    reportDigests: digests,
    assertions: allAssertions,
    summary: mergeSummaries(allSummaries),
  };
}

function parseWithFormat(
  format: AssertionReportFormat,
  content: string,
  fileName: string,
): ParserResult {
  switch (format) {
    case 'junit_xml':
      return parseJUnitXml(content, fileName);
    case 'jest_json':
      return parseJestJson(content);
    case 'vitest_json':
      return parseVitestJson(content);
    case 'go_test_json':
      return parseGoTestJson(content);
    default:
      throw new Error(`unsupported assertion report format: ${format}`);
  }
}

// ─── Summary Merging ────────────────────────────────────────────────────────

function mergeSummaries(summaries: AssertionExtractionSummary[]): AssertionExtractionSummary {
  return {
    assertionCount: sum(summaries, 'assertionCount'),
    passedCount: sum(summaries, 'passedCount'),
    failedCount: sum(summaries, 'failedCount'),
    erroredCount: sum(summaries, 'erroredCount'),
    skippedCount: sum(summaries, 'skippedCount'),
    suiteInfrastructureError: summaries.some((s) => s.suiteInfrastructureError),
  };
}

function sum(
  summaries: AssertionExtractionSummary[],
  key: keyof AssertionExtractionSummary,
): number {
  return summaries.reduce((acc, s) => acc + (s[key] as number), 0);
}

// ─── Glob ───────────────────────────────────────────────────────────────────

async function globFiles(cwd: string, pattern: string): Promise<string[]> {
  const resolvedCwd = resolve(cwd);
  const dirPart = dirname(pattern);
  const fileGlob = basename(pattern);
  const baseDir = dirPart === '.' ? resolvedCwd : resolve(resolvedCwd, dirPart);

  if (!isWithinCwd(baseDir, resolvedCwd)) return [];

  const results: string[] = [];
  const regex = globToRegex(fileGlob);

  const collect = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await collect(fullPath);
      } else if (entry.isFile() && regex.test(entry.name)) {
        if (!isWithinCwd(fullPath, resolvedCwd)) continue;
        results.push(relative(resolvedCwd, fullPath));
        if (results.length >= MAX_FILES_PER_PATTERN + 1) return;
      }
    }
  };

  await collect(baseDir);
  return results;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isWithinCwd(target: string, cwd: string): boolean {
  const resolvedTarget = resolve(target);
  const resolvedCwd = resolve(cwd);
  return resolvedTarget === resolvedCwd || resolvedTarget.startsWith(resolvedCwd + sep);
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}
