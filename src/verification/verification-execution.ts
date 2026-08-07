/**
 * @module verification/verification-execution
 * @description Provider-agnostic verification execution preparation.
 *
 * Encapsulates the materialization of a VerificationCandidate into a concrete
 * command and collection context. Provider knowledge lives exclusively in the
 * registry and catalog — not in this module.
 *
 * @version v1
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep as pathSep } from 'node:path';
import { createHash } from 'node:crypto';

import type { VerificationCandidate } from '../state/discovery-schemas.js';
import type { ReportFormatId } from '../state/assertion-identity.js';
import type { AssertionReportSpec } from '../state/discovery-schemas.js';
import { FORMATS_BY_PROVIDER, PARSER_BY_FORMAT } from '../providers/registry.js';

// ─── Public types ────────────────────────────────────────────────────────────

export interface PreparedAssertionReportRunSpecific {
  readonly kind: 'run_specific';
  readonly spec: AssertionReportSpec & { collection: 'run_specific' };
  readonly resultPattern: string;
}

export interface PreparedAssertionReportSnapshotDiff {
  readonly kind: 'snapshot_diff';
  readonly spec: AssertionReportSpec & { collection: 'snapshot_diff' };
  readonly preExecutionSnapshot: readonly ReportFileSnapshot[];
}

export interface PreparedAssertionReportStdout {
  readonly kind: 'stdout';
  readonly spec: AssertionReportSpec & { collection: 'stdout' };
}

export type PreparedAssertionReport =
  | PreparedAssertionReportRunSpecific
  | PreparedAssertionReportSnapshotDiff
  | PreparedAssertionReportStdout;

export interface ReportFileSnapshot {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
}

export interface PreparedVerificationExecution {
  readonly attemptId: string;
  readonly kind: VerificationCandidate['kind'];
  readonly command: string;

  readonly assertion:
    | { readonly capability: 'unsupported' }
    | {
        readonly capability: 'structured';
        readonly report: PreparedAssertionReport;
      };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_FILES_PER_PATTERN = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// ─── Public API ──────────────────────────────────────────────────────────────

export async function prepareVerificationExecution(
  candidate: VerificationCandidate,
  cwd: string,
  attemptId?: string,
): Promise<PreparedVerificationExecution> {
  const id = attemptId ?? randomUUID();

  if (candidate.assertionCapability === 'unsupported') {
    return {
      attemptId: id,
      kind: candidate.kind,
      command: candidate.command,
      assertion: { capability: 'unsupported' },
    };
  }

  const spec = candidate.assertionReport;
  validateAssertionReportSpec(spec);

  let command = candidate.command;

  const report = await buildPreparedReport(spec, cwd, id);

  if (report.kind === 'run_specific') {
    command =
      `${candidate.command} ${report.spec.outputArgumentTemplate.replace(/\{attemptId\}/g, id)}`.trim();
  }

  return {
    attemptId: id,
    kind: candidate.kind,
    command,
    assertion: { capability: 'structured', report },
  };
}

// ─── Spec validation ─────────────────────────────────────────────────────────

function validateAssertionReportSpec(spec: AssertionReportSpec): void {
  const supported = FORMATS_BY_PROVIDER.get(spec.providerId);
  if (!supported?.has(spec.format as ReportFormatId)) {
    throw new Error(
      `Provider '${spec.providerId}' does not support report format '${spec.format}'`,
    );
  }
  const parser = PARSER_BY_FORMAT.get(spec.format as ReportFormatId);
  if (!parser) {
    throw new Error(`No parser registered for report format '${spec.format}'`);
  }
}

// ─── Report preparation ──────────────────────────────────────────────────────

async function buildPreparedReport(
  spec: AssertionReportSpec,
  cwd: string,
  attemptId: string,
): Promise<PreparedAssertionReport> {
  switch (spec.collection) {
    case 'run_specific': {
      const resultPattern = spec.resultPatternTemplate.replace(/\{attemptId\}/g, attemptId);
      return {
        kind: 'run_specific',
        spec: spec as PreparedAssertionReportRunSpecific['spec'],
        resultPattern,
      };
    }
    case 'snapshot_diff': {
      const preExecutionSnapshot = await takeSnapshot(cwd, spec.standardPatterns);
      return {
        kind: 'snapshot_diff',
        spec: spec as PreparedAssertionReportSnapshotDiff['spec'],
        preExecutionSnapshot,
      };
    }
    case 'stdout': {
      return { kind: 'stdout', spec: spec as PreparedAssertionReportStdout['spec'] };
    }
  }
}

// ─── Snapshot helpers (unchanged from assertion-extractor) ───────────────────

export async function takeSnapshot(cwd: string, patterns: string[]): Promise<ReportFileSnapshot[]> {
  const snapshot: ReportFileSnapshot[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    const paths = await globFiles(cwd, pattern);
    for (const relPath of paths) {
      if (seen.has(relPath)) continue;
      seen.add(relPath);

      const fullPath = resolve(cwd, relPath);
      if (!isWithinCwd(fullPath, cwd)) continue;

      const content = await readFile(fullPath);
      if (content.length > MAX_FILE_BYTES) continue;

      const digest = sha256(content);
      snapshot.push({ path: relPath, digest, size: content.length });
    }
  }
  return snapshot;
}

export function diffSnapshots(
  pre: readonly ReportFileSnapshot[],
  post: readonly ReportFileSnapshot[],
): string[] {
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

// ─── File system helpers ─────────────────────────────────────────────────────

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
  return resolvedTarget === resolvedCwd || resolvedTarget.startsWith(resolvedCwd + pathSep);
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}
