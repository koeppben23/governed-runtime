/**
 * @module discovery/collectors/languages/python
 * @description python ecosystem detection — extracted from stack-detection.ts.
 * @version v1
 */

import type { DetectedItem } from '../../types.js';
import type { ReadFileFn } from '../stack-detection-utils.js';
import { captureGroup, findItem, safeRead, setVersion, enrichOrCreateItem } from '../stack-detection-utils.js';
import { collectRootBasenames } from '../stack-detection.js';
import { PYTHON_REQUIREMENTS_FILES, PYTHON_ECOSYSTEM_PACKAGES } from '../stack-detection-rules.js';

export async function extractFromPythonRootFiles(
  readFile: ReadFileFn,
  allFiles: readonly string[],
  languages: DetectedItem[],
  testFrameworks: DetectedItem[],
  qualityTools: DetectedItem[],
  buildTools: DetectedItem[],
): Promise<void> {
  const rootFiles = collectRootBasenames(allFiles);

  if (rootFiles.has('.python-version')) {
    const content = await safeRead(readFile, '.python-version');
    const line = content?.trim().split('\n')[0]?.trim() ?? '';
    const version = captureGroup(line.match(/^(?:python-)?(\d+(?:\.\d+){0,2})/));
    if (version) {
      const python = findItem(languages, 'python');
      if (python && !python.version) {
        setVersion(python, version, '.python-version');
      }
    }
  }

  if (rootFiles.has('pyproject.toml')) {
    const content = await safeRead(readFile, 'pyproject.toml');
    if (content) {
      const requiresPython = captureGroup(content.match(/requires-python\s*=\s*['"]([^'"]+)['"]/i));
      const pyVersion = captureGroup(requiresPython?.match(/(\d+(?:\.\d+){0,2})/) ?? null);
      if (pyVersion) {
        const python = findItem(languages, 'python');
        if (python && !python.version) {
          setVersion(python, pyVersion, 'pyproject.toml:requires-python');
        }
      }

      for (const rule of PYTHON_ECOSYSTEM_PACKAGES) {
        const toolTable = new RegExp(`\\[tool\\.${rule.pkg}(?:\\.|\\]|$)`, 'i').test(content);
        const dependencyEntry = new RegExp(`["']${rule.pkg}[>=<~!:]+[^"']*["']`, 'i').test(content);
        if (!toolTable && !dependencyEntry) continue;

        const targetArray = rule.category === 'testFramework' ? testFrameworks : qualityTools;
        enrichOrCreateItem(targetArray, rule.id, `pyproject.toml:${rule.pkg}`);
      }
    }
  }

  for (const file of PYTHON_REQUIREMENTS_FILES) {
    if (!rootFiles.has(file)) continue;
    const content = await safeRead(readFile, file);
    if (!content) continue;

    for (const rule of PYTHON_ECOSYSTEM_PACKAGES) {
      if (!hasRequirementEntry(content, rule.pkg)) continue;
      const targetArray = rule.category === 'testFramework' ? testFrameworks : qualityTools;
      enrichOrCreateItem(targetArray, rule.id, `${file}:${rule.pkg}`);
    }
  }

  if (rootFiles.has('pyproject.toml')) {
    const pyprojectContent = await safeRead(readFile, 'pyproject.toml');
    if (pyprojectContent?.includes('[tool.poetry]')) {
      enrichOrCreateItem(buildTools, 'poetry', 'pyproject.toml:[tool.poetry]');
    }
  }
}
export function hasRequirementEntry(requirementsContent: string, packageName: string): boolean {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${escaped}(?:\\[[^\\]]+\\])?(?:\\s*(?:[=~!<>].*)?)?$`, 'im');
  return re.test(requirementsContent);
}
