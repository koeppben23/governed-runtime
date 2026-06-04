/**
 * @module persistence-reviewer-capture
 * @description Append-only JSONL store for host-captured reviewer corroboration records.
 *
 * Written by FlowGuard hooks (SubagentStop / PostToolUse) that fire inside the
 * `flowguard-reviewer` subagent. Read at review-evidence construction time to decide
 * whether a `manual_attested` invocation can be upgraded to `native_subagent_attested`.
 *
 * Append-only, no hash chain (corroboration evidence, not the audit SSOT). Reads
 * tolerate corrupt lines and skip them, mirroring the audit-trail read contract.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ReviewerSubagentCapture } from '../state/evidence-reviewer-capture.js';
import { durableAtomicWrite, ensureDir, PersistenceError, isEnoent } from './persistence.js';
import { withSessionWriteLock } from './persistence-lock.js';

const REVIEWER_CAPTURE_FILE = 'reviewer-captures.jsonl';

/** Resolve the reviewer-capture file path within a session directory. */
export function reviewerCapturePath(sessionDir: string): string {
  return path.join(sessionDir, REVIEWER_CAPTURE_FILE);
}

/**
 * Append a single reviewer-capture record.
 *
 * Zod-validates before appending (fail-closed). Single-line JSON, trailing newline.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param capture - Capture record to append.
 */
export async function appendReviewerCapture(
  sessionDir: string,
  capture: ReviewerSubagentCapture,
): Promise<ReviewerSubagentCapture> {
  const result = ReviewerSubagentCapture.safeParse(capture);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Refusing to append invalid reviewer capture: ${result.error.message}`,
    );
  }

  await withSessionWriteLock(sessionDir, async () => {
    await ensureDir(sessionDir);
    const filePath = reviewerCapturePath(sessionDir);
    let existing = '';
    try {
      existing = await fs.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if (!isEnoent(err)) {
        throw new PersistenceError(
          'WRITE_FAILED',
          `Failed to read existing reviewer captures before append: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const line = JSON.stringify(result.data) + '\n';
    await durableAtomicWrite(filePath, existing + line);
  });
  return result.data;
}

/**
 * Read all reviewer-capture records. Returns empty array if no file exists.
 * Skips malformed lines with best-effort tolerance.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @returns Object with captures array and skipped count.
 */
export async function readReviewerCaptures(
  sessionDir: string,
): Promise<{ captures: ReviewerSubagentCapture[]; skipped: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(reviewerCapturePath(sessionDir), 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return { captures: [], skipped: 0 };
    throw new PersistenceError(
      'READ_FAILED',
      `Failed to read reviewer captures: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const captures: ReviewerSubagentCapture[] = [];
  let skipped = 0;
  for (const lineRaw of raw.split('\n')) {
    const trimmed = lineRaw.trim();
    if (!trimmed) continue;
    try {
      const parsed = ReviewerSubagentCapture.safeParse(JSON.parse(trimmed));
      if (parsed.success) captures.push(parsed.data);
      else skipped++;
    } catch {
      skipped++;
    }
  }

  return { captures, skipped };
}
