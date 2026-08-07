/**
 * @module verification/assertion-extractor
 * @description Structured assertion extraction from collected reports.
 *
 * Parses raw assertion reports via the registry and validates local
 * identities through provider codecs. Preparation and report collection
 * are handled by verification-execution.ts — this module only parses
 * and validates.
 *
 * @version v2
 */

import { readFile } from 'node:fs/promises';
import { sep, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import type { ExecutionEvidence } from './executor.js';
import type {
  AssertionExtractionResult,
  AssertionExtractionSummary,
} from '../state/evidence-validation.js';
import type { ReportFormatId, ProviderId } from '../state/assertion-identity.js';
import type { AssertionReportSpec } from '../state/discovery-schemas.js';
import type {
  PreparedVerificationExecution,
  PreparedAssertionReport,
} from './verification-execution.js';
import { takeSnapshot, diffSnapshots } from './verification-execution.js';

import {
  PARSER_BY_FORMAT,
  FORMATS_BY_PROVIDER,
  ASSERTION_FORMATS_BY_PROVIDER,
  ASSERTION_CODEC_BY_PROVIDER,
} from './assertion-parsers/registry.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_PATTERN = 100;

// ─── Internal ────────────────────────────────────────────────────────────────

interface ParserResult {
  assertions: import('../state/evidence-validation.js').StructuredAssertionEvidence[];
  summary: AssertionExtractionSummary;
}

function parseWithFormat(
  format: ReportFormatId,
  providerId: ProviderId,
  content: string,
  fileName: string,
): ParserResult {
  const supportedFormats = FORMATS_BY_PROVIDER.get(providerId);
  if (!supportedFormats?.has(format)) {
    throw new Error(`Provider '${providerId}' does not support report format '${format}'`);
  }
  const parser = PARSER_BY_FORMAT.get(format);
  if (!parser) {
    throw new Error(`unsupported assertion report format: ${format}`);
  }
  return parser.parse(content, fileName, { providerId });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function completeAssertionExtraction(
  prepared: PreparedVerificationExecution,
  execution: ExecutionEvidence,
  cwd: string,
): Promise<AssertionExtractionResult> {
  const { attemptId } = prepared;

  if (prepared.assertion.capability !== 'structured') {
    return { status: 'not_configured' };
  }

  const report = prepared.assertion.report;
  const spec = report.spec;

  try {
    const raw = await extractRaw(report, execution, cwd, attemptId);
    const result = stripNonBindingAssertions(raw, spec);
    return validateExtractedIdentities(result, spec);
  } catch (err: unknown) {
    return {
      status: 'inconclusive',
      attemptId,
      reasonCode: 'parse_failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function stripNonBindingAssertions(
  result: AssertionExtractionResult,
  spec: AssertionReportSpec,
): AssertionExtractionResult {
  if (result.status !== 'extracted') return result;

  const bindingFormats = ASSERTION_FORMATS_BY_PROVIDER.get(spec.providerId);
  const isBinding = bindingFormats?.has(spec.format as ReportFormatId);
  if (isBinding) return result;

  return {
    ...result,
    bindingCapability: 'check_only',
    assertions: [],
    summary: {
      ...result.summary,
      assertionCount: 0,
      passedCount: 0,
      failedCount: 0,
      erroredCount: 0,
      skippedCount: 0,
    },
  };
}

function validateExtractedIdentities(
  result: AssertionExtractionResult,
  spec: AssertionReportSpec,
): AssertionExtractionResult {
  if (result.status !== 'extracted' || result.assertions.length === 0) return result;

  const codec = ASSERTION_CODEC_BY_PROVIDER.get(spec.providerId);
  if (!codec) {
    return {
      status: 'inconclusive',
      attemptId: result.attemptId,
      reasonCode: 'identity_codec_missing',
      reason: `Provider '${spec.providerId}' has no registered assertion identity codec`,
    };
  }

  for (const assertion of result.assertions) {
    if (!codec.validateLocalId(assertion.assertion.localId)) {
      return {
        status: 'inconclusive',
        attemptId: result.attemptId,
        reasonCode: 'invalid_local_id',
        reason: `Local assertion id '${assertion.assertion.localId}' failed codec validation for provider '${spec.providerId}'`,
      };
    }
  }
  return result;
}

// ─── Extraction dispatch ─────────────────────────────────────────────────────

async function extractRaw(
  report: PreparedAssertionReport,
  execution: ExecutionEvidence,
  cwd: string,
  attemptId: string,
): Promise<AssertionExtractionResult> {
  switch (report.kind) {
    case 'stdout':
      return extractFromStdout(
        attemptId,
        report.spec.format,
        report.spec.providerId,
        execution.stdout,
      );
    case 'run_specific':
      return extractFromRunSpecific(
        attemptId,
        report.spec.format,
        report.spec.providerId,
        cwd,
        report.resultPattern,
      );
    case 'snapshot_diff':
      return extractFromSnapshotDiff(
        attemptId,
        report.spec.format,
        report.spec.providerId,
        cwd,
        report.spec.standardPatterns,
        [...report.preExecutionSnapshot],
      );
  }
}

async function extractFromStdout(
  attemptId: string,
  format: ReportFormatId,
  providerId: ProviderId,
  stdout: string,
): Promise<AssertionExtractionResult> {
  const parsed = parseWithFormat(format, providerId, stdout, '<stdout>');
  if (!parsed.assertions.length) {
    return {
      status: 'inconclusive',
      attemptId,
      reasonCode: 'report_empty',
      reason: 'report parsing produced no test results',
    };
  }
  const digest = sha256(stdout);
  const bindingFormats = ASSERTION_FORMATS_BY_PROVIDER.get(providerId);
  return {
    status: 'extracted',
    attemptId,
    providerId,
    format,
    bindingCapability: bindingFormats?.has(format) === true ? 'assertion' : 'check_only',
    reportDigests: [digest],
    assertions: parsed.assertions,
    summary: parsed.summary,
  };
}

async function extractFromRunSpecific(
  attemptId: string,
  format: ReportFormatId,
  providerId: ProviderId,
  cwd: string,
  pattern: string,
): Promise<AssertionExtractionResult> {
  const paths = await globFiles(cwd, pattern);
  if (paths.length === 0) {
    return {
      status: 'blocked',
      attemptId,
      reasonCode: 'report_missing',
      reason: `expected reports matching '${pattern}' not found after execution`,
    };
  }
  if (paths.length > MAX_FILES_PER_PATTERN) {
    return {
      status: 'blocked',
      attemptId,
      reasonCode: 'report_ambiguous',
      reason: `too many reports matching '${pattern}': ${paths.length} (max ${MAX_FILES_PER_PATTERN})`,
    };
  }
  return parseAndMergeFiles(attemptId, format, providerId, cwd, paths);
}

async function extractFromSnapshotDiff(
  attemptId: string,
  format: ReportFormatId,
  providerId: ProviderId,
  cwd: string,
  patterns: string[],
  preSnapshot: ReturnType<typeof takeSnapshot> extends Promise<infer T> ? T : never,
): Promise<AssertionExtractionResult> {
  const postSnapshot = await takeSnapshot(cwd, patterns);
  const changedPaths = diffSnapshots(preSnapshot, postSnapshot);

  if (changedPaths.length === 0) {
    return {
      status: 'blocked',
      attemptId,
      reasonCode: 'report_missing',
      reason: 'no new report files produced by this execution',
    };
  }
  return parseAndMergeFiles(attemptId, format, providerId, cwd, changedPaths);
}

// ─── File Parsing ────────────────────────────────────────────────────────────

async function parseAndMergeFiles(
  attemptId: string,
  format: ReportFormatId,
  providerId: ProviderId,
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
        reasonCode: 'path_rejected',
        reason: `path traversal rejected: ${relPath}`,
      };
    }

    const content = await readFile(fullPath, 'utf-8');
    if (content.length > MAX_FILE_BYTES) {
      return {
        status: 'blocked',
        attemptId,
        reasonCode: 'report_too_large',
        reason: `file too large: ${relPath} (${content.length} bytes, max ${MAX_FILE_BYTES})`,
      };
    }

    const parsed = parseWithFormat(format, providerId, content, relPath);
    allAssertions.push(...parsed.assertions);
    allSummaries.push(parsed.summary);
    digests.push(sha256(content));
  }

  if (allAssertions.length === 0) {
    return {
      status: 'inconclusive',
      attemptId,
      reasonCode: 'report_empty',
      reason: 'report parsing produced no test results',
    };
  }

  const bindingFormats = ASSERTION_FORMATS_BY_PROVIDER.get(providerId);
  return {
    status: 'extracted',
    attemptId,
    providerId,
    format,
    bindingCapability: bindingFormats?.has(format) === true ? 'assertion' : 'check_only',
    reportDigests: digests,
    assertions: allAssertions,
    summary: mergeSummaries(allSummaries),
  };
}

// ─── Summary Merging ─────────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

export async function globFiles(cwd: string, pattern: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const { dirname, basename, join: j, resolve: r, relative: rel } = await import('node:path');

  const resolvedCwd = r(cwd);
  const dirPart = dirname(pattern);
  const fileGlob = basename(pattern);
  const baseDir = dirPart === '.' ? resolvedCwd : r(resolvedCwd, dirPart);

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
      const fullPath = j(dir, entry.name);
      if (entry.isDirectory()) {
        await collect(fullPath);
      } else if (entry.isFile() && regex.test(entry.name)) {
        if (!isWithinCwd(fullPath, resolvedCwd)) continue;
        results.push(rel(resolvedCwd, fullPath));
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

function isWithinCwd(target: string, cwd: string): boolean {
  const resolvedTarget = resolve(target);
  const resolvedCwd = resolve(cwd);
  return resolvedTarget === resolvedCwd || resolvedTarget.startsWith(resolvedCwd + sep);
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}
