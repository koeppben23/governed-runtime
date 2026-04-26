/**
 * @module discovery/collectors/languages/node
 * @description node ecosystem detection — extracted from stack-detection.ts.
 * @version v1
 */

import type { DetectedItem } from '../../types.js';
import type { ReadFileFn } from '../stack-detection-utils.js';
import { safeRead } from '../stack-detection-utils.js';
import { enrichRuntimeVersion } from './java.js';

export async function extractFromNodeVersionFiles(
  readFile: ReadFileFn,
  runtimes: DetectedItem[],
): Promise<void> {
  for (const file of ['.nvmrc', '.node-version']) {
    const content = await safeRead(readFile, file);
    if (!content) continue;

    // Strip leading 'v', whitespace, and take first line
    const firstLine = content.trim().split('\n')[0] ?? '';
    const version = firstLine.replace(/^v/i, '').trim();
    if (!version || !/^\d/.test(version)) continue;

    enrichRuntimeVersion(runtimes, 'node', version, file);
    return; // First match wins
  }
}
