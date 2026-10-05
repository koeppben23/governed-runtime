/**
 * @module architecture/mutation-authority-inventory
 * @description Mutation-scope authority SSOT.
 *
 * The inventory is the single machine-readable authority for which production
 * files must be mutation-tested, which profile covers them, and why every
 * non-covered authority is deferred or rejected. `mutation-scope.test.ts`
 * enforces the contract; `testing-strategy.test.ts` derives documentation
 * obligations from it.
 *
 * Classification criteria (`classification`):
 * - `required`: canonical authority or fail-closed trust boundary. Must be
 *   present in the profile's Stryker mutate list, must name covering suites
 *   that the profile's Stryker Vitest config selects, and must carry either an
 *   immutable `admission` record or a `legacyBaseline` reference.
 * - `admission-backlog`: meaningful mutants are expected or proven, but the
 *   profile full run has not yet admitted the target (score gate) or the
 *   target is deferred to a dedicated admission bundle. A score below the
 *   break threshold alone keeps a target here — it never becomes
 *   `not-mutation-suitable` by score.
 * - `not-mutation-suitable`: under the profile's canonical mutator set no
 *   meaningful mutants exist, or every producible mutant demonstrably fails to
 *   encode a semantic contract (pure re-exports, type-only modules, static
 *   help text).
 *
 * Provenance rules:
 * - `coveringSuites` is reachability evidence only: the suite is selected by
 *   the profile's Stryker Vitest config. It does not prove that a suite kills
 *   a mutant; killing evidence is the per-target score in the profile full
 *   run, enforced by `scripts/verify-mutation-admission.mjs`.
 * - `admission` records are historical and immutable: they capture the first
 *   full-run admission of a target (commit SHA, score, killed/survived,
 *   config). Later runs never rewrite them; the verifier enforces the current
 *   per-target threshold for every admitted selector (`--require-admitted`,
 *   sourced from the drift-guarded registry projection).
 * - Targets that predate this inventory carry `legacyBaseline` instead of a
 *   reconstructed per-file score. Backfilling invented numbers is forbidden.
 * - Provenance is explicit and exclusive: every `required()` entry must provide
 *   either a real `admission` record or an explicit `legacy: true` opt-in. The
 *   helper throws when both or neither are given, so a new target can never
 *   acquire a fabricated legacy history by omission.
 *
 * Glob entries (`root` + `pattern`) defer whole surfaces. They are expanded by
 * the guard; files that carry an exact entry are masked out, and the remaining
 * effective set must be non-empty and disjoint from every mutate list.
 *
 * Admission policy: a targeted run is diagnostic only. Admission evidence is
 * the profile full run. The profile-wide aggregate must meet the break
 * threshold; targets named via `--require-selectors` (new admissions) and every
 * registry-admitted selector under `--require-admitted` must additionally meet
 * the per-target break threshold. Targets without an admission record below the
 * per-target threshold are reported as a diagnostic note and remain tracked
 * for test hardening; range selectors are scored only over mutants inside the
 * declared range, and every mutant of a range-profile file must map to a
 * configured range.
 */

import { isTestSourcePath } from './module-classification.js';

export type MutationProfile =
  | 'base'
  | 'event-core'
  | 'human-projection'
  | 'identity-jwks'
  | 'mandates'
  | 'schemas'
  | 'topology';

export type MutationAuthorityClass =
  'required' | 'admission-candidate' | 'admission-backlog' | 'not-mutation-suitable';

export interface MutationProfileDefinition {
  readonly configFile: string;
  readonly vitestConfigFile: string;
}

/**
 * Profile metadata is owned by `scripts/mutation-profile-registry.json`.
 * This projection keeps only the fields the inventory contract needs; the
 * registry closure guard proves the key sets cannot drift apart.
 */
export { MUTATION_PROFILES } from './mutation-authority-profile-registry.js';

export interface AdmissionRecord {
  readonly verifiedAt: string;
  readonly commitSha: string;
  readonly scoreAtAdmission: number;
  readonly killed: number;
  readonly survived: number;
  readonly config: string;
  readonly reportDigest?: string;
}

/** Historical provenance for targets that predate this inventory. */
export interface LegacyBaseline {
  readonly since: 'pre-authority-inventory';
  readonly authorityRef: string;
}

interface AuthorityMetadata {
  readonly authority: string;
  readonly source: readonly string[];
}

export interface RequiredAuthorityEntry extends AuthorityMetadata {
  readonly classification: 'required';
  readonly profile: MutationProfile;
  readonly mutateSelector: string;
  readonly target: string;
  readonly coveringSuites: readonly string[];
  readonly critical?: boolean;
  readonly admission?: AdmissionRecord;
  readonly legacyBaseline?: LegacyBaseline;
}

/**
 * A target staged inside a profile for authoritative admission measurement.
 * It is mutated by its profile but carries no provenance yet: the full-run
 * verdict decides whether it becomes `required` (admission) or
 * `admission-backlog` (below threshold / not admitted).
 */
export interface AdmissionCandidateEntry extends AuthorityMetadata {
  readonly classification: 'admission-candidate';
  readonly profile: MutationProfile;
  readonly mutateSelector: string;
  readonly target: string;
  readonly coveringSuites: readonly string[];
  readonly reason: string;
  readonly critical?: boolean;
}

export interface DeferredAuthorityEntry extends AuthorityMetadata {
  readonly classification: 'admission-backlog';
  readonly target: string;
  readonly reason: string;
  readonly profile?: MutationProfile;
}

/** A target that produces no meaningful mutants under ONE profile's regime. */
export interface NotSuitableAuthorityEntry extends AuthorityMetadata {
  readonly classification: 'not-mutation-suitable';
  readonly target: string;
  readonly reason: string;
  readonly profile: MutationProfile;
}

export interface DeferredAuthorityGlobEntry extends AuthorityMetadata {
  readonly classification: 'admission-backlog';
  readonly root: string;
  readonly pattern: string;
  readonly reason: string;
}

export type MutationAuthorityEntry =
  | RequiredAuthorityEntry
  | AdmissionCandidateEntry
  | DeferredAuthorityEntry
  | NotSuitableAuthorityEntry
  | DeferredAuthorityGlobEntry;

export interface AuthorityRoot {
  readonly root: string;
  readonly authority: string;
  readonly source: readonly string[];
}

export {
  AUTHORITY_ROOTS,
  MUTATION_AUTHORITY_INVENTORY,
  assertRequiredProvenance,
} from './mutation-authority-inventory-data.js';

/**
 * Production source predicate used by the completeness closure.
 *
 * Delegates to the single source-class authority. Callers pass repo-relative
 * paths (`src/...`); the authority operates on paths relative to `src/`.
 */
export function isProductionSource(relativePath: string): boolean {
  if (!relativePath.endsWith('.ts')) return false;
  const relativeFromSrc = relativePath.startsWith('src/')
    ? relativePath.slice('src/'.length)
    : relativePath;
  return !isTestSourcePath(relativeFromSrc);
}

/** Normalizes a Stryker mutate selector to its target path. */
export function targetOfSelector(selector: string): string {
  const separator = selector.lastIndexOf(':');
  if (separator === -1) return selector;
  const suffix = selector.slice(separator + 1);
  return /^\d+-\d+$/.test(suffix) ? selector.slice(0, separator) : selector;
}
