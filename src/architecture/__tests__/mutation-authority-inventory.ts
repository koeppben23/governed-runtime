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
 *   per-target threshold.
 * - Targets that predate this inventory carry `legacyBaseline` instead of a
 *   reconstructed per-file score. Backfilling invented numbers is forbidden.
 *
 * Glob entries (`root` + `pattern`) defer whole surfaces. They are expanded by
 * the guard; files that carry an exact entry are masked out, and the remaining
 * effective set must be non-empty and disjoint from every mutate list.
 *
 * Admission policy: a targeted run is diagnostic only. Admission evidence is
 * the profile full run. The profile-wide aggregate must meet the break
 * threshold; targets named via `--require-selectors` (new admissions) must
 * additionally meet the per-target break threshold. Legacy targets below the
 * per-target threshold are reported as a diagnostic note and remain tracked
 * for test hardening; range selectors are scored only over mutants inside the
 * declared range, and every mutant of a range-profile file must map to a
 * configured range.
 */

export type MutationProfile = 'base' | 'human-projection' | 'identity-jwks' | 'mandates';

export type MutationAuthorityClass = 'required' | 'admission-backlog' | 'not-mutation-suitable';

export interface MutationProfileDefinition {
  readonly configFile: string;
  readonly vitestConfigFile: string;
}

