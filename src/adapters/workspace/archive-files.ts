/**
 * @module workspace/archive-files
 * @description Internal filesystem existence/listing helpers shared by archive
 *              build and verification. No archive validity decisions.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * List all files in a session directory (relative paths, sorted).
 * Excludes the archive-manifest.json itself (it's added separately).
 */
export async function listSessionFiles(
  sessDir: string,
  excluded = new Set<string>(),
): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile() && entry.name !== 'archive-manifest.json') {
        if (!excluded.has(relPath)) {
          files.push(relPath);
        }
      }
    }
  }

  await walk(sessDir, '');
  return files.sort();
}

/** Check if a file exists (non-throwing). */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Copy archive bytes from an opened source handle into a verifier-private snapshot. */
export async function snapshotArchive(sourcePath: string, snapshotPath: string): Promise<void> {
  const source = await fs.open(sourcePath, 'r');
  try {
    await fs.writeFile(snapshotPath, await source.readFile(), { flag: 'wx', mode: 0o600 });
  } finally {
    await source.close();
  }
}
