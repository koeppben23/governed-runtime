/**
 * @module shared/build-info
 * @description Runtime access to the build identity stamped into dist at build.
 *
 * scripts/generate-build-info.js writes dist/build-info.json (version, gitSha,
 * builtAt) after tsc. This reader mirrors package-version.ts: it resolves the
 * file relative to this module so it reads the stamp shipped next to the
 * installed dist. Unlike VERSION (present in both src and shipped layouts),
 * build-info.json exists ONLY in dist (post-build), so a missing file is a
 * normal dev/test condition and is reported as a null-identity value rather
 * than thrown — this reader is diagnostic only and must never break a runtime
 * tool call.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  readonly version: string;
  readonly gitSha: string;
  readonly gitShaSource: string;
  readonly builtAt: string;
}

/** Resolve the directory where build-info.json lives (the dist root). */
function resolveDistRoot(): string {
  // Compiles to dist/shared/build-info.js → '..' is dist/ (where the build
  // script writes build-info.json, shipped via package.json files:["dist"]).
  // Under tests this module runs from src/shared/build-info.ts → '..' is src/,
  // which has no build-info.json, so the reader returns null (dev/test).
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

function readBuildInfo(): BuildInfo | null {
  const file = join(resolveDistRoot(), 'build-info.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<BuildInfo>;
    if (
      typeof parsed.version === 'string' &&
      typeof parsed.gitSha === 'string' &&
      typeof parsed.gitShaSource === 'string' &&
      typeof parsed.builtAt === 'string'
    ) {
      return {
        version: parsed.version,
        gitSha: parsed.gitSha,
        gitShaSource: parsed.gitShaSource,
        builtAt: parsed.builtAt,
      };
    }
    return null;
  } catch {
    // Absent (dev/test, pre-build) or unparseable — diagnostic only.
    return null;
  }
}

let cached: BuildInfo | null | undefined;

/**
 * The build identity shipped next to dist, or null when no build-info.json is
 * present (e.g. running from source in dev/test). Cached after first read.
 */
export function BUILD_INFO(): BuildInfo | null {
  if (cached === undefined) {
    cached = readBuildInfo();
  }
  return cached;
}
