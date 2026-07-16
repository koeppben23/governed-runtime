/**
 * @module integration/tools/implement-diff-artifact
 * @description Write the implementation diff to a content-addressed session file.
 *
 * Extracted from implement-record.ts so it can be mocked independently in tests.
 *
 * @version v1
 */

import { promises as fs } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { getAdapterLogger } from '../../logging/adapter-logger.js';

/**
 * Write the implementation diff to a content-addressed session file so the exported
 * audit archive contains the actual change (covered by the archive manifest SHA-256
 * and content digest). Content-addressed by `diffDigest`, so identical content is
 * written idempotently. Best-effort: returns `true` when the artifact was written
 * successfully; returns `false` and logs a warning on failure. The evidence must
 * only carry `diffDigest` when the artifact actually exists on disk.
 */
export async function writeImplementationDiffArtifact(
  sessDir: string,
  diffDigest: string,
  diffText: string,
): Promise<boolean> {
  const file = pathJoin(sessDir, `implementation-diff.${diffDigest}.patch`);
  try {
    await fs.writeFile(file, diffText, 'utf8');
    return true;
  } catch (err) {
    getAdapterLogger().warn('tool', 'impl_diff_artifact_write_failed', {
      diffDigest,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
