/**
 * @module verification/assertion-report-collector
 * @description Collect raw assertion reports from file system or stdout after execution.
 *
 * Separates collection (finding and reading report files) from parsing.
 * Returns CollectedAssertionReport for the extractor to parse independently.
 *
 * @version v1
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sep } from 'node:path';

import type { ExecutionEvidence } from './executor.js';
import type {
  PreparedVerificationExecution,
  ReportFileSnapshot,
} from './verification-execution.js';
import { takeSnapshot, diffSnapshots } from './verification-execution.js';
import type { AssertionExtractionReasonCode } from '../state/evidence-validation.js';
import type { ReportFormatId, ProviderId } from '../state/assertion-identity.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_FILES_PER_PATTERN = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// ─── Collected report type (internal, not persisted in SessionState) ─────────

export type CollectedAssertionReport =
  | {
      readonly transport: 'stdout';
      readonly format: ReportFormatId;
      readonly providerId: ProviderId;
      readonly content: string;
      readonly digest: string;
    }
  | {
      readonly transport: 'file';
      readonly format: ReportFormatId;
      readonly providerId: ProviderId;
      readonly reports: ReadonlyArray<{
        path: string;
        content: string;
        digest: string;
      }>;
    };

// ─── Collection result ───────────────────────────────────────────────────────

export type ReportCollectionResult =
  | {
      readonly status: 'collected';
      readonly report: CollectedAssertionReport;
    }
  | {
      readonly status: 'blocked';
      readonly attemptId: string;
      readonly reasonCode: AssertionExtractionReasonCode;
      readonly reason: string;
    };

// ─── Public API ──────────────────────────────────────────────────────────────

export async function collectAssertionReports(
  prepared: PreparedVerificationExecution,
  execution: ExecutionEvidence,
  cwd: string,
): Promise<ReportCollectionResult> {
  if (prepared.assertion.capability !== 'structured') {
    return {
      status: 'blocked',
      attemptId: prepared.attemptId,
      reasonCode: 'provider_format_mismatch',
      reason: 'Candidate does not support structured assertion extraction',
    };
  }

  const reportCtx = prepared.assertion.report;
  const spec = reportCtx.spec;

  switch (reportCtx.kind) {
    case 'run_specific':
      return collectRunSpecific(
        reportCtx.resultPattern,
        spec.format,
        spec.providerId,
        prepared.attemptId,
        cwd,
      );
    case 'snapshot_diff':
      return collectSnapshotDiff(
        reportCtx.preExecutionSnapshot,
        reportCtx.spec.standardPatterns,
        spec.format,
        spec.providerId,
        prepared.attemptId,
        cwd,
      );
    case 'stdout':
      return collectStdout(execution.stdout, spec.format, spec.providerId, prepared.attemptId);
  }
}

// ─── Run-specific collection ─────────────────────────────────────────────────

async function collectRunSpecific(
  pattern: string,
  format: ReportFormatId,
  providerId: ProviderId,
  attemptId: string,
  cwd: string,
): Promise<ReportCollectionResult> {
  const paths = await globFiles(cwd, pattern);
  paths.sort();

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

  const reports: Array<{ path: string; content: string; digest: string }> = [];
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

    reports.push({ path: relPath, content, digest: sha256(content) });
  }

  return {
    status: 'collected',
    report: {
      transport: 'file',
      format,
      providerId,
      reports,
    },
  };
}

// ─── Snapshot diff collection ────────────────────────────────────────────────

async function collectSnapshotDiff(
  preSnapshot: readonly ReportFileSnapshot[],
  patterns: readonly string[],
  format: ReportFormatId,
  providerId: ProviderId,
  attemptId: string,
  cwd: string,
): Promise<ReportCollectionResult> {
  const postSnapshot = await takeSnapshot(cwd, [...patterns]);
  const changedPaths = diffSnapshots(preSnapshot, postSnapshot).sort();

  if (changedPaths.length === 0) {
    return {
      status: 'blocked',
      attemptId,
      reasonCode: 'report_missing',
      reason: 'no new or changed report files produced by this execution',
    };
  }
  if (changedPaths.length > MAX_FILES_PER_PATTERN) {
    return {
      status: 'blocked',
      attemptId,
      reasonCode: 'report_ambiguous',
      reason: `too many changed report files: ${changedPaths.length} (max ${MAX_FILES_PER_PATTERN})`,
    };
  }

  const reports: Array<{ path: string; content: string; digest: string }> = [];
  for (const relPath of changedPaths) {
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

    reports.push({ path: relPath, content, digest: sha256(content) });
  }

  return {
    status: 'collected',
    report: {
      transport: 'file',
      format,
      providerId,
      reports,
    },
  };
}

// ─── Stdout collection ───────────────────────────────────────────────────────

async function collectStdout(
  stdout: string,
  format: ReportFormatId,
  providerId: ProviderId,
  _attemptId: string,
): Promise<ReportCollectionResult> {
  return {
    status: 'collected',
    report: {
      transport: 'stdout',
      format,
      providerId,
      content: stdout,
      digest: sha256(stdout),
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function globFiles(cwd: string, pattern: string): Promise<string[]> {
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
