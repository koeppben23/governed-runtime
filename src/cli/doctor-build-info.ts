/**
 * @module cli/doctor-build-info
 * @description Doctor check: detect a stale or inconsistent installed dist via
 * the build-info stamp.
 *
 * scripts/generate-build-info.js writes dist/build-info.json (version, gitSha,
 * builtAt) at build time. This check reads the running package's shipped
 * build-info and compares its version to the package's own VERSION
 * (PACKAGE_VERSION). A mismatch — or a missing/unparseable build-info — means
 * the installed dist was not produced by the current build (stale dist), which
 * is the recurring failure mode where a demo runs an old plugin build.
 *
 * Identity/version comparison (not a content hash): doctor runs from the
 * package itself, so a self-content-hash would be tautological; the build-info
 * version vs VERSION mismatch is the same pattern used by checkMandatesDigest.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_VERSION, resolvePackageRoot, BUILD_INFO_CHECK } from './install-helpers.js';
import type { DoctorCheck } from './install-types.js';

export function checkBuildInfo(packageRoot: string = resolvePackageRoot()): DoctorCheck[] {
  const file = join(packageRoot, 'dist', 'build-info.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return [
      {
        file,
        status: 'version_mismatch',
        detail:
          'dist/build-info.json missing — installed dist predates build stamping or is stale; rebuild/reinstall the plugin',
        check: BUILD_INFO_CHECK,
      },
    ];
  }

  let parsed: { version?: unknown; gitSha?: unknown };
  try {
    parsed = JSON.parse(raw) as { version?: unknown; gitSha?: unknown };
  } catch {
    return [
      {
        file,
        status: 'error',
        detail: 'dist/build-info.json is not valid JSON',
        check: BUILD_INFO_CHECK,
      },
    ];
  }

  if (typeof parsed.version !== 'string') {
    return [
      {
        file,
        status: 'error',
        detail: 'dist/build-info.json missing a string "version" field',
        check: BUILD_INFO_CHECK,
      },
    ];
  }

  const expected = PACKAGE_VERSION();
  if (parsed.version !== expected) {
    return [
      {
        file,
        status: 'version_mismatch',
        detail: `dist build v${parsed.version} != installed v${expected} (stale dist — rebuild/reinstall)`,
        check: BUILD_INFO_CHECK,
      },
    ];
  }

  const shaHint = typeof parsed.gitSha === 'string' ? ` gitSha=${parsed.gitSha}` : '';
  return [{ file, status: 'ok', detail: `v${expected}${shaHint}`, check: BUILD_INFO_CHECK }];
}