export const MUTATION_PROFILES: Readonly<Record<MutationProfile, MutationProfileDefinition>> = {
  base: {
    configFile: 'stryker.conf.json',
    vitestConfigFile: 'vitest.stryker.config.ts',
  },
  'human-projection': {
    configFile: 'stryker.human-projection.conf.json',
    vitestConfigFile: 'vitest.stryker-human-projection.config.ts',
  },
  'identity-jwks': {
    configFile: 'stryker.identity-jwks.conf.json',
    vitestConfigFile: 'vitest.stryker-identity-jwks.config.ts',
  },
  mandates: {
    configFile: 'stryker.mandates.conf.json',
    vitestConfigFile: 'vitest.mandates.config.ts',
  },
};

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
  } = {},
): RequiredAuthorityEntry {
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
    authority: 'Canonical serialization and digest primitives',
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
  required('src/adapters/persistence-lock.ts', 'Inter-process write lock for persisted state', [
    'src/adapters/__tests__/persistence-lock.test.ts',
  ]),
  required('src/adapters/host-adapter.ts', 'Host runtime adapter boundary', [
    'src/adapters/host-adapter.test.ts',
  ]),
  required('src/adapters/persistence.ts', 'Durable session state persistence', [
    'src/adapters/adapters-atomic-write.test.ts',
    'src/adapters/adapters-persistence-basics.test.ts',
  ]),
  required('src/adapters/persistence-audit.ts', 'Durable audit JSONL trail adapter', [
    'src/adapters/adapters-schema-audit.test.ts',
    'src/adapters/workspace-archive.test.ts',
  ]),
  required('src/adapters/ip-validation.ts', 'SSRF and private-IP guard for outbound URLs', [
    'src/adapters/ip-validation.test.ts',
  ]),
  required('src/mcp-server/execution-limiter.ts', 'MCP tool execution rate limiting', [
    'src/mcp-server/mcp-server.test.ts',
  ]),
  required('src/mcp-server/session-resolver.ts', 'Host session resolution for MCP and hooks', [
    'src/mcp-server/mcp-server.test.ts',
    'src/hooks/http-server.test.ts',
  ]),
  required('src/mcp-server/tool-adapter.ts', 'MCP tool registration and argument adaptation', [
    'src/mcp-server/mcp-server.test.ts',
  ]),
  required('src/archive/content-digest.ts', 'Archive content digest computation', [
    'src/archive/content-digest.test.ts',
  ]),
  required(
    'src/audit/completeness.ts',
    'Audit event completeness classification',
    ['src/audit/audit-completeness.test.ts'],
    { critical: true },
  ),
  required(
    'src/audit/integrity.ts',
    'Audit hash-chain integrity verification',
    ['src/audit/audit-integrity.test.ts'],
    { critical: true },
  ),
  required('src/audit/types.ts', 'Audit event schema authority', [
    'src/audit/audit-integrity.test.ts',
  ]),
  required('src/audit/ntp-check.ts', 'NTP clock-skew check for TSA evidence', [
    'src/audit/ntp-check.test.ts',
  ]),
  required('src/audit/rfc-3161-pkijs-verifier.ts', 'RFC 3161 timestamp token verification', [
    'src/audit/rfc3161-pkijs-verifier.test.ts',
  ]),
  required('src/audit/timestamp-verification.ts', 'Timestamp evidence verification', [
    'src/audit/timestamp-verification.test.ts',
  ]),
  required(
    'src/audit/timestamp-token-verification.ts',
    'Canonical TSA token imprint verification',
    ['src/audit/rfc3161-pkijs-verifier.test.ts'],
  ),
  required('src/adapters/workspace/archive.ts', 'Archive creation authority', [
    'src/adapters/workspace-archive.test.ts',
  ]),
  required('src/adapters/workspace/archive-publish.ts', 'Archive publication boundary', [
    'src/adapters/workspace/archive-publish.test.ts',
  ]),
  required('src/adapters/workspace/archive-tar.ts', 'Deterministic archive tar inspection', [
    'src/adapters/workspace/archive-tar.test.ts',
  ]),
  required('src/adapters/workspace/archive-timestamp-verification.ts', 'Archive TSA verification', [
    'src/adapters/workspace/archive-timestamp-verification.test.ts',
  ]),
  required('src/adapters/workspace/archive-verify-manifest.ts', 'Archive manifest verification', [
    'src/adapters/workspace/archive-verify-manifest.test.ts',
  ]),
  required('src/adapters/workspace/archive-verify-chain.ts', 'Archive verification verdict chain', [
    'src/adapters/workspace/archive-verify-chain.test.ts',
  ]),
  required('src/adapters/workspace/archive-verify-helpers.ts', 'Archive verification helpers', [
    'src/adapters/workspace/archive-verify-helpers.test.ts',
  ]),
  required('src/audit/proofgraph/evaluate.ts', 'ProofGraph evaluation authority', [
    'src/audit/proofgraph/evaluate.test.ts',
  ]),
  required('src/audit/proofgraph/gate.ts', 'ProofGraph gate decision', [
    'src/audit/proofgraph/gate.test.ts',
  ]),
  required('src/integration/proofgraph/claim-contract.ts', 'Proof claim contract materialization', [
    'src/integration/proofgraph/claim-contract.test.ts',
  ]),
  required(
    'src/integration/proofgraph/materialize-contract.ts',
    'Proof contract evidence binding',
    ['src/integration/proofgraph/materialize-contract.test.ts'],
  ),
  required('src/audit/proofgraph/executed-test-binder.ts', 'Executed-test evidence binding', [
    'src/audit/proofgraph/executed-test-binder.test.ts',
  ]),
  required('src/audit/proofgraph/counterexample-binder.ts', 'Counterexample evidence binding', [
    'src/audit/proofgraph/counterexample-binder.test.ts',
  ]),
  required('src/audit/proofgraph/assertion-evidence-binding.ts', 'Assertion evidence binding', [
    'src/audit/proofgraph/assertion-evidence-binding.test.ts',
  ]),
  required('src/audit/proofgraph/enforcement-projection.ts', 'Enforcement evidence projection', [
    'src/audit/proofgraph/enforcement-projection.test.ts',
  ]),
  required('src/verification/execution-subject.ts', 'Observed execution subject binding', [
    'src/verification/execution-subject.test.ts',
  ]),
  required('src/discovery/verification-planner.ts', 'Verification candidate planning', [
    'src/discovery/verification-planner.test.ts',
  ]),
  required(
    'src/config/policy.ts',
    'Policy validation authority',
    ['src/config/policy-snapshot.test.ts'],
    { critical: true },
  ),
  required(
    'src/config/policy-snapshot.ts',
    'Policy snapshot capture and validation',
    ['src/config/policy-snapshot.test.ts'],
    { critical: true },
  ),
  required(
    'src/config/reasons.ts',
    'Reason registry and message interpolation',
    ['src/config/reasons-completeness.test.ts'],
    { critical: true },
  ),
  required('src/config/profile.ts', 'Built-in profile registry', [
    'src/config/profile-core.test.ts',
  ]),
  required('src/hooks/http-server.ts', 'Local hook HTTP server boundary', [
    'src/hooks/http-server.test.ts',
  ]),
  required('src/hooks/pre-tool-use.ts', 'PreToolUse enforcement hook', [
    'src/hooks/pre-tool-use.test.ts',
  ]),
  required(
    'src/identity/token-verifier.ts',
    'IdP token verification',
    ['src/identity/token-verifier.test.ts'],
    { critical: true },
  ),
  required(
    'src/identity/key-resolver.ts',
    'JWKS key resolution',
    ['src/identity/key-resolver.test.ts'],
    { critical: true },
  ),
  required('src/integration/installed-commands.ts', 'Installed command registry', [
    'src/integration/installed-commands.test.ts',
  ]),
  required('src/integration/tool-classification.ts', 'Tool risk classification', [
    'src/integration/tool-classification.test.ts',
  ]),
  required('src/integration/discovery-risk-paths.ts', 'Discovery risk path classification', [
    'src/integration/discovery-risk-paths.test.ts',
  ]),
  required(
    'src/integration/tools/pre-implementation-challenge.ts',
    'Pre-implementation challenge policy',
    ['src/integration/tools/pre-implementation-challenge.test.ts'],
  ),
  required('src/integration/tools/architecture-submit.ts', 'Architecture evidence submission', [
    'src/integration/tools/architecture-tool.test.ts',
  ]),
  required(
    'src/integration/tools/review-validation-mode.ts',
    'Multi-mode review validation',
    ['src/integration/tools/review-validation-mode.test.ts'],
    { critical: true },
  ),
  required('src/integration/tools/review-validation.ts', 'Review validation aggregation', [
    'src/integration/tools/review-validation-findings.test.ts',
  ]),
  required(
    'src/integration/tools/review-validation-structured-evidence.ts',
    'Structured review validation evidence',
    [
      'src/integration/review/challenge-policy-evaluation.test.ts',
      'src/integration/tools/review-validation-findings.test.ts',
    ],
  ),
  required(
    'src/integration/plugin-audit-lifecycle-reason.ts',
    'Audit lifecycle reason mapping',
    ['src/integration/plugin-audit-lifecycle-reason.test.ts'],
    { critical: true },
  ),
  required('src/integration/plugin-audit.ts', 'In-process audit lifecycle authority', [
    'src/integration/plugin-audit.test.ts',
  ]),
  required('src/integration/plugin-audit-reconcile.ts', 'Durable audit reconciliation authority', [
    'src/integration/plugin-audit.test.ts',
    'src/integration/plugin-audit-reconcile.test.ts',
  ]),
  required('src/integration/plugin-beforehooks.ts', 'Host before-hook enforcement', [
    'src/integration/plugin-beforehooks.test.ts',
  ]),
  required('src/integration/plugin-afterhooks.ts', 'Host after-hook enforcement tracking', [
    'src/integration/plugin-afterhooks-more.test.ts',
  ]),
  required('src/integration/plugin-helpers.ts', 'Plugin shared helpers', [
    'src/integration/plugin-helpers.test.ts',
  ]),
  required('src/integration/plugin-workspace.ts', 'Workspace composition boundary', [
    'src/integration/plugin-workspace.test.ts',
  ]),
  required('src/integration/plugin.ts', 'Plugin composition root', [
    'src/integration/plugin.test.ts',
  ]),
  required('src/integration/runtime-lease.ts', 'Runtime lease fencing authority', [
    'src/integration/runtime-lease.test.ts',
  ]),
  required('src/state/evidence-mutation-episode.ts', 'Host mutation episode invariants', [
    'src/state/evidence-mutation-episode.test.ts',
  ]),
  required(
    'src/integration/review/enforcement/challenge-binding.ts',
    'Review challenge evidence binding',
    ['src/integration/review/enforcement/challenge-binding.test.ts'],
  ),
  required('src/integration/tools/audit-outbox.ts', 'Audit outbox durable delivery', [
    'src/integration/tools/audit-outbox.test.ts',
  ]),
  required(
    'src/templates/codex-plugin.ts',
    'Codex host plugin template',
    ['src/templates/codex-plugin.test.ts'],
    { critical: true, source: [SOURCE.productMandates] },
  ),
  required(
    'src/templates/claude-code-plugin.ts',
    'Claude Code host plugin template',
    ['src/templates/claude-code-plugin.test.ts'],
    { critical: true, source: [SOURCE.productMandates] },
  ),
  required('src/integration/review/enforcement/enforcement.ts', 'Review enforcement layers', [
    'src/integration/review/enforcement/enforce-before-verdict.test.ts',
    'src/integration/review/enforcement/retry-signal.test.ts',
  ]),
  required(
    'src/integration/review/enforcement/findings-consistency.ts',
    'Findings consistency authority',
    ['src/integration/review/enforcement/findings-consistency.test.ts'],
  ),
  required(
    'src/integration/review/enforcement/challenge-consistency.ts',
    'Challenge consistency authority',
    ['src/integration/review/enforcement/challenge-consistency.test.ts'],
  ),
  required('src/integration/review/dispatch-signal.ts', 'Review dispatch signal detection', [
    'src/integration/review/dispatch-signal.test.ts',
  ]),
  required(
    'src/integration/review/agent-resolution.ts',
    'Reviewer agent resolution',
    ['src/integration/review/agent-resolution.test.ts'],
    { critical: true },
  ),
  required(
    'src/shared/canonical-json.ts',
    'Canonical JSON serialization authority',
    ['src/shared/canonical-json.test.ts'],
    { critical: true },
  ),
  required('src/logging/error-serialize.ts', 'Structured error serialization', [
    'src/logging/error-serialize.test.ts',
  ]),
  required('src/machine/commands.ts', 'Machine command surface', ['src/machine/commands.test.ts'], {
    source: [SOURCE.machine],
  }),
  required(
    'src/machine/evaluate.ts',
    'Deterministic state evaluation',
    ['src/machine/evaluate.test.ts'],
    { source: [SOURCE.machine] },
  ),
  required('src/machine/guards.ts', 'Guard evaluation ordering', ['src/machine/guards.test.ts'], {
    source: [SOURCE.machine],
  }),
  required(
    'src/machine/workflow-directive.ts',
    'Workflow directive authority',
    ['src/machine/workflow-directive.test.ts'],
    { source: [SOURCE.machine] },
  ),
  required(
    'src/machine/validation-evidence.ts',
    'Validation evidence authority',
    ['src/machine/validation-evidence.test.ts'],
    { source: [SOURCE.machine] },
  ),
  required('src/rails/architecture.ts', 'Architecture rail executor', [
    'src/rails/architecture.test.ts',
  ]),
  required('src/rails/hydrate.ts', 'Hydrate rail executor', ['src/rails/hydrate.test.ts']),
  required('src/rails/plan-review-evidence.ts', 'Plan review evidence projection', [
    'src/rails/plan-review-evidence.test.ts',
  ]),
  required('src/rails/review-decision.ts', 'Review decision rail authority', [
    'src/rails/review-decision.test.ts',
  ]),
  required('src/rails/review-evidence-resolution.ts', 'Review evidence resolution', [
    'src/rails/review-evidence-resolution.test.ts',
  ]),
  required('src/rails/review.ts', 'Review rail executor', ['src/rails/review.test.ts']),
  required('src/rails/review-url.ts', 'URL review transport boundary', [
    'src/rails/review-url-security.test.ts',
  ]),
  required('src/rails/ticket.ts', 'Ticket rail executor', ['src/rails/ticket.test.ts']),
  required('src/hooks/shared/obligation-tracker.ts', 'Review obligation tracking', [
    'src/hooks/shared/obligation-tracker.test.ts',
  ]),
  required('src/hooks/shared/phase-gate.ts', 'Phase gate hook enforcement', [
    'src/hooks/shared/phase-gate.test.ts',
  ]),

  // ── Human-projection profile: required ────────────────────────────────────
  required(
    'src/presentation/reason-copy.ts',
    'Human reason copy authority',
    ['src/presentation/reason-copy.test.ts'],
    { profile: 'human-projection' },
  ),
  required(
    'src/presentation/reason-projection.ts',
    'Reason projection authority',
    ['src/presentation/reason-projection.test.ts'],
    { profile: 'human-projection' },
  ),
  required(
    'src/presentation/human-projection.ts',
    'Human projection composition',
    ['src/presentation/claim-human-projection.test.ts'],
    { profile: 'human-projection' },
  ),
  required(
    'src/presentation/claim-resolution.ts',
    'Claim resolution projection',
    ['src/presentation/claim-resolution.test.ts'],
    { profile: 'human-projection' },
  ),
  required(
    'src/presentation/claim-diagnostic-copy.ts',
    'Claim diagnostic copy',
    ['src/presentation/claim-diagnostic-copy.test.ts'],
    { profile: 'human-projection' },
  ),
  required(
    'src/presentation/human-verification.ts',
    'Human verification projection',
    ['src/presentation/human-verification.test.ts'],
    { profile: 'human-projection' },
  ),
  required(
    'src/presentation/claim-human-projection.ts',
    'Claim human projection',
    ['src/presentation/claim-human-projection.test.ts'],
    { profile: 'human-projection' },
  ),
  required(
    'src/presentation/proof-requirement-copy.ts',
    'Proof requirement copy',
    ['src/integration/proofgraph/proof-summary-projectors.test.ts'],
    { profile: 'human-projection' },
  ),
  required(
    'src/presentation/markdown.ts',
    'Markdown review rendering range',
    ['src/presentation/markdown.test.ts'],
    { profile: 'human-projection', selector: 'src/presentation/markdown.ts:255-287' },
  ),

  // ── Identity-JWKS profile: required range targets ─────────────────────────
  required(
    'src/identity/key-resolver.ts',
    'JWKS redirect policy range',
    ['src/identity/key-resolver.test.ts'],
    {
      profile: 'identity-jwks',
      selector: 'src/identity/key-resolver.ts:270-277',
    },
  ),
  required(
    'src/identity/key-resolver.ts',
    'JWKS response-size policy range',
    ['src/identity/key-resolver.test.ts'],
    {
      profile: 'identity-jwks',
      selector: 'src/identity/key-resolver.ts:328-334',
    },
  ),
  required(
    'src/identity/key-resolver.ts',
    'JWKS transport policy range',
    ['src/identity/key-resolver.test.ts'],
    {
      profile: 'identity-jwks',
      selector: 'src/identity/key-resolver.ts:338-350',
    },
  ),

  // ── Mandates profile: required ────────────────────────────────────────────
  required(
    'src/templates/mandates.ts',
    'Installed mandate authority (mandates regime)',
    ['src/templates/mandates-contract-mutation.test.ts'],
    { profile: 'mandates', source: [SOURCE.productMandates] },
  ),
  required(
    'src/templates/commands/plan.ts',
    'Plan command mandate template',
    ['src/templates/commands/discovery-review-parity.test.ts'],
    { profile: 'mandates', source: [SOURCE.productMandates] },
  ),
  required(
    'src/templates/commands/implement.ts',
    'Implement command mandate template',
    ['src/templates/commands/discovery-review-parity.test.ts'],
    { profile: 'mandates', source: [SOURCE.productMandates] },
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
    admission: {
      verifiedAt: '2026-09-17',
      commitSha: '65b6b0126b5fb5fc77cd31701ac3e37f48356ccf',
      scoreAtAdmission: 85.85,
      killed: 91,
      survived: 15,
      config: 'stryker.conf.json',
    },
  },
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/integration/review/reviewed-digest.ts',
    target: 'src/integration/review/reviewed-digest.ts',
    authority: 'Review provenance projection',
    source: [SOURCE.trustBoundaries],
    coveringSuites: ['src/integration/review/reviewed-digest.test.ts'],
    admission: {
      verifiedAt: '2026-09-17',
      commitSha: '65b6b0126b5fb5fc77cd31701ac3e37f48356ccf',
      scoreAtAdmission: 93.33,
      killed: 84,
      survived: 6,
      config: 'stryker.conf.json',
    },
  },
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/audit/proofgraph/mutation-binder.ts',
    target: 'src/audit/proofgraph/mutation-binder.ts',
    authority: 'Mutation evidence binding',
    source: [SOURCE.trustBoundaries],
    coveringSuites: ['src/audit/proofgraph/mutation-binder.test.ts'],
    admission: {
      verifiedAt: '2026-09-17',
      commitSha: '072936538ad0920300aa000514a7accbd2bfbe6f',
      scoreAtAdmission: 100,
      killed: 16,
      survived: 0,
      config: 'stryker.conf.json',
    },
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
    admission: {
      verifiedAt: '2026-09-17',
      commitSha: '072936538ad0920300aa000514a7accbd2bfbe6f',
      scoreAtAdmission: 93.94,
      killed: 31,
      survived: 2,
      config: 'stryker.conf.json',
    },
  },
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/config/policy-central.ts',
    target: 'src/config/policy-central.ts',
    authority: 'Central policy bundle resolution',
    source: [SOURCE.config],
    coveringSuites: ['src/config/policy-central.test.ts', 'src/config/policy-presets.test.ts'],
    admission: {
      verifiedAt: '2026-09-17',
      commitSha: '072936538ad0920300aa000514a7accbd2bfbe6f',
      scoreAtAdmission: 88.06,
      killed: 59,
      survived: 8,
      config: 'stryker.conf.json',
    },
  },
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/config/policy-resolver.ts',
    target: 'src/config/policy-resolver.ts',
    authority: 'Policy resolution authority',
    source: [SOURCE.config],
    coveringSuites: ['src/config/policy-degradation-regression.test.ts'],
    admission: {
      verifiedAt: '2026-09-17',
      commitSha: '072936538ad0920300aa000514a7accbd2bfbe6f',
      scoreAtAdmission: 81.4,
      killed: 35,
      survived: 8,
      config: 'stryker.conf.json',
    },
  },
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/adapters/persistence-config.ts',
    target: 'src/adapters/persistence-config.ts',
    authority: 'Config persistence boundary',
    source: [SOURCE.trustBoundaries],
    coveringSuites: ['src/config/flowguard-config-io.test.ts', 'src/integration/plugin.test.ts'],
    admission: {
      verifiedAt: '2026-09-17',
      commitSha: '072936538ad0920300aa000514a7accbd2bfbe6f',
      scoreAtAdmission: 100,
      killed: 24,
      survived: 0,
      config: 'stryker.conf.json',
    },
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
    admission: {
      verifiedAt: '2026-09-17',
      commitSha: '072936538ad0920300aa000514a7accbd2bfbe6f',
      scoreAtAdmission: 100,
      killed: 9,
      survived: 0,
      config: 'stryker.conf.json',
    },
  },
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/integration/tools/record-mutation-evidence.ts',
    target: 'src/integration/tools/record-mutation-evidence.ts',
    authority: 'Canonical MutationAttempt evidence producer',
    source: [SOURCE.trustBoundaries],
    coveringSuites: ['src/integration/tools/record-mutation-evidence.test.ts'],
    admission: {
      verifiedAt: '2026-09-17',
      commitSha: 'cc713cb029ad1028793e6a7cdd67381efd33b88f',
      scoreAtAdmission: 81.25,
      killed: 13,
      survived: 3,
      config: 'stryker.conf.json',
    },
  },
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/mcp-server/server.ts',
    target: 'src/mcp-server/server.ts',
    authority: 'MCP tool registry authority',
    source: [SOURCE.trustBoundaries],
    coveringSuites: ['src/mcp-server/server-registry.test.ts', 'src/mcp-server/mcp-server.test.ts'],
    admission: {
      verifiedAt: '2026-09-17',
      commitSha: 'cc713cb029ad1028793e6a7cdd67381efd33b88f',
      scoreAtAdmission: 84.62,
      killed: 11,
      survived: 2,
      config: 'stryker.conf.json',
    },
  },
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/integration/tools/reconcile-mutation-episode.ts',
    target: 'src/integration/tools/reconcile-mutation-episode.ts',
    authority: 'Unknown-outcome mutation episode resolution',
    source: [SOURCE.trustBoundaries],
    coveringSuites: ['src/integration/mutation-episode-e2e.test.ts'],
    admission: {
      verifiedAt: '2026-09-17',
      commitSha: 'cc713cb029ad1028793e6a7cdd67381efd33b88f',
      scoreAtAdmission: 93.33,
      killed: 28,
      survived: 2,
      config: 'stryker.conf.json',
    },
  },
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/hooks/post-tool-use.ts',
    target: 'src/hooks/post-tool-use.ts',
    authority: 'PostToolUse audit hook (informational)',
    source: [SOURCE.trustBoundaries],
    coveringSuites: ['src/hooks/post-tool-use.test.ts'],
    admission: {
      verifiedAt: '2026-09-17',
      commitSha: 'cc713cb029ad1028793e6a7cdd67381efd33b88f',
      scoreAtAdmission: 100,
      killed: 27,
      survived: 0,
      config: 'stryker.conf.json',
    },
  },
  {
    classification: 'required',
    profile: 'base',
    mutateSelector: 'src/integration/review/findings-hash.ts',
    target: 'src/integration/review/findings-hash.ts',
    authority: 'Findings hash normalization',
    source: [SOURCE.trustBoundaries],
    coveringSuites: ['src/integration/review/findings-hash.test.ts'],
    admission: {
      verifiedAt: '2026-09-17',
      commitSha: 'cc713cb029ad1028793e6a7cdd67381efd33b88f',
      scoreAtAdmission: 100,
      killed: 20,
      survived: 0,
      config: 'stryker.conf.json',
    },
  },
  // ── Base profile: core authorities admitted in the base full run ─────────
  required(
    'src/adapters/implementation-base-authority.ts',
    'Pre-mutation implementation base freeze',
    ['src/adapters/implementation-base-authority.test.ts'],
    {
      source: [SOURCE.trustBoundaries],
      admission: {
        verifiedAt: '2026-09-17',
        commitSha: 'a4db80e33bde4b0994fed24eb5c9114dae67bdef',
        scoreAtAdmission: 100,
        killed: 8,
        survived: 0,
        config: 'stryker.conf.json',
      },
    },
  ),
  required(
    'src/adapters/implementation-entry-guard.ts',
    'Pure persistence-side implementation entry guard',
    ['src/adapters/implementation-base-authority.test.ts'],
    {
      source: [SOURCE.trustBoundaries],
      admission: {
        verifiedAt: '2026-09-17',
        commitSha: 'a4db80e33bde4b0994fed24eb5c9114dae67bdef',
        scoreAtAdmission: 100,
        killed: 10,
        survived: 0,
        config: 'stryker.conf.json',
      },
    },
  ),

  // ── Base profile: measured admission verdicts (base full run 2026-09-17) ──
  deferred(
    'src/adapters/git.ts',
    'Git subprocess boundary',
    'Full-run verdict 34.97% (57 killed / 106 survived); test gaps must close before admission. Tracked in the existing-authority hardening tranche (measured baseline above).',
    { source: [SOURCE.trustBoundaries] },
  ),
  deferred(
    'src/adapters/frozen-repository.ts',
    'Immutable frozen-repository acquisition boundary',
    'Full-run verdict 58.65% (78 killed / 55 survived); test gaps must close before admission. Tracked in the existing-authority hardening tranche (measured baseline above).',
    { source: [SOURCE.trustBoundaries] },
  ),
  deferred(
    'src/audit/canonical-digest.ts',
    'TSA message imprint digest authority',
    'Full-run verdict 75.00% (3 killed / 1 survived); the mutant set is too small to carry an admission. Tracked in the existing-authority hardening tranche (measured baseline above).',
  ),
  deferred(
    'src/config/flowguard-config.ts',
    'Runtime config schema authority',
    'Full-run verdict 20.00% (9 killed / 36 survived); default/parse branches lack assertions. Tracked in the existing-authority hardening tranche (measured baseline above).',
    { source: [SOURCE.config] },
  ),
  deferred(
    'src/state/schema.ts',
    'Session state schema validated on every write',
    'Full-run verdict 33.33% (9 killed / 18 survived); invariant branches lack negative-path tests. Tracked in the existing-authority hardening tranche (measured baseline above).',
    { source: [SOURCE.rootAgents] },
  ),
  deferred(
    'src/shared/hashing.ts',
    'Hash primitives for digests',
    'Full-run verdict 38.46% (5 killed / 8 survived); boundary inputs are untested. Tracked in the existing-authority hardening tranche (measured baseline above).',
    { source: [SOURCE.rootAgents] },
  ),
  deferred(
    'src/redaction/export-redaction.ts',
    'Export-time redaction boundary',
    'Full-run verdict 51.81% (43 killed / 40 survived); masking modes need contract tests. Tracked in the existing-authority hardening tranche (measured baseline above).',
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
    'src/integration/tools/run-check-result.ts',
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
    'src/config/profile-types.ts',
    'Profile type authority',
    'Type-only module (PhaseInstructions interface); the base full run produced no valid mutants.',
    'base',
    { source: [SOURCE.config] },
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
    'src/shared/policy-digest.ts',
    'Policy digest re-export',
    'Pure re-export of state-owned identifiers; no executable mutants in the base regime.',
    'base',
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

const TEST_FILE_PATTERN = /\.(test|spec)\.ts$/;

/** Production source predicate used by the completeness closure. */
export function isProductionSource(relativePath: string): boolean {
  if (!relativePath.endsWith('.ts')) return false;
  if (TEST_FILE_PATTERN.test(relativePath)) return false;
  if (relativePath.includes('/__fixtures__/')) return false;
  const basename = relativePath.split('/').pop() ?? '';
  if (basename === 'fixtures.ts') return false;
  if (basename === 'test-helpers.ts') return false;
  if (basename === 'evidence-test-constants.ts') return false;
  if (basename.endsWith('-test-helpers.ts')) return false;
  return true;
}

/** Normalizes a Stryker mutate selector to its target path. */
export function targetOfSelector(selector: string): string {
  const separator = selector.lastIndexOf(':');
  if (separator === -1) return selector;
  const suffix = selector.slice(separator + 1);
  return /^\d+-\d+$/.test(suffix) ? selector.slice(0, separator) : selector;
}
