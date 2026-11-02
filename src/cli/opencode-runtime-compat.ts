/**
 * @module cli/opencode-runtime-compat
 * @description Canonical exact-host-version pin and deny-list classifier.
 *
 * The pin is read by the demo/live harnesses and the SDK update tests. It is a
 * retained old-generation baseline, not a V2 support certification; replacing
 * it with the installed V2 host baseline is installed-host acceptance work.
 * The former V1 instruction-source (`instructions[]`) classification and its
 * runtime detection were removed with the global mandate instruction.
 *
 * This is a pure module: no I/O, no side effects.
 *
 * @version v4
 */

/** Exact OpenCode host version exercised by CI and represented by the baseline. */
export const TESTED_OPENCODE_HOST_VERSION = '1.19.5';

export interface OpenCodeHostContractDenyEntry {
  readonly versionRange: string;
  readonly reason: string;
  readonly verifiedBy: string;
}

export const KNOWN_INCOMPATIBLE_OPENCODE_HOST_CONTRACTS: readonly OpenCodeHostContractDenyEntry[] =
  [];

export type OpenCodeHostContractStatus =
  'verified' | 'compatible-unverified' | 'known-incompatible';

export interface OpenCodeHostContractClassification {
  readonly status: OpenCodeHostContractStatus;
  readonly testedVersion: string;
  readonly matched?: OpenCodeHostContractDenyEntry;
  readonly reason: string;
}

type Semver = readonly [number, number, number];

function parseSemver(version: string): Semver | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: Semver, b: Semver): number {
  const [aMajor, aMinor, aPatch] = a;
  const [bMajor, bMinor, bPatch] = b;
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
}

function versionInBoundedRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  const lowerMatch = range.match(/>=(\d+\.\d+\.\d+)/);
  const upperMatch = range.match(/<(\d+\.\d+\.\d+)/);
  const lowerVersion = lowerMatch?.[1];
  const upperVersion = upperMatch?.[1];
  const lower = lowerVersion === undefined ? null : parseSemver(lowerVersion);
  const upper = upperVersion === undefined ? null : parseSemver(upperVersion);
  if (!lower && !upper) return false;
  if (lower && compareSemver(parsed, lower) < 0) return false;
  if (upper && compareSemver(parsed, upper) >= 0) return false;
  return true;
}

function baseClassification() {
  return {
    testedVersion: TESTED_OPENCODE_HOST_VERSION,
  } as const;
}

export function classifyOpenCodeHostContract(
  version: string | null,
  denyList: readonly OpenCodeHostContractDenyEntry[] = KNOWN_INCOMPATIBLE_OPENCODE_HOST_CONTRACTS,
): OpenCodeHostContractClassification {
  if (version !== null) {
    const matched = denyList.find((entry) => versionInBoundedRange(version, entry.versionRange));
    if (matched) {
      return {
        ...baseClassification(),
        status: 'known-incompatible',
        matched,
        reason: matched.reason,
      };
    }
  }

  if (version !== null && version.trim() === TESTED_OPENCODE_HOST_VERSION) {
    return {
      ...baseClassification(),
      status: 'verified',
      reason: `detected host version ${version} exactly matches the tested host baseline`,
    };
  }

  return {
    ...baseClassification(),
    status: 'compatible-unverified',
    reason:
      version === null
        ? 'host version could not be determined'
        : `detected host version ${version} does not exactly match the tested host baseline`,
  };
}
