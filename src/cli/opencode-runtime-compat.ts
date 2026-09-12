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
 *     loaded the file into the model context. FlowGuard has no reliable surface to verify activation
 *     (the Desktop app exposes no `--version` executable and no documented
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

/**
 * Evidence about the detected OpenCode runtime. All fields are best-effort;
 * `null` means "could not be determined" and never implies incompatibility.
 */
export interface OpenCodeRuntimeEvidence {
  /** Runtime kind derived from config-ownership heuristics. */
  readonly runtimeKind: OpenCodeRuntimeKind;
  /** OpenCode version string, best-effort (CLI only). `null` for Desktop/unknown. */
  readonly version: string | null;
  /** A runtime-line identifier, when one can be positively determined. */
  readonly runtimeLine: string | null;
}

/**
 * A positively-known incompatible OpenCode runtime. Adding an entry is a
 * fail-closed act: it flips affected installations to a blocked reason. Every
 * entry MUST carry a cited evidence source.
 */
export interface OpenCodeRuntimeDenyEntry {
  /** Runtime-line identifier this entry matches (exact match). */
  readonly runtimeLine: string;
  /** Optional semver range this entry applies to. Omitted = all versions of the line. */
  readonly versionRange?: string;
  /** Human-readable reason this runtime does not resolve `instructions[]`. */
  readonly reason: string;
  /** Cited evidence proving the incompatibility (issue link, changelog, test). */
  readonly verifiedBy: string;
}

/**
 * Deny-list of OpenCode runtimes positively known to accept the FlowGuard
 * `instructions[]` entry without resolving it as an instruction source.
 *
 * SEEDED EMPTY BY DESIGN. No such runtime is currently known with evidence.
 * Do NOT add speculative entries — each addition is a security-boundary change
 * that requires a positive, cited `verifiedBy` source.
 */
export const KNOWN_INCOMPATIBLE_OPENCODE_RUNTIMES: readonly OpenCodeRuntimeDenyEntry[] = [];

/**
 * Classification of the instruction source.
 *
 * - `not-classified`: the runtime does not match a positively-known
 *   incompatible entry. Activation is NOT asserted.
 * - `known-unsupported`: the runtime positively matches the deny-list.
 *
 * There is deliberately no `compatible`/`supported`/`active` value: FlowGuard
 * does not verify activation and must not claim it.
 */
export type OpenCodeRuntimeStatus = 'not-classified' | 'known-unsupported';

/**
 * The matched deny entry when status is `known-unsupported`.
 * `undefined` when `not-classified`.
 */
export interface OpenCodeRuntimeClassification {
  readonly status: OpenCodeRuntimeStatus;
  readonly matched?: OpenCodeRuntimeDenyEntry;
}

/**
 * Naive semver-range membership for the deny-list. Supports exact version
 * strings and a leading-prefix wildcard form (`"1.2.x"` / `"1.2."`). This is
 * intentionally conservative: an unparseable or non-matching range yields
 * `false`, so an ambiguous deny entry never blocks. The deny-list is empty by
 * default, so this path is exercised only by explicitly-added entries.
 */
function versionInRange(version: string | null, range: string | undefined): boolean {
  if (range === undefined) return true; // entry applies to all versions of the line
  if (version === null) return false; // cannot confirm membership without a version
  if (version === range) return true;
  const prefix = range.endsWith('.x') ? range.slice(0, -1) : range.endsWith('.') ? range : null;
  if (prefix !== null) return version.startsWith(prefix);
  return false;
}

/**
 * Classify runtime evidence against the deny-list.
 *
 * An unknown runtime (no positively determinable runtime-line, including the
 * Desktop app) classifies as `not-classified` — present but activation-unverified.
 * It is NEVER classified as compatible/supported. Blocking (`known-unsupported`)
 * is reserved for positively-known incompatible runtimes on the deny-list.
 */
export function classifyOpenCodeRuntime(
  evidence: OpenCodeRuntimeEvidence,
  denyList: readonly OpenCodeRuntimeDenyEntry[] = KNOWN_INCOMPATIBLE_OPENCODE_RUNTIMES,
): OpenCodeRuntimeClassification {
  if (evidence.runtimeLine === null) {
    return { status: 'not-classified' };
  }
  const matched = denyList.find(
    (entry) =>
      entry.runtimeLine === evidence.runtimeLine &&
      versionInRange(evidence.version, entry.versionRange),
  );
  return matched ? { status: 'known-unsupported', matched } : { status: 'not-classified' };
}

// ─── Host contract compatibility ─────────────────────────────────────────────

/**
 * Exact OpenCode host version exercised by CI and represented by the committed
 * host baseline. No surrounding minor/patch range inherits `verified` status
 * without independent evidence.
 */
export const TESTED_OPENCODE_HOST_VERSION = '1.18.29';

/**
 * A positively-known incompatible OpenCode host contract version. Same evidence
 * discipline as the instruction deny-list: every entry requires a cited source.
 */
export interface OpenCodeHostContractDenyEntry {
  /** Semver range (`>=X <Y`) this entry applies to. */
  readonly versionRange: string;
  /** Human-readable reason the host contract is incompatible. */
  readonly reason: string;
  /** Cited evidence proving the incompatibility (issue link, changelog, test). */
  readonly verifiedBy: string;
}

/**
 * Deny-list of OpenCode host contract versions positively known to break the
 * FlowGuard plugin contract (hooks, events, adapter semantics).
 *
 * SEEDED EMPTY BY DESIGN. Adding an entry is a security-boundary change that
 * requires a positive, cited `verifiedBy` source.
 */
export const KNOWN_INCOMPATIBLE_OPENCODE_HOST_CONTRACTS: readonly OpenCodeHostContractDenyEntry[] =
  [];

/**
 * Host contract compatibility status.
 *
 * - `verified`: the detected version exactly equals {@link TESTED_OPENCODE_HOST_VERSION}.
 * - `compatible-unverified`: the version is unknown or not the tested version.
 *   It is NOT blocked, but it must never be presented as verified.
 * - `known-incompatible`: the version positively matches the host-contract deny-list.
 */
export type OpenCodeHostContractStatus =
  | 'verified'
  | 'compatible-unverified'
  | 'known-incompatible';

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
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/** True when `version` is a concrete version inside the `>=X <Y` range. */
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

function isExactTestedHostVersion(version: string): boolean {
  return version.trim() === TESTED_OPENCODE_HOST_VERSION;
}

/**
 * Classify the detected OpenCode host version against the exact tested host
 * baseline.
 *
 * Unknown, unparseable, newer patch, prerelease, and nightly versions are all
 * `compatible-unverified` — never `verified`. Blocking is reserved for
 * positively-known incompatible entries, so an unknown host never silently
 * claims compatibility and never blocks install by accident.
 */
export function classifyOpenCodeHostContract(
  version: string | null,
  denyList: readonly OpenCodeHostContractDenyEntry[] = KNOWN_INCOMPATIBLE_OPENCODE_HOST_CONTRACTS,
): OpenCodeHostContractClassification {
  if (version !== null) {
    const matched = denyList.find((entry) => versionInBoundedRange(version, entry.versionRange));
    if (matched) {
      return {
        status: 'known-incompatible',
        testedVersion: TESTED_OPENCODE_HOST_VERSION,
        matched,
        reason: matched.reason,
      };
    }
  }

  if (version !== null && isExactTestedHostVersion(version)) {
    return {
      status: 'verified',
      testedVersion: TESTED_OPENCODE_HOST_VERSION,
      reason: `detected host version ${version} exactly matches the tested host baseline`,
    };
  }

  return {
    status: 'compatible-unverified',
    testedVersion: TESTED_OPENCODE_HOST_VERSION,
    reason:
      version === null
        ? 'host version could not be determined'
        : `detected host version ${version} does not exactly match the tested host baseline`,
  };
}
