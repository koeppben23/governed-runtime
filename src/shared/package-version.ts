/**
 * @module shared/package-version
 * @description Canonical runtime access to the FlowGuard package version.
 *
 * VERSION is the release source of truth. Runtime surfaces must read from this
 * helper instead of embedding literals or consulting derived package metadata.
 */

import { readFileSync } from 'node:fs';
export class PackageVersionError extends Error {
  readonly code = 'PACKAGE_VERSION_MISSING' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PackageVersionError';
  }
}
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the FlowGuard package root where VERSION lives.
 *
 * This module compiles to `dist/shared/package-version.js` and runs from
 * `src/shared/package-version.ts` under tests; both are two directories below
 * the package root, so `'..','..'` resolves the same canonical root.
 */
export function resolvePackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function getPackageVersion(): string {
  const versionFile = join(resolvePackageRoot(), 'VERSION');
  try {
    return readFileSync(versionFile, 'utf-8').trim();
  } catch {
    throw new PackageVersionError(
      `VERSION file not found at ${versionFile}. Run from the project root.`,
    );
  }
}

let cachedVersion: string | undefined;

export function PACKAGE_VERSION(): string {
  if (!cachedVersion) {
    cachedVersion = getPackageVersion();
  }
  return cachedVersion;
}
