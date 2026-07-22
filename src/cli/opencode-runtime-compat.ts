/**
 * @module cli/opencode-runtime-compat
 * @description Canonical authority for OpenCode instruction-source compatibility.
 *
 * FlowGuard installs its mandates by registering an entry in the OpenCode
 * `instructions[]` array (see src/templates/mandates.ts). Per the official
 * OpenCode documentation this is the supported, version-independent mechanism
 * for loading custom instruction sources:
 *   - https://opencode.ai/docs/config#instructions  (retrieved 2026-07)
 *   - https://opencode.ai/docs/rules                 (retrieved 2026-07)
 *
 * The documentation ties `instructions[]` resolution to no particular OpenCode
 * version, and it is exposed identically to the CLI and the Desktop app. There
 * is therefore no documented "supported version" list to allow-list against.
 *
 * Classification model (deliberate, reviewed decision):
 *   - Default posture is `compatible`. An unknown runtime (including the
 *     Desktop app, which exposes no `--version` executable) is treated as
 *     compatible because the documented instruction-source mechanism is
 *     version-independent. This keeps FlowGuard working on Desktop and every
 *     CLI version.
 *   - `known-incompatible` is asserted ONLY when a runtime positively matches
 *     an entry in {@link KNOWN_INCOMPATIBLE_OPENCODE_RUNTIMES}. This is a
 *     deny-list, not an allow-list. It is seeded empty: no OpenCode runtime is
 *     currently known — with evidence — to accept the `instructions[]` array
 *     entry while failing to resolve it as an instruction source. Entries may
 *     only be added with a positive, cited evidence source in `verifiedBy`.
 *
 * This is a pure module: no I/O, no side effects. Detection lives in
 * opencode-runtime-detect.ts; this module only classifies evidence.
 *
 * @version v1
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
 * The official docs describe `instructions[]` as universally supported. Do NOT
 * add speculative entries — each addition is a security-boundary change that
 * requires a positive, cited `verifiedBy` source.
 */
export const KNOWN_INCOMPATIBLE_OPENCODE_RUNTIMES: readonly OpenCodeRuntimeDenyEntry[] = [];

/** Classification result. `unknown` runtimes classify as `compatible`. */
export type OpenCodeRuntimeCompatibility = 'compatible' | 'known-incompatible';

/**
 * The matched deny entry when classification is `known-incompatible`.
 * `undefined` when `compatible`.
 */
export interface OpenCodeRuntimeClassification {
  readonly compatibility: OpenCodeRuntimeCompatibility;
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
 * Fail-open on unknown (returns `compatible`) is intentional and documented:
 * the instruction-source mechanism is version-independent per official docs,
 * and Desktop exposes no version. Blocking is reserved for positively-known
 * incompatible runtimes.
 */
export function classifyOpenCodeRuntime(
  evidence: OpenCodeRuntimeEvidence,
  denyList: readonly OpenCodeRuntimeDenyEntry[] = KNOWN_INCOMPATIBLE_OPENCODE_RUNTIMES,
): OpenCodeRuntimeClassification {
  if (evidence.runtimeLine === null) {
    return { compatibility: 'compatible' };
  }
  const matched = denyList.find(
    (entry) =>
      entry.runtimeLine === evidence.runtimeLine &&
      versionInRange(evidence.version, entry.versionRange),
  );
  return matched
    ? { compatibility: 'known-incompatible', matched }
    : { compatibility: 'compatible' };
}
