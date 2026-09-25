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

import { readFileSync } from 'node:fs';

import { admissionRecord } from './mutation-admission-records.js';
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

interface ProfileRegistry {
  readonly version: number;
  readonly profiles: Readonly<
    Record<string, { readonly configFile: string; readonly vitestConfigFile: string }>
  >;
}

/**
 * Profile metadata is owned by `scripts/mutation-profile-registry.json`.
 * This projection keeps only the fields the inventory contract needs; the
 * registry closure guard proves the key sets cannot drift apart.
 */
const PROFILE_REGISTRY = JSON.parse(
  readFileSync(
    new URL('../../../scripts/mutation-profile-registry.json', import.meta.url),
    'utf-8',
  ),
) as ProfileRegistry;

export const MUTATION_PROFILES = Object.fromEntries(
  Object.entries(PROFILE_REGISTRY.profiles).map(([profile, entry]) => [
    profile,
    { configFile: entry.configFile, vitestConfigFile: entry.vitestConfigFile },
  ]),
) as Readonly<Record<MutationProfile, MutationProfileDefinition>>;

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

const SOURCE = {
  rootAgents: 'AGENTS.md#canonical-authorities',
  productMandates: 'AGENTS.md#product-mandates',
  machine: 'src/machine/AGENTS.md',
  config: 'src/config/AGENTS.md',
  integration: 'src/integration/AGENTS.md',
  trustBoundaries: 'docs/trust-boundaries.md',
  scope: 'docs/testing-strategy.md#mutation-testing',
} as const;

function legacyFor(profile: MutationProfile): LegacyBaseline {
  return {
    since: 'pre-authority-inventory',
    authorityRef: MUTATION_PROFILES[profile].configFile,
  };
}

/**
 * Provenance is explicit and exclusive: a required target either carries a
 * real admission record or is explicitly marked as a pre-authority-inventory
 * legacy target. The helper never synthesizes legacy provenance, so a new
 * target cannot acquire a fabricated history by omission.
 */
export function assertRequiredProvenance(
  target: string,
  options: { readonly admission?: AdmissionRecord; readonly legacy?: true },
): void {
  const hasAdmission = options.admission !== undefined;
  const hasLegacy = options.legacy === true;
  if (hasAdmission === hasLegacy) {
    throw new Error(
      `required(${target}): exactly one of 'admission' or 'legacy: true' must be provided`,
    );
  }
}

function required(
  target: string,
  authority: string,
  coveringSuites: readonly string[],
  options: {
    readonly profile?: MutationProfile;
    readonly source?: readonly string[];
    readonly selector?: string;
    readonly critical?: boolean;
    readonly admission?: AdmissionRecord;
    /** Explicit opt-in for targets that predate the authority inventory. */
    readonly legacy?: true;
  } = {},
): RequiredAuthorityEntry {
  assertRequiredProvenance(target, options);
  const profile = options.profile ?? 'base';
  return {
    classification: 'required',
    profile,
    mutateSelector: options.selector ?? target,
    target,
    authority,
    source: options.source ?? [SOURCE.scope],
    coveringSuites,
    ...(options.critical === true ? { critical: true } : {}),
    ...(options.admission === undefined
      ? { legacyBaseline: legacyFor(profile) }
      : { admission: options.admission }),
  };
}

function deferred(
  target: string,
  authority: string,
  reason: string,
  options: {
    readonly profile?: MutationProfile;
    readonly source?: readonly string[];
  } = {},
): DeferredAuthorityEntry {
  return {
    classification: 'admission-backlog',
    target,
    authority,
    source: options.source ?? [SOURCE.scope],
    reason,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
  };
}

function candidate(
  target: string,
  authority: string,
  profile: MutationProfile,
  coveringSuites: readonly string[],
  reason: string,
  options: {
    readonly selector?: string;
    readonly source?: readonly string[];
    readonly critical?: boolean;
  } = {},
): AdmissionCandidateEntry {
  return {
    classification: 'admission-candidate',
    target,
    authority,
    source: options.source ?? [SOURCE.scope],
    reason,
    profile,
    mutateSelector: options.selector ?? target,
    coveringSuites,
    ...(options.critical === undefined ? {} : { critical: options.critical }),
  };
}

function notSuitable(
  target: string,
  authority: string,
  reason: string,
  profile: MutationProfile,
  options: { readonly source?: readonly string[] } = {},
): NotSuitableAuthorityEntry {
  return {
    classification: 'not-mutation-suitable',
    target,
    authority,
    source: options.source ?? [SOURCE.scope],
    reason,
    profile,
  };
}

function deferredGlob(
  root: string,
  authority: string,
  reason: string,
  source: readonly string[] = [SOURCE.scope],
): DeferredAuthorityGlobEntry {
  return {
    classification: 'admission-backlog',
    root,
    pattern: '**',
    authority,
    source,
    reason,
  };
}

const DEFERRED_REASON =
  'Deferred surface behind the admission gate; admission requires a profile full run with per-target evidence.';

const DEEP_REASON =
  'Deferred to the deep authority expansion bundle; admission requires a profile full run with per-target evidence.';

/**
 * Relocated targets whose historical admission is path-bound. The move
 * changed the target identity, so the old evidence is NOT rebound and no
 * legacy provenance is synthesized; re-admission requires a fresh full run.
 */
const RELOCATED_ADMISSION_REASON =
  'Previously admitted under the historical path. The bounded-context move changes target identity; historical admission evidence is not rebound to the new path. Re-admission requires a full base-profile run on the new target identity.';

/**
 * Authorities that must never leave the mutation scope. Every root is backed
 * by an explicit source; adding a root is a deliberate inventory change.
 */
export const AUTHORITY_ROOTS: readonly AuthorityRoot[] = [
  {
    root: 'src/machine',
    authority: 'State transitions, guards, commands',
    source: [SOURCE.machine],
  },
  {
    root: 'src/config',
    authority: 'Config schema, reason codes, policy types',
    source: [SOURCE.config],
  },
  {
    root: 'src/state',
    authority: 'Session state schema and evidence contracts',
    source: [SOURCE.trustBoundaries],
  },
  {
    root: 'src/shared',
    authority: 'Canonical cross-layer schemas and low-level primitives',
    source: [SOURCE.rootAgents],
  },
  {
    root: 'src/audit',
    authority: 'Audit integrity, completeness, timestamp authorities',
    source: [SOURCE.trustBoundaries],
  },
  {
    root: 'src/adapters',
    authority: 'Persistence, workspace, git trust boundaries',
    source: [SOURCE.trustBoundaries],
  },
  {
    root: 'src/identity',
    authority: 'Actor identity and IdP boundary',
    source: [SOURCE.trustBoundaries],
  },
  {
    root: 'src/verification',
    authority: 'Observed execution and assertion evidence',
    source: [SOURCE.trustBoundaries],
  },
  {
    root: 'src/discovery',
    authority: 'Discovery and verification candidate planning',
    source: [SOURCE.trustBoundaries],
  },
  {
    root: 'src/logging',
    authority: 'Operational logging boundary',
    source: [SOURCE.trustBoundaries],
  },
  {
    root: 'src/hooks',
    authority: 'Host hook enforcement boundary',
    source: [SOURCE.trustBoundaries],
  },
  {
    root: 'src/mcp-server',
    authority: 'MCP tool surface boundary',
    source: [SOURCE.trustBoundaries],
  },
  {
    root: 'src/templates',
    authority: 'Installed mandates and command templates',
    source: [SOURCE.productMandates],
  },
  {
    root: 'src/rendering',
    authority: 'Mandate rendering projection',
    source: [SOURCE.productMandates],
  },
  {
    root: 'src/redaction',
    authority: 'Export redaction boundary',
    source: [SOURCE.trustBoundaries],
  },
  {
    root: 'src/presentation',
    authority: 'Human projection authorities',
    source: [SOURCE.trustBoundaries],
  },
  {
    root: 'src/integration',
    authority: 'Runtime composition and review pipeline',
    source: [SOURCE.integration],
  },
];

