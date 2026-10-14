/** Attempt-local report isolation: defense-in-depth, not producer attestation. */
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { VerificationError } from './errors.js';

function reportDirectory(cwd: string, attemptId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(attemptId))
    throw new VerificationError(
      'VERIFICATION_REPORT_ISOLATION_FAILED',
      'Invalid report attempt identity.',
    );
  return resolve(cwd, '.flowguard', 'reports', attemptId);
}

export async function prepareReportIsolation(
  cwd: string,
  attemptId: string,
  pattern: string,
): Promise<void> {
  const directory = reportDirectory(cwd, attemptId);
  const member = relative(directory, resolve(cwd, pattern));
  if (member.startsWith('..') || member.length === 0)
    throw new VerificationError(
      'VERIFICATION_REPORT_ISOLATION_FAILED',
      'Run-specific reports must stay inside their attempt directory.',
    );
  try {
    for (const path of [resolve(cwd, '.flowguard'), resolve(cwd, '.flowguard', 'reports')]) {
      await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      });
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new VerificationError(
          'VERIFICATION_REPORT_ISOLATION_FAILED',
          'Report ancestry is not a real directory.',
        );
    }
    // No recursive mkdir and no reuse: a pre-created attempt directory is untrusted.
    await mkdir(directory, { mode: 0o700 });
  } catch (cause) {
    throw new VerificationError(
      'VERIFICATION_REPORT_ISOLATION_FAILED',
      'Cannot create a fresh isolated report directory.',
      { cause },
    );
  }
}

export async function reportMatchesExecutionWindow(
  cwd: string,
  path: string,
  attemptId: string,
  startedAt: string,
  executionMs: number,
): Promise<boolean> {
  const root = await realpath(cwd);
  const directory = reportDirectory(root, attemptId);
  const fullPath = resolve(cwd, path);
  const physical = await realpath(fullPath);
  if (!physical.startsWith(directory + sep)) return false;
  for (const ancestor of [
    resolve(root, '.flowguard'),
    resolve(root, '.flowguard', 'reports'),
    directory,
    fullPath,
  ]) {
    const stat = await lstat(ancestor);
    if (stat.isSymbolicLink()) return false;
  }
  const stat = await lstat(fullPath);
  const start = Date.parse(startedAt);
  // Filesystem timestamp granularity tolerance; concurrent same-user forgery remains possible.
  return (
    stat.isFile() &&
    Number.isFinite(start) &&
    stat.mtimeMs >= start - 2_000 &&
    stat.mtimeMs <= start + executionMs + 2_000
  );
}
