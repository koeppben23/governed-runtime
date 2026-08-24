/**
 * Shared test fixtures for the verification planner and capability resolution.
 * Import target only — never executed as a test suite.
 */

import type { DetectedStack } from './types.js';

export function makeDetectedStack(items: DetectedStack['items']): DetectedStack {
  return {
    summary: items.map((item) => item.id).join(', '),
    items,
    versions: items
      .filter((item) => item.version)
      .map((item) => ({
        id: item.id,
        version: item.version!,
        target: item.kind,
      })),
  };
}

export function makeReadFile(files: Record<string, string | undefined>) {
  return async (relativePath: string): Promise<string | undefined> =>
    files[relativePath] ??
    (relativePath === 'pom.xml' || relativePath.endsWith('/pom.xml')
      ? '<project />'
      : relativePath === 'settings.gradle' || relativePath === 'settings.gradle.kts'
        ? ''
        : undefined);
}