export const MUTATION_AUTHORITY_INVENTORY: readonly MutationAuthorityEntry[] = [
  // ── Base profile: required (curated governance core) ──────────────────────
  required(
    'src/adapters/persistence-lock.ts',
    'Inter-process write lock for persisted state',
    ['src/adapters/__tests__/persistence-lock.test.ts'],
    {
      admission: admissionRecord('src/adapters/persistence-lock.ts'),
    },
  ),
  required(
    'src/adapters/host-adapter.ts',
    'Host runtime adapter boundary',
    ['src/adapters/host-adapter.test.ts'],
    {
      admission: admissionRecord('src/adapters/host-adapter.ts'),
    },
  ),
  required(
    'src/adapters/persistence.ts',
    'Durable session state persistence',
    [
      'src/adapters/adapters-atomic-write.test.ts',
      'src/adapters/adapters-persistence-basics.test.ts',
    ],
    {
      admission: admissionRecord('src/adapters/persistence.ts'),
    },
  ),
  required(
    'src/adapters/persistence-audit.ts',
    'Durable audit JSONL trail adapter',
    ['src/adapters/adapters-schema-audit.test.ts', 'src/adapters/workspace-archive.test.ts'],
    {
      admission: admissionRecord('src/adapters/persistence-audit.ts'),
    },
  ),
  required(
    'src/adapters/ip-validation.ts',
    'SSRF and private-IP guard for outbound URLs',
    ['src/adapters/ip-validation.test.ts'],
    { legacy: true },
  ),
  required(
    'src/mcp-server/execution-limiter.ts',
    'MCP tool execution rate limiting',
    ['src/mcp-server/mcp-server.test.ts'],
    {
      admission: admissionRecord('src/mcp-server/execution-limiter.ts'),
    },
  ),
  required(
    'src/mcp-server/session-resolver.ts',
    'Host session resolution for MCP and hooks',
    ['src/mcp-server/mcp-server.test.ts', 'src/hooks/http-server.test.ts'],
    { legacy: true },
  ),
  required(
    'src/mcp-server/tool-adapter.ts',
    'MCP tool registration and argument adaptation',
    ['src/mcp-server/mcp-server.test.ts'],
    { legacy: true },
  ),
  required(
    'src/archive/content-digest.ts',
    'Archive content digest computation',
    ['src/archive/content-digest.test.ts'],
    {
      admission: admissionRecord('src/archive/content-digest.ts'),
    },
  ),
  required(
    'src/audit/completeness.ts',
    'Audit event completeness classification',
    ['src/audit/audit-completeness.test.ts'],
    {
      critical: true,
      admission: admissionRecord('src/audit/completeness.ts'),
    },
  ),
  required(
    'src/audit/integrity.ts',
    'Audit hash-chain integrity verification',
    ['src/audit/audit-integrity.test.ts'],
    {
      critical: true,
      admission: admissionRecord('src/audit/integrity.ts'),
    },
  ),
  required(
    'src/audit/event-builders.ts',
    'Audit event body builders and factories',
    ['src/audit/audit-types.test.ts', 'src/integration/plugin-audit.test.ts'],
    {
      admission: admissionRecord('src/audit/event-builders.ts'),
    },
  ),
  required(
    'src/audit/ntp-check.ts',
    'NTP clock-skew check for TSA evidence',
    ['src/audit/ntp-check.test.ts'],
    {
      admission: admissionRecord('src/audit/ntp-check.ts'),
    },
  ),
  required(
    'src/audit/rfc-3161-pkijs-verifier.ts',
    'RFC 3161 timestamp token verification',
    ['src/audit/rfc3161-pkijs-verifier.test.ts'],
    {
      admission: admissionRecord('src/audit/rfc-3161-pkijs-verifier.ts'),
    },
  ),
  required(
    'src/audit/rfc-3161-token-parse.ts',
    'RFC 3161 token structure parsing',
    ['src/audit/rfc3161-pkijs-verifier.test.ts'],
    {
      admission: admissionRecord('src/audit/rfc-3161-token-parse.ts'),
    },
  ),
  required(
    'src/audit/rfc-3161-signer-verification.ts',
    'RFC 3161 signer certificate verification',
    ['src/audit/rfc3161-pkijs-verifier.test.ts'],
    {
      admission: admissionRecord('src/audit/rfc-3161-signer-verification.ts'),
    },
  ),
  required(
    'src/audit/timestamp-verification.ts',
    'Timestamp evidence verification',
    ['src/audit/timestamp-verification.test.ts'],
    {
      admission: admissionRecord('src/audit/timestamp-verification.ts'),
    },
  ),
  required(
    'src/audit/timestamp-token-verification.ts',
    'Canonical TSA token imprint verification',
    ['src/audit/rfc3161-pkijs-verifier.test.ts'],
    {
      admission: admissionRecord('src/audit/timestamp-token-verification.ts'),
    },
  ),
  required(
    'src/adapters/workspace/archive.ts',
    'Archive creation authority',
    ['src/adapters/workspace-archive.test.ts'],
    { legacy: true },
  ),
  required(
    'src/adapters/workspace/archive-publish.ts',
    'Archive publication boundary',
    ['src/adapters/workspace/archive-publish.test.ts'],
    {
      admission: admissionRecord('src/adapters/workspace/archive-publish.ts'),
    },
  ),
  required(
    'src/adapters/workspace/archive-tar.ts',
    'Deterministic archive tar inspection',
    ['src/adapters/workspace/archive-tar.test.ts'],
    { legacy: true },
  ),
  required(
    'src/adapters/workspace/archive-timestamp-verification.ts',
    'Archive TSA verification',
    ['src/adapters/workspace/archive-timestamp-verification.test.ts'],
    {
      admission: admissionRecord('src/adapters/workspace/archive-timestamp-verification.ts'),
    },
  ),
  required(
    'src/adapters/workspace/archive-verify-manifest.ts',
    'Archive manifest verification',
    ['src/adapters/workspace/archive-verify-manifest.test.ts'],
    {
      admission: admissionRecord('src/adapters/workspace/archive-verify-manifest.ts'),
    },
  ),
  required(
    'src/adapters/workspace/archive-verify-chain.ts',
    'Archive verification verdict chain',
    ['src/adapters/workspace/archive-verify-chain.test.ts'],
    { legacy: true },
  ),
  required(
    'src/adapters/workspace/archive-verify-artifact-binding.ts',
    'Archive artifact-binding verification',
    [
      'src/adapters/workspace/archive-verify-chain.test.ts',
      'src/adapters/workspace/archive-verify-artifact-binding-mutation.test.ts',
    ],
    {
      admission: admissionRecord('src/adapters/workspace/archive-verify-artifact-binding.ts'),
    },
  ),
  required(
    'src/adapters/workspace/archive-verify-audit-chain.ts',
    'Archive audit-chain verification',
    [
      'src/adapters/workspace/archive-verify-chain.test.ts',
      'src/adapters/workspace/archive-verify-audit-chain-mutation.test.ts',
    ],
    {
      admission: admissionRecord('src/adapters/workspace/archive-verify-audit-chain.ts'),
    },
  ),
  required(
    'src/adapters/workspace/archive-verify-checksum.ts',
    'Archive checksum verification',
    [
      'src/adapters/workspace/archive-verify-chain.test.ts',
      'src/adapters/workspace/archive-verify-checksum-mutation.test.ts',
    ],
    {
      admission: admissionRecord('src/adapters/workspace/archive-verify-checksum.ts'),
    },
  ),
  required(
    'src/adapters/workspace/archive-verify-integrity.ts',
    'Archive integrity verification',
    [
      'src/adapters/workspace/archive-verify-chain.test.ts',
      'src/adapters/workspace/archive-verify-integrity-mutation.test.ts',
    ],
    {
      admission: admissionRecord('src/adapters/workspace/archive-verify-integrity.ts'),
    },
  ),
  required(
    'src/adapters/workspace/archive-verify-helpers.ts',
    'Archive verification helpers',
    ['src/adapters/workspace/archive-verify-helpers.test.ts'],
    {
      admission: admissionRecord('src/adapters/workspace/archive-verify-helpers.ts'),
    },
  ),
  required(
    'src/audit/proofgraph/evaluate.ts',
    'ProofGraph evaluation authority',
    ['src/audit/proofgraph/evaluate.test.ts'],
    {
      admission: admissionRecord('src/audit/proofgraph/evaluate.ts'),
    },
  ),
  required(
    'src/audit/proofgraph/gate.ts',
    'ProofGraph gate decision',
    ['src/audit/proofgraph/gate.test.ts'],
    {
      admission: admissionRecord('src/audit/proofgraph/gate.ts'),
    },
  ),
  required(
    'src/integration/proofgraph/claim-contract.ts',
    'Proof claim contract materialization',
    ['src/integration/proofgraph/claim-contract.test.ts'],
    {
      admission: admissionRecord('src/integration/proofgraph/claim-contract.ts'),
    },
  ),
  required(
    'src/integration/proofgraph/claim-contract-rules.ts',
    'Claim declaration contract rules',
    ['src/integration/proofgraph/claim-contract.test.ts'],
    {
      admission: admissionRecord('src/integration/proofgraph/claim-contract-rules.ts'),
    },
  ),
  required(
    'src/integration/proofgraph/materialize-contract.ts',
    'Proof contract evidence binding',
    ['src/integration/proofgraph/materialize-contract.test.ts'],
    {
      admission: admissionRecord('src/integration/proofgraph/materialize-contract.ts'),
    },
  ),
  required(
    'src/audit/proofgraph/executed-test-binder.ts',
    'Executed-test evidence binding',
    ['src/audit/proofgraph/executed-test-binder.test.ts'],
    {
      admission: admissionRecord('src/audit/proofgraph/executed-test-binder.ts'),
    },
  ),
  required(
    'src/audit/proofgraph/counterexample-binder.ts',
    'Counterexample evidence binding',
    ['src/audit/proofgraph/counterexample-binder.test.ts'],
    {
      admission: admissionRecord('src/audit/proofgraph/counterexample-binder.ts'),
    },
  ),
  required(
    'src/audit/proofgraph/assertion-evidence-binding.ts',
    'Assertion evidence binding',
    ['src/audit/proofgraph/assertion-evidence-binding.test.ts'],
    {
      admission: admissionRecord('src/audit/proofgraph/assertion-evidence-binding.ts'),
    },
  ),
  required(
    'src/audit/proofgraph/enforcement-projection.ts',
    'Enforcement evidence projection',
    ['src/audit/proofgraph/enforcement-projection.test.ts'],
    {
      admission: admissionRecord('src/audit/proofgraph/enforcement-projection.ts'),
    },
  ),
  required(
    'src/verification/execution-subject.ts',
    'Observed execution subject binding',
    ['src/verification/execution-subject.test.ts'],
    {
      admission: admissionRecord('src/verification/execution-subject.ts'),
    },
  ),
  required(
    'src/discovery/verification-planner.ts',
    'Verification candidate planning',
    ['src/discovery/verification-planner.test.ts'],
    {
      admission: admissionRecord('src/discovery/verification-planner.ts'),
    },
  ),
  required(
    'src/config/policy-snapshot.ts',
    'Policy snapshot capture and validation',
    ['src/config/policy-snapshot.test.ts'],
    {
      critical: true,
      admission: admissionRecord('src/config/policy-snapshot.ts'),
    },
  ),
  required(
    'src/config/reasons.ts',
    'Reason registry and message interpolation',
    ['src/config/reasons-completeness.test.ts'],
    { legacy: true, critical: true },
  ),
  required(
    'src/config/profile.ts',
    'Built-in profile registry',
    ['src/config/profile-core.test.ts'],
    {
      admission: admissionRecord('src/config/profile.ts'),
    },
  ),
  required(
    'src/hooks/http-server.ts',
    'Local hook HTTP server boundary',
    ['src/hooks/http-server.test.ts'],
    { legacy: true },
  ),
  required(
    'src/hooks/pre-tool-use.ts',
    'PreToolUse enforcement hook',
    ['src/hooks/pre-tool-use.test.ts'],
    { legacy: true },
  ),
  required(
    'src/identity/token-verifier.ts',
    'IdP token verification',
    ['src/identity/token-verifier.test.ts'],
    {
      critical: true,
      admission: admissionRecord('src/identity/token-verifier.ts'),
    },
  ),
  required(
    'src/identity/key-resolver.ts',
    'JWKS key resolution',
    ['src/identity/key-resolver.test.ts'],
    { legacy: true, critical: true },
  ),
  required(
    'src/integration/installed-commands.ts',
    'Installed command registry',
    ['src/integration/installed-commands.test.ts'],
    { legacy: true },
  ),
  required(
    'src/integration/tool-classification.ts',
    'Tool risk classification',
    ['src/integration/tool-classification.test.ts'],
    {
      admission: admissionRecord('src/integration/tool-classification.ts'),
    },
  ),
  required(
    'src/integration/discovery/discovery-risk-paths.ts',
    'Discovery risk path classification',
    ['src/integration/discovery-risk-paths.test.ts'],
    {
      admission: admissionRecord('src/integration/discovery/discovery-risk-paths.ts'),
    },
  ),
  required(
    'src/integration/tools/challenge/pre-implementation-challenge.ts',
    'Pre-implementation challenge policy',
    ['src/integration/tools/pre-implementation-challenge.test.ts'],
    {
      admission: admissionRecord('src/integration/tools/challenge/pre-implementation-challenge.ts'),
    },
  ),
  required(
    'src/integration/tools/architecture/architecture-submit.ts',
    'Architecture evidence submission',
    ['src/integration/tools/architecture-tool.test.ts'],
    {
      admission: admissionRecord('src/integration/tools/architecture/architecture-submit.ts'),
    },
  ),
  required(
    'src/integration/tools/review-validation-mode.ts',
    'Multi-mode review validation',
    ['src/integration/tools/review-validation-mode.test.ts'],
    {
      critical: true,
      admission: admissionRecord('src/integration/tools/review-validation-mode.ts'),
    },
  ),
  required(
    'src/integration/review/validation/review-validation.ts',
    'Review validation aggregation',
    ['src/integration/tools/review-validation-findings.test.ts'],
    {
      admission: admissionRecord('src/integration/review/validation/review-validation.ts'),
    },
  ),
  required(
    'src/integration/review/validation/review-validation-structured-evidence.ts',
    'Structured review validation evidence',
    [
      'src/integration/review/validation/challenge-policy-evaluation.test.ts',
      'src/integration/tools/review-validation-findings.test.ts',
    ],
    {
      admission: admissionRecord(
        'src/integration/review/validation/review-validation-structured-evidence.ts',
      ),
    },
  ),
  required(
    'src/integration/plugin-audit-lifecycle-reason.ts',
    'Audit lifecycle reason mapping',
    ['src/integration/plugin-audit-lifecycle-reason.test.ts'],
    {
      critical: true,
      admission: admissionRecord('src/integration/plugin-audit-lifecycle-reason.ts'),
    },
  ),
  required(
    'src/integration/plugin-audit.ts',
    'In-process audit lifecycle authority',
    ['src/integration/plugin-audit.test.ts'],
    { legacy: true },
  ),
  required(
    'src/integration/services/decision-audit-intent.ts',
    'Durable human-decision audit intent authority',
    [
      'src/integration/services/decision-audit-intent.test.ts',
      'src/integration/plugin-audit-reconcile.test.ts',
      'src/integration/plugin-workspace-composition.test.ts',
    ],
    {
      admission: admissionRecord('src/integration/services/decision-audit-intent.ts'),
    },
  ),
  required(
    'src/integration/plugin-audit-reconcile.ts',
    'Durable audit reconciliation authority',
    ['src/integration/plugin-audit.test.ts', 'src/integration/plugin-audit-reconcile.test.ts'],
    {
      admission: admissionRecord('src/integration/plugin-audit-reconcile.ts'),
    },
  ),
  required(
    'src/integration/plugin-beforehooks.ts',
    'Host before-hook enforcement',
    ['src/integration/plugin-beforehooks.test.ts'],
    { legacy: true },
  ),
  required(
    'src/integration/plugin-afterhooks.ts',
    'Host after-hook enforcement tracking',
    ['src/integration/plugin-afterhooks-more.test.ts'],
    {
      admission: admissionRecord('src/integration/plugin-afterhooks.ts'),
    },
  ),
  required(
    'src/integration/plugin-helpers.ts',
    'Plugin shared helpers',
    ['src/integration/plugin-helpers.test.ts'],
    {
      admission: admissionRecord('src/integration/plugin-helpers.ts'),
    },
  ),
  required(
    'src/integration/plugin-workspace.ts',
    'Workspace composition boundary',
    ['src/integration/plugin-workspace.test.ts'],
    { legacy: true },
  ),
  required(
    'src/integration/plugin.ts',
    'Plugin composition root',
    ['src/integration/plugin.test.ts'],
    { legacy: true },
  ),
  required(
    'src/integration/runtime-lease.ts',
    'Runtime lease fencing authority',
    ['src/integration/runtime-lease.test.ts'],
    {
      admission: admissionRecord('src/integration/runtime-lease.ts'),
    },
  ),
  required(
    'src/state/evidence-mutation-episode.ts',
    'Host mutation episode invariants',
    ['src/state/evidence-mutation-episode.test.ts'],
    {
      admission: admissionRecord('src/state/evidence-mutation-episode.ts'),
    },
  ),
  required(
    'src/integration/review/enforcement/challenge-binding.ts',
    'Review challenge evidence binding',
    ['src/integration/review/enforcement/challenge-binding.test.ts'],
    { legacy: true },
  ),
  required(
    'src/integration/audit-outbox.ts',
    'Audit outbox durable delivery',
    [
      'src/integration/tools/audit-outbox.test.ts',
      'src/integration/plugin-direct-writer-proofgraph.test.ts',
    ],
    {
      admission: admissionRecord('src/integration/audit-outbox.ts'),
    },
  ),
  required(
    'src/templates/codex-plugin.ts',
    'Codex host plugin template',
    ['src/templates/codex-plugin.test.ts'],
    {
      critical: true,
      source: [SOURCE.productMandates],
      admission: admissionRecord('src/templates/codex-plugin.ts'),
    },
  ),
  required(
    'src/templates/claude-code-plugin.ts',
    'Claude Code host plugin template',
    ['src/templates/claude-code-plugin.test.ts'],
    {
      critical: true,
      source: [SOURCE.productMandates],
      admission: admissionRecord('src/templates/claude-code-plugin.ts'),
    },
  ),
  required(
    'src/integration/review/enforcement/enforcement.ts',
    'Review enforcement layers',
    [
      'src/integration/review/enforcement/enforce-before-verdict.test.ts',
      'src/integration/review/enforcement/retry-signal.test.ts',
    ],
    { legacy: true },
  ),
  required(
    'src/integration/review/enforcement/findings-consistency.ts',
    'Findings consistency authority',
    ['src/integration/review/enforcement/findings-consistency.test.ts'],
    { legacy: true },
  ),
  required(
    'src/integration/review/enforcement/challenge-consistency.ts',
    'Challenge consistency authority',
    ['src/integration/review/enforcement/challenge-consistency.test.ts'],
    {
      admission: admissionRecord('src/integration/review/enforcement/challenge-consistency.ts'),
    },
  ),
  required(
    'src/integration/review/enforcement/dispatch-signal.ts',
    'Review dispatch signal detection',
    ['src/integration/review/enforcement/dispatch-signal.test.ts'],
    {
      admission: admissionRecord('src/integration/review/enforcement/dispatch-signal.ts'),
    },
  ),
  required(
    'src/integration/review/dispatch/agent-resolution.ts',
    'Reviewer agent resolution',
    ['src/integration/review/dispatch/agent-resolution.test.ts'],
    {
      critical: true,
      admission: admissionRecord('src/integration/review/dispatch/agent-resolution.ts'),
    },
  ),
  required(
    'src/shared/canonical-json.ts',
    'Canonical JSON serialization authority',
    ['src/shared/canonical-json.test.ts'],
    {
      critical: true,
      admission: admissionRecord('src/shared/canonical-json.ts'),
    },
  ),
  required(
    'src/logging/error-serialize.ts',
    'Structured error serialization',
    ['src/logging/error-serialize.test.ts'],
    {
      admission: admissionRecord('src/logging/error-serialize.ts'),
    },
  ),
  required('src/machine/commands.ts', 'Machine command surface', ['src/machine/commands.test.ts'], {
    source: [SOURCE.machine],
    admission: admissionRecord('src/machine/commands.ts'),
  }),
  required(
    'src/machine/evaluate.ts',
    'Deterministic state evaluation',
    ['src/machine/evaluate.test.ts'],
    {
      source: [SOURCE.machine],
      admission: admissionRecord('src/machine/evaluate.ts'),
    },
  ),
  required('src/machine/guards.ts', 'Guard evaluation ordering', ['src/machine/guards.test.ts'], {
    source: [SOURCE.machine],
    admission: admissionRecord('src/machine/guards.ts'),
  }),
  required(
    'src/machine/workflow-directive.ts',
    'Workflow directive authority',
    ['src/machine/workflow-directive.test.ts'],
    {
      source: [SOURCE.machine],
      admission: admissionRecord('src/machine/workflow-directive.ts'),
    },
  ),
  required(
    'src/machine/validation-evidence.ts',
    'Validation evidence authority',
    ['src/machine/validation-evidence.test.ts'],
    {
      source: [SOURCE.machine],
      admission: admissionRecord('src/machine/validation-evidence.ts'),
    },
  ),
  required(
    'src/rails/architecture.ts',
    'Architecture rail executor',
    ['src/rails/architecture.test.ts'],
    {
      admission: admissionRecord('src/rails/architecture.ts'),
    },
  ),
  required('src/rails/hydrate.ts', 'Hydrate rail executor', ['src/rails/hydrate.test.ts'], {
    legacy: true,
  }),
  required(
    'src/rails/plan-review-evidence.ts',
    'Plan review evidence projection',
    ['src/rails/plan-review-evidence.test.ts'],
    {
      admission: admissionRecord('src/rails/plan-review-evidence.ts'),
    },
  ),
  required(
    'src/rails/review-decision.ts',
    'Review decision rail authority',
    ['src/rails/review-decision.test.ts'],
    {
      admission: admissionRecord('src/rails/review-decision.ts'),
    },
  ),
  required(
    'src/rails/review-decision-gates.ts',
    'Review decision gate evaluation',
    ['src/rails/review-decision.test.ts'],
    {
      admission: admissionRecord('src/rails/review-decision-gates.ts'),
    },
  ),
  required(
    'src/rails/review-evidence-resolution.ts',
    'Review evidence resolution',
    ['src/rails/review-evidence-resolution.test.ts'],
    {
      admission: admissionRecord('src/rails/review-evidence-resolution.ts'),
    },
  ),
  required('src/rails/review.ts', 'Review rail executor', ['src/rails/review.test.ts'], {
    legacy: true,
  }),
  required(
    'src/rails/review-url.ts',
    'URL review transport boundary',
    ['src/rails/review-url-security.test.ts'],
    {
      admission: admissionRecord('src/rails/review-url.ts'),
    },
  ),
  required('src/rails/ticket.ts', 'Ticket rail executor', ['src/rails/ticket.test.ts'], {
    admission: admissionRecord('src/rails/ticket.ts'),
  }),
  required(
    'src/hooks/shared/obligation-tracker.ts',
    'Review obligation tracking',
    ['src/hooks/shared/obligation-tracker.test.ts'],
    {
      admission: admissionRecord('src/hooks/shared/obligation-tracker.ts'),
    },
  ),
  required(
    'src/hooks/shared/phase-gate.ts',
    'Phase gate hook enforcement',
    ['src/hooks/shared/phase-gate.test.ts'],
    {
      admission: admissionRecord('src/hooks/shared/phase-gate.ts'),
    },
  ),

  // ── Event-core profile: required ──────────────────────────────────────────
  required(
    'src/audit/event-core.ts',
    'Audit event schema, chain hash and finalization',
    [
      'src/audit/audit-integrity.test.ts',
      'src/audit/audit-integrity-timestamps.test.ts',
      'src/audit/audit-types.test.ts',
    ],
    {
      profile: 'event-core',
      source: [SOURCE.trustBoundaries],
      admission: admissionRecord('src/audit/event-core.ts'),
    },
  ),

  // ── Human-projection profile: required ────────────────────────────────────
  required(
    'src/presentation/reason-projection.ts',
    'Reason projection authority',
    ['src/presentation/reason-projection.test.ts'],
    {
      profile: 'human-projection',
      admission: admissionRecord('src/presentation/reason-projection.ts'),
    },
  ),
  required(
    'src/presentation/claim-resolution.ts',
    'Claim resolution projection',
    ['src/presentation/claim-resolution.test.ts'],
    {
      profile: 'human-projection',
      admission: admissionRecord('src/presentation/claim-resolution.ts'),
    },
  ),
  required(
    'src/presentation/human-verification.ts',
    'Human verification projection',
    ['src/presentation/human-verification.test.ts'],
    {
      profile: 'human-projection',
      admission: admissionRecord('src/presentation/human-verification.ts'),
    },
  ),
  required(
    'src/presentation/claim-human-projection.ts',
    'Claim human projection',
    ['src/presentation/claim-human-projection.test.ts'],
    {
      profile: 'human-projection',
      admission: admissionRecord('src/presentation/claim-human-projection.ts'),
    },
  ),
  required(
    'src/presentation/proof-requirement-copy.ts',
    'Proof requirement copy',
    ['src/integration/proofgraph/proof-summary-projectors.test.ts'],
    {
      profile: 'human-projection',
      admission: admissionRecord('src/presentation/proof-requirement-copy.ts'),
    },
  ),
  required(
    'src/presentation/markdown.ts',
    'Markdown review rendering range',
    ['src/presentation/markdown.test.ts'],
    { legacy: true, profile: 'human-projection', selector: 'src/presentation/markdown.ts:264-292' },
  ),

  // ── Identity-JWKS profile: required range targets ─────────────────────────
  required(
    'src/identity/key-resolver.ts',
    'JWKS redirect policy range',
    ['src/identity/key-resolver.test.ts'],
    {
      profile: 'identity-jwks',
      selector: 'src/identity/key-resolver.ts:270-277',
      admission: admissionRecord('src/identity/key-resolver.ts:270-277'),
    },
  ),
  required(
    'src/identity/key-resolver.ts',
    'JWKS response-size policy range',
    ['src/identity/key-resolver.test.ts'],
    {
      profile: 'identity-jwks',
      selector: 'src/identity/key-resolver.ts:328-334',
      admission: admissionRecord('src/identity/key-resolver.ts:328-334'),
    },
  ),
  required(
    'src/identity/key-resolver.ts',
    'JWKS transport policy range',
    ['src/identity/key-resolver.test.ts'],
    {
      profile: 'identity-jwks',
      selector: 'src/identity/key-resolver.ts:338-350',
      admission: admissionRecord('src/identity/key-resolver.ts:338-350'),
    },
  ),

  // ── Mandates profile: required ────────────────────────────────────────────
  required(
    'src/templates/mandates.ts',
    'Installed mandate authority (mandates regime)',
    ['src/templates/mandates-contract-mutation.test.ts'],
    {
      source: [SOURCE.productMandates],
      profile: 'mandates',
      admission: admissionRecord('src/templates/mandates.ts'),
    },
  ),
  required(
    'src/templates/commands/plan.ts',
    'Plan command mandate template',
    ['src/templates/commands/discovery-review-parity.test.ts'],
    {
      source: [SOURCE.productMandates],
      profile: 'mandates',
      admission: admissionRecord('src/templates/commands/plan.ts'),
    },
  ),
  required(
    'src/templates/commands/implement.ts',
    'Implement command mandate template',
    ['src/templates/commands/discovery-review-parity.test.ts'],
    {
      source: [SOURCE.productMandates],
      profile: 'mandates',
      admission: admissionRecord('src/templates/commands/implement.ts'),
    },
  ),

  // ── Base profile: candidate authorities pending admission ─────────────────
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/integration/plugin-mutation-episodes.ts',
    target: 'src/integration/plugin-mutation-episodes.ts',
    authority: 'In-process mutation episode tracking',
    source: [SOURCE.trustBoundaries],
    coveringSuites: ['src/integration/plugin-mutation-episodes.test.ts'],
    admission: admissionRecord('src/integration/plugin-mutation-episodes.ts'),
  },
  required(
    'src/integration/review/evidence/reviewed-digest.ts',
    'Review provenance projection',
    ['src/integration/review/evidence/reviewed-digest.test.ts'],
    {
      source: [SOURCE.trustBoundaries],
      admission: admissionRecord('src/integration/review/evidence/reviewed-digest.ts'),
    },
  ),
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/audit/proofgraph/mutation-binder.ts',
    target: 'src/audit/proofgraph/mutation-binder.ts',
    authority: 'Mutation evidence binding',
    source: [SOURCE.trustBoundaries],
    coveringSuites: ['src/audit/proofgraph/mutation-binder.test.ts'],
    admission: admissionRecord('src/audit/proofgraph/mutation-binder.ts'),
  },
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/audit/proofgraph/mutation-report.ts',
    target: 'src/audit/proofgraph/mutation-report.ts',
    authority: 'Mutation report ingestion authority',
    source: [SOURCE.trustBoundaries],
    coveringSuites: [
      'src/audit/proofgraph/mutation-report.test.ts',
      'src/integration/proofgraph/materialize-contract.test.ts',
      'src/integration/proofgraph/mutation-verification.test.ts',
    ],
    admission: admissionRecord('src/audit/proofgraph/mutation-report.ts'),
  },
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/config/policy-central.ts',
    target: 'src/config/policy-central.ts',
    authority: 'Central policy bundle resolution',
    source: [SOURCE.config],
    coveringSuites: ['src/config/policy-central.test.ts', 'src/config/policy-presets.test.ts'],
    admission: admissionRecord('src/config/policy-central.ts'),
  },
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/config/policy-resolver.ts',
    target: 'src/config/policy-resolver.ts',
    authority: 'Policy resolution authority',
    source: [SOURCE.config],
    coveringSuites: ['src/config/policy-degradation-regression.test.ts'],
    admission: admissionRecord('src/config/policy-resolver.ts'),
  },
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/adapters/persistence-config.ts',
    target: 'src/adapters/persistence-config.ts',
    authority: 'Config persistence boundary',
    source: [SOURCE.trustBoundaries],
    coveringSuites: ['src/config/flowguard-config-io.test.ts', 'src/integration/plugin.test.ts'],
    admission: admissionRecord('src/adapters/persistence-config.ts'),
  },
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/adapters/persistence-core.ts',
    target: 'src/adapters/persistence-core.ts',
    authority: 'Shared persistence primitives',
    source: [SOURCE.trustBoundaries],
    coveringSuites: [
      'src/adapters/adapters-atomic-write.test.ts',
      'src/adapters/adapters-persistence-basics.test.ts',
      'src/adapters/persistence-more.test.ts',
    ],
    admission: admissionRecord('src/adapters/persistence-core.ts'),
  },
  required(
    'src/integration/tools/mutation/record-mutation-evidence.ts',
    'Canonical MutationAttempt evidence producer',
    ['src/integration/tools/record-mutation-evidence.test.ts'],
    {
      admission: admissionRecord('src/integration/tools/mutation/record-mutation-evidence.ts'),
    },
  ),
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/mcp-server/server.ts',
    target: 'src/mcp-server/server.ts',
    authority: 'MCP tool registry authority',
    source: [SOURCE.trustBoundaries],
    coveringSuites: ['src/mcp-server/server-registry.test.ts', 'src/mcp-server/mcp-server.test.ts'],
    admission: admissionRecord('src/mcp-server/server.ts'),
  },
  required(
    'src/integration/tools/mutation/reconcile-mutation-episode.ts',
    'Unknown-outcome mutation episode resolution',
    ['src/integration/mutation-episode-e2e.test.ts'],
    {
      admission: admissionRecord('src/integration/tools/mutation/reconcile-mutation-episode.ts'),
    },
  ),
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/hooks/post-tool-use.ts',
    target: 'src/hooks/post-tool-use.ts',
    authority: 'PostToolUse audit hook (informational)',
    source: [SOURCE.trustBoundaries],
    coveringSuites: ['src/hooks/post-tool-use.test.ts'],
    admission: admissionRecord('src/hooks/post-tool-use.ts'),
  },
  required(
    'src/integration/review/findings-hash.ts',
    'Findings hash normalization',
    ['src/integration/review/findings-hash.test.ts'],
    {
      source: [SOURCE.trustBoundaries],
      admission: admissionRecord('src/integration/review/findings-hash.ts'),
    },
  ),
  // ── Base profile: core authorities admitted in the base full run ─────────
  required(
    'src/adapters/implementation-base-authority.ts',
    'Pre-mutation implementation base freeze',
    ['src/adapters/implementation-base-authority.test.ts'],
    {
      source: [SOURCE.trustBoundaries],
      admission: admissionRecord('src/adapters/implementation-base-authority.ts'),
    },
  ),
  required(
    'src/adapters/implementation-entry-guard.ts',
    'Pure persistence-side implementation entry guard',
    ['src/adapters/implementation-base-authority.test.ts'],
    {
      source: [SOURCE.trustBoundaries],
      admission: admissionRecord('src/adapters/implementation-entry-guard.ts'),
    },
  ),

  // ── Base profile: measured admission verdicts (base full run 2026-09-17) ──
  deferred(
    'src/state/proofgraph-approval.ts',
    'ProofGraph claim identity, declarations, and approval certificates',
    'Targeted diagnostic 2026-09-17 on the claim-id SSOT branch (base config, mutate=src/state/proofgraph-approval.ts): 41.00% total / 58.57% covered (41 killed / 29 survived / 30 no-coverage / 74 TypeScript-checker errors). No-coverage sits in architecture-certificate verification and the certificate-invalid path of authorizedCriticalPlanClaimIds; survivors are dominated by schema-method and conditional mutants. Below the admission gate: stays backlog with the measured verdict recorded.',
    { profile: 'base', source: [SOURCE.trustBoundaries] },
  ),
  deferred(
    'src/adapters/git.ts',
    'Git subprocess boundary',
    'Measured 37.42% baseline and 57.06% after one focused behavior-test pass (91 killed / 60 survived / 10 uncovered, base profile 2026-09-17); below the admission gate, so it stays backlog with the measured post-pass verdict recorded in this tranche.',
    { source: [SOURCE.trustBoundaries] },
  ),
  deferred(
    'src/adapters/frozen-repository.ts',
    'Immutable frozen-repository acquisition boundary',
    'Measured 58.65% baseline and 70.37% after one focused acquisition-boundary pass (including a production fix so OVERSIZED_BLOB is no longer reclassified as ACQUISITION_FAILED); below the admission gate, so it stays backlog with the measured post-pass verdict recorded in this tranche.',
    { source: [SOURCE.trustBoundaries] },
  ),
  deferred(
    'src/audit/canonical-digest.ts',
    'TSA message imprint digest authority',
    'Measured 75.00% (3 killed / 1 survived) on a four-mutant set; the single residual mutant is semantically equivalent (digest formatting), so no further semantic test can raise this score. Too thin for an admission: stays backlog (equivalence-limited, thin evidence).',
  ),
  required(
    'src/config/flowguard-config.ts',
    'Runtime config schema authority',
    ['src/config/flowguard-config-schema.test.ts', 'src/config/flowguard-config-io.test.ts'],
    {
      profile: 'schemas',
      source: [SOURCE.config],
      admission: admissionRecord('src/config/flowguard-config.ts'),
    },
  ),
  deferred(
    'src/state/schema.ts',
    'Session state schema validated on every write',
    'Schemas-profile verdict 77.78% (21 killed / 5 survived / 1 uncovered) after the invariant tests; the residual is the peer-review lifecycle fixture (invariant branches around lines 705-726) plus one uncovered branch, so it stays backlog under the schemas profile.',
    { profile: 'schemas', source: [SOURCE.rootAgents] },
  ),
  required('src/shared/hashing.ts', 'Hash primitives for digests', ['src/shared/hashing.test.ts'], {
    source: [SOURCE.rootAgents],
    admission: admissionRecord('src/shared/hashing.ts'),
  }),
  deferred(
    'src/redaction/export-redaction.ts',
    'Export-time redaction boundary',
    'Measured 63.86% (53 killed / 30 survived) after the masking and traversal-guard contracts; the residual survivors sit at the semantic-equivalence ceiling for these string/regex operators, so it stays backlog (measured equivalence-limited).',
    { source: [SOURCE.trustBoundaries] },
  ),
  deferred(
    'src/audit/constant-time.ts',
    'Constant-time byte comparison',
    'Diagnostic run 2026-09-17 scored 66.67% with all six survivors semantically equivalent: the length XOR already short-circuits false on differing lengths, and out-of-bounds Uint8Array reads coerce to 0 through ToInt32. No further semantic tests can kill them; the module stays backlog until a mutation regime with finer operators exists.',
  ),
  deferred(
    'src/mcp-server/schema-converter.ts',
    'Strict MCP input schema conversion',
    'Diagnostic run 2026-09-17 scored 100.00% (1 killed / 0 survived) on a single valid mutant; mutant density is insufficient to carry an authority admission. A broader or dedicated mutation regime is required before admission.',
    {
      source: [SOURCE.trustBoundaries],
    },
  ),
  // ── Reason catalog: no valid mutants under the base regime (diagnostic 2026-09-17)
  notSuitable(
    'src/config/reasons-architecture.ts',
    'Reason catalog: architecture',
    'Base-regime diagnostic: every mutant is rejected by the TypeScript checker (175 CompileError across the catalog, 0 valid).',
    'base',
    { source: [SOURCE.config] },
  ),
  notSuitable(
    'src/config/reasons-envelope.ts',
    'Reason catalog: reason envelope',
    'Base-regime diagnostic: every mutant is rejected by the TypeScript checker (175 CompileError across the catalog, 0 valid).',
    'base',
    { source: [SOURCE.config] },
  ),
  notSuitable(
    'src/config/reasons-infra.ts',
    'Reason catalog: infrastructure',
    'Base-regime diagnostic: every mutant is rejected by the TypeScript checker (175 CompileError across the catalog, 0 valid).',
    'base',
    { source: [SOURCE.config] },
  ),
  notSuitable(
    'src/config/reasons-mutation.ts',
    'Reason catalog: mutation episodes',
    'Base-regime diagnostic: every mutant is rejected by the TypeScript checker (175 CompileError across the catalog, 0 valid).',
    'base',
    { source: [SOURCE.config] },
  ),
  notSuitable(
    'src/config/reasons-precondition.ts',
    'Reason catalog: preconditions',
    'Base-regime diagnostic: every mutant is rejected by the TypeScript checker (175 CompileError across the catalog, 0 valid).',
    'base',
    { source: [SOURCE.config] },
  ),
  notSuitable(
    'src/config/reasons-proofgraph.ts',
    'Reason catalog: proof graph',
    'Base-regime diagnostic: every mutant is rejected by the TypeScript checker (175 CompileError across the catalog, 0 valid).',
    'base',
    { source: [SOURCE.config] },
  ),
  notSuitable(
    'src/config/reasons-validation.ts',
    'Reason catalog: validation',
    'Base-regime diagnostic: every mutant is rejected by the TypeScript checker (175 CompileError across the catalog, 0 valid).',
    'base',
    { source: [SOURCE.config] },
  ),
  notSuitable(
    'src/config/reasons-validation-observation.ts',
    'Reason catalog: validation observation',
    'Base-regime diagnostic: every mutant is rejected by the TypeScript checker (175 CompileError across the catalog, 0 valid).',
    'base',
    { source: [SOURCE.config] },
  ),
  notSuitable(
    'src/config/reasons-validation-review.ts',
    'Reason catalog: review validation',
    'Base-regime diagnostic: every mutant is rejected by the TypeScript checker (175 CompileError across the catalog, 0 valid).',
    'base',
    { source: [SOURCE.config] },
  ),
  notSuitable(
    'src/config/reasons-validation-structured.ts',
    'Reason catalog: structured validation',
    'Base-regime diagnostic: every mutant is rejected by the TypeScript checker (175 CompileError across the catalog, 0 valid).',
    'base',
    { source: [SOURCE.config] },
  ),
  deferred(
    'src/rendering/mandates-renderer.ts',
    'Mandate rendering projection',
    'Focused renderer contract pass 2026-09-17 reached 72.40% (160 killed / 54 survived / 7 uncovered); below the per-target gate, so it returns to the backlog and out of the runtime closure PR. A dedicated mandates hardening pass is required before admission.',
    {
      profile: 'mandates',
      source: [SOURCE.productMandates],
    },
  ),

  // ── Evidence-layer candidates with diagnostic evidence ────────────────────
  deferred(
    'src/state/evidence-validation.ts',
    'Evidence validation contracts',
    'Diagnostic run 2026-09-17 scored 18.68% (17 killed / 74 survived); test gaps must be closed before admission.',
    { source: [SOURCE.trustBoundaries] },
  ),
  deferred(
    'src/integration/review/shared-helpers.ts',
    'Review helper authority',
    'Diagnostic run 2026-09-17 scored 68.66% (46 killed / 21 survived); test gaps must be closed before admission.',
    { source: [SOURCE.trustBoundaries] },
  ),
  deferred(
    'src/integration/tools/validation/run-check-result.ts',
    'Check result projection',
    'Diagnostic run 2026-09-17 scored 0.00% (0 killed / 66 survived); test gaps must be closed before admission.',
    { source: [SOURCE.trustBoundaries] },
  ),

  // ── Deep authority expansion bundle ───────────────────────────────────────
  deferred(
    'src/config/policy-ci.ts',
    'CI policy resolution',
    'Diagnostic run 2026-09-17 scored 100.00% (5 killed / 0 survived) on only five valid mutants and has no direct suite; mutant density is too low to carry an authority admission.',
    {
      source: [SOURCE.config],
    },
  ),
  deferred(
    'src/config/policy-types.ts',
    'Policy type authority',
    'Diagnostic run 2026-09-17 scored 20.00% (1 killed / 4 survived) on five valid mutants; the existing evidence is too weak for admission and needs dedicated policy contract tests.',
    {
      source: [SOURCE.config],
    },
  ),

  // ── Explicitly not mutation-suitable ──────────────────────────────────────
  notSuitable(
    'src/presentation/reason-copy.ts',
    'Human reason copy authority',
    'Human-projection full run 2026-09-19: every mutant is rejected by the TypeScript checker (0 valid mutants); static copy has no mutatable semantic contract.',
    'human-projection',
    { source: [SOURCE.scope] },
  ),
  notSuitable(
    'src/presentation/human-projection.ts',
    'Human projection composition',
    'Human-projection full run 2026-09-19: every mutant is rejected by the TypeScript checker (0 valid mutants); the composition surface is type-driven.',
    'human-projection',
    { source: [SOURCE.scope] },
  ),
  notSuitable(
    'src/presentation/claim-diagnostic-copy.ts',
    'Claim diagnostic copy',
    'Human-projection full run 2026-09-19: no valid mutants in the profile regime (static diagnostic copy).',
    'human-projection',
    { source: [SOURCE.scope] },
  ),
  notSuitable(
    'src/config/profile-types.ts',
    'Profile type authority',
    'Type-only module (PhaseInstructions interface); the base full run produced no valid mutants.',
    'base',
    { source: [SOURCE.config] },
  ),
  required(
    'src/machine/topology.ts',
    'Formal state transition table',
    [
      'src/machine/topology.test.ts',
      'src/machine/state-machine.fuzz.test.ts',
      'src/machine/state-machine-invariants.test.ts',
      'src/architecture/__tests__/topology-authority-ssot.test.ts',
    ],
    {
      profile: 'topology',
      source: [SOURCE.machine],
      admission: admissionRecord('src/machine/topology.ts'),
    },
  ),
  notSuitable(
    'src/machine/topology.ts',
    'Formal state transition table',
    'No valid mutants in the base full run: the transition table is module-init data ignored under ignoreStatic.',
    'base',
    { source: [SOURCE.machine] },
  ),
  notSuitable(
    'src/state/policy-mode.ts',
    'Canonical policy mode enum',
    'No valid mutants in the base full run: const tuple/enum only.',
    'base',
    { source: [SOURCE.rootAgents] },
  ),
  notSuitable(
    'src/state/runtime-lease.ts',
    'Persisted runtime lease fencing shape',
    'No valid mutants in the base full run: pure Zod schema declarations.',
    'base',
    { source: [SOURCE.trustBoundaries] },
  ),
  notSuitable(
    'src/config/reasons-types.ts',
    'Reason catalog type contracts',
    'Type-only module; no runtime mutants exist in the base regime.',
    'base',
    { source: [SOURCE.config] },
  ),
  notSuitable(
    'src/machine/command-help.ts',
    'Command help text projection',
    'Static help text projection; no semantic contract to mutate in the base regime.',
    'base',
    { source: [SOURCE.machine] },
  ),

  // ── Deferred surfaces (whole roots behind the admission gate) ─────────────
  deferredGlob('src/config', 'Config surface beyond the canonical authorities', DEFERRED_REASON, [
    SOURCE.config,
  ]),
  deferredGlob('src/state', 'Evidence layer and remaining state contracts', DEFERRED_REASON, [
    SOURCE.trustBoundaries,
  ]),
  deferredGlob('src/shared', 'Shared helpers beyond canonical serialization', DEFERRED_REASON, [
    SOURCE.rootAgents,
  ]),
  deferredGlob(
    'src/audit',
    'Audit surface beyond the integrity and timestamp authorities',
    DEFERRED_REASON,
    [SOURCE.trustBoundaries],
  ),
  deferredGlob(
    'src/adapters',
    'Adapter surface beyond the persistence and workspace authorities',
    DEFERRED_REASON,
    [SOURCE.trustBoundaries],
  ),
  deferredGlob(
    'src/identity',
    'Identity surface beyond token and key verification',
    DEFERRED_REASON,
    [SOURCE.trustBoundaries],
  ),
  deferredGlob(
    'src/verification',
    'Verification surface beyond the execution subject',
    DEFERRED_REASON,
    [SOURCE.trustBoundaries],
  ),
  deferredGlob(
    'src/discovery',
    'Discovery surface beyond the verification planner',
    DEFERRED_REASON,
    [SOURCE.trustBoundaries],
  ),
  deferredGlob('src/logging', 'Logging surface beyond error serialization', DEFERRED_REASON, [
    SOURCE.trustBoundaries,
  ]),
  deferredGlob('src/hooks', 'Hook surface beyond the enforcement hooks', DEFERRED_REASON, [
    SOURCE.trustBoundaries,
  ]),
  deferredGlob(
    'src/mcp-server',
    'MCP surface beyond the tool adaptation authorities',
    DEFERRED_REASON,
    [SOURCE.trustBoundaries],
  ),
  deferredGlob(
    'src/templates',
    'Command templates beyond mandates and plan/implement',
    DEFERRED_REASON,
    [SOURCE.productMandates],
  ),
  deferredGlob(
    'src/presentation',
    'Presentation surface beyond the human projection authorities',
    DEFERRED_REASON,
    [SOURCE.trustBoundaries],
  ),
  deferredGlob(
    'src/integration',
    'Integration surface beyond the required composition and review authorities',
    DEFERRED_REASON,
    [SOURCE.integration],
  ),
];

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
