/**
 * @module discovery/collectors/languages/go
 * @description go ecosystem detection — extracted from stack-detection.ts.
 * @version v1
 */

import type { DetectedItem } from '../../types.js';
import type { ReadFileFn } from '../stack-detection-utils.js';
import { captureGroup, findItem, safeRead, setVersion } from '../stack-detection-utils.js';
import { collectRootBasenames } from '../stack-detection-utils.js';

export async function extractFromGoMod(
  readFile: ReadFileFn,
  languages: DetectedItem[],
  allFiles: readonly string[],
): Promise<void> {
  const rootFiles = collectRootBasenames(allFiles);
  if (!rootFiles.has('go.mod')) return;

  const content = await safeRead(readFile, 'go.mod');
  if (!content) return;

  const goVer = captureGroup(content.match(/^go\s+(\d+\.\d+(?:\.\d+)?)/m));
  if (!goVer) return;

  const goItem = findItem(languages, 'go');
  if (goItem && !goItem.version) {
    setVersion(goItem, goVer, 'go.mod:go');
  }
}
