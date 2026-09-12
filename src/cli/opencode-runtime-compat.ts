/**
 * @module cli/opencode-runtime-compat
 * @description Canonical authority for OpenCode instruction-source classification.
 *
 * FlowGuard installs its mandates by registering an entry in the OpenCode
 * `instructions[]` array (see src/templates/mandates.ts). Per the official
 * OpenCode documentation this is the documented mechanism for loading custom
 * instruction sources, exposed to both the CLI and the Desktop app:
 *   - https://opencode.ai/docs/config#instructions  (retrieved 2026-07)
 *   - https://opencode.ai/docs/rules                 (retrieved 2026-07)
 *
 * Honesty model (deliberate, reviewed decision):
 *   - A present `instructions[]` entry means the instruction source is
 *     structurally present in the config. It does NOT prove the runtime actually
 *     loaded the file into the model context. FlowGuard has no reliable surface to verify
 *     activation (the Desktop app exposes no `--version` executable and no documented
 *     resolved-instruction API), so this module never claims "supported",
 *     "active", or "compatible".
 *   - `not-classified` is therefore the neutral, honest classification: the entry
 *     is in place; activation is simply not asserted here.
 *   - `known-unsupported` is asserted ONLY when a runtime positively matches an
 *     entry in {@link KNOWN_INCOMPATIBLE_OPENCODE_RUNTIMES}. This is a deny-list,
 *     not an allow-list. It is seeded empty: no OpenCode runtime is currently
 *     known — with evidence — to accept the `instructions[]` array entry while
 *     failing to resolve it as an instruction source. Entries may only be added
 *     with a positive, cited evidence source in `verifiedBy`.
 *
 * An unknown runtime is NEVER treated as compatible/supported — it is simply
 * `not-classified` (present but unverified). Blocking is reserved for positively
 * known-incompatible runtimes.
 *
 * This is a pure module: no I/O, no side effects. Detection lives in
 * opencode-runtime-detect.ts; this module only classifies evidence.
 *
 * @version v3
 */

/** Runtime "kind" derived from config-ownership heuristics (never from a version). */
export type OpenCodeRuntimeKind = 'cli' | 'desktop-owned' | 'unknown';

export interface OpenCodeRuntimeEvidence {
  readonly runtimeKind: OpenCodeRuntimeKind;
  readonly version: string | null;
  readonly runtimeLine: string | null;
}

export interface OpenCodeRuntimeDenyEntry {
  readonly runtimeLine: string;
  readonly versionRange?: string;
  readonly reason: string;
  readonly verifiedBy: string;
}

export const KNOWN_INCOMPATIBLE_OPENCODE_RUNTIMES: readonly OpenCodeRuntimeDenyEntry[] = [];

export type OpenCodeRuntimeStatus = 'not-classified' | 'known-unsupported';

export interface OpenCodeRuntimeClassification {
  readonly status: OpenCodeRuntimeStatus;
  readonly matched?: OpenCodeRuntimeDenyEntry;
}

function versionInRange(version: string | null, range: string | undefined): boolean {
  if (range === undefined) return true;
  if (version === null) return false;
  if (version === range) return true;
  const prefix = range.endsWith('.x') ? range.slice(0, -1) : range.endsWith('.') ? range : null;
  if (prefix !== null) return version.startsWith(prefix);
  return false;
}

export function classifyOpenCodeRuntime(
  evidence: OpenCodeRuntimeEvidence,
  denyList: readonly OpenCodeRuntimeDenyEntry[] = KNOWN_INCOMPATIBLE_OPENCODE_RUNTIMES,
): OpenCodeRuntimeClassification {
  if (evidence.runtimeLine === null) return { status: 'not-classified' };
  const matched = denyList.find(
    (entry) =>
      entry.runtimeLine === evidence.runtimeLine &&
      versionInRange(evidence.version, entry.versionRange),
  );
  return matched ? { status: 'known-unsupported', matched } : { status: 'not-classified' };
}

// ─── Host contract compatibility ─────────────────────────────────────────────

/** Exact OpenCode host version exercised by CI and represented by the baseline. */
export const TESTED_OPENCODE_HOST_VERSION = '1.18.29';

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
  /** Compatibility projection for existing doctor output; value is exact, not a semver range. */
  readonly testedRange: string;
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
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

function versionInBoundedRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  const lowerMatch = range.match(/>=(\d+\.\d+\.\d+)/);
  const upperMatch = range.match(/<(\d+\.\d+\.\d+)/);
  const lower = lowerMatch ? parseSemver(lowerMatch[1]!) : null;
  const upper = upperMatch ? parseSemver(upperMatch[1]!) : null;
  if (!lower && !upper) return false;
  if (lower && compareSemver(parsed, lower) < 0) return false;
  if (upper && compareSemver(parsed, upper) >= 0) return false;
  return true;
}

function baseClassification() {
  return {
    testedVersion: TESTED_OPENCODE_HOST_VERSION,
    testedRange: TESTED_OPENCODE_HOST_VERSION,
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
