/**
 * @module architecture/integration-placement-policy
 * @description Single positive placement authority for production files under
 * `src/integration/`.
 *
 * DEFAULT-DENY, EXACT PROJECTION: every production `.ts` file under
 * `src/integration/` has exactly one entry here — its architectural owner, its
 * current physical zone, and the physical zone it must occupy. A new production
 * file without an entry fails, an entry without a file fails, an unknown zone or
 * owner fails, a file whose current zone does not match its physical directory
 * fails, and an owner whose target zone disagrees with the entry fails.
 *
 * PLACEMENT CONTRACT: every file's current zone equals its target zone. Any
 * debt is a hard failure; the authority is the positive contract, not a
 * baseline snapshot.
 *
 * CLOSURE STATUS (#923): the integration tree carries zero placement debt.
 * Placement governs the internal zoning of the top-level `integration` module:
 * every entry is a production file below `src/integration/`, so this authority
 * never introduces an additional top-level module name and never changes the
 * endpoint set of `MODULE_DEPENDENCY_POLICY` by itself.
 *
 * @version v2
 */

export interface IntegrationPlacementZone {
  /** Physical zone id — the directory path under `src/integration/`, or `root`. */
  readonly id: string;
  /** Directory relative to `src/` that owns this zone. */
  readonly dir: string;
  readonly description: string;
  /**
   * Optional growth-decision budget: the maximum number of production files
   * this zone may hold. A change beyond the budget must update this authority
   * in the same diff — it is a visible decision, not a hidden baseline.
   */
  readonly maxProductionFiles?: number;
}

export interface IntegrationOwner {
  readonly id: string;
  /** Physical zone the owner's files must occupy. */
  readonly targetZone: string;
  readonly description: string;
}

export interface IntegrationPlacementEntry {
  /** File path relative to `src/`, e.g. `integration/tools/plan.ts`. */
  readonly file: string;
  readonly owner: string;
  /** Current physical zone (must equal the file's parent directory zone). */
  readonly zone: string;
  /** Required physical zone; must equal the current zone. */
  readonly targetZone: string;
}

/** Every physical zone known to this authority (current and target). */
export const INTEGRATION_PLACEMENT_ZONES: readonly IntegrationPlacementZone[] = [
  {
    id: 'root',
    dir: 'integration',
    description:
      'Integration root: plugin composition, host/runtime wiring, integration-level authorities',
  },
  { id: 'status', dir: 'integration/status', description: 'Status/finish/why feature projections' },
  {
    id: 'discovery',
    dir: 'integration/discovery',
    description: 'Discovery health, drift, and risk-path authorities',
  },
  {
    id: 'review',
    dir: 'integration/review',
    description: 'Review bounded context facade and cross-zone primitives',
  },
  {
    id: 'review/dispatch',
    dir: 'integration/review/dispatch',
    description: 'Reviewer/task resolution, dispatch, and orchestration',
  },
  {
    id: 'review/obligations',
    dir: 'integration/review/obligations',
    description: 'Review obligations, attempts, and challenge lifecycle',
  },
  {
    id: 'review/context',
    dir: 'integration/review/context',
    description: 'Reviewer, discovery, proof, and subject context',
  },
  {
    id: 'review/observations',
    dir: 'integration/review/observations',
    description: 'Observation capture, binding, replay, and resolution',
  },
  {
    id: 'review/evidence',
    dir: 'integration/review/evidence',
    description: 'Findings, hashes, provenance, coherence, and review evidence',
  },
  {
    id: 'review/validation',
    dir: 'integration/review/validation',
    description: 'Review validation and structured evidence verification',
  },
  {
    id: 'review/prompting',
    dir: 'integration/review/prompting',
    description: 'Prompt construction and host/reviewer instructions',
  },
  {
    id: 'review/enforcement',
    dir: 'integration/review/enforcement',
    description: 'Review enforcement subsystem',
  },
  {
    id: 'proofgraph',
    dir: 'integration/proofgraph',
    description: 'ProofGraph claim and materialization context',
  },
  {
    id: 'services',
    dir: 'integration/services',
    description: 'Integration-level completion services',
  },
  { id: 'help', dir: 'integration/help', description: 'Help projection and rendering context' },
  {
    id: 'artifacts',
    dir: 'integration/artifacts',
    description: 'Integration artifact projections',
  },
  { id: 'tools', dir: 'integration/tools', description: 'FlowGuard command surface (tool layer)' },
  {
    id: 'tools/review-tool',
    dir: 'integration/tools/review-tool',
    description: 'Review command transport',
  },
  { id: 'tools/plan', dir: 'integration/tools/plan', description: 'Plan command context' },
  {
    id: 'tools/architecture',
    dir: 'integration/tools/architecture',
    description: 'Architecture command context',
  },
  {
    id: 'tools/implementation',
    dir: 'integration/tools/implementation',
    description: 'Implementation command context',
  },
  {
    id: 'tools/validation',
    dir: 'integration/tools/validation',
    description: 'run_check command context',
  },
  { id: 'tools/status', dir: 'integration/tools/status', description: 'Status command context' },
  { id: 'tools/hydrate', dir: 'integration/tools/hydrate', description: 'Hydrate command context' },
  {
    id: 'tools/challenge',
    dir: 'integration/tools/challenge',
    description: 'Challenge lifecycle command context',
  },
  {
    id: 'tools/decision',
    dir: 'integration/tools/decision',
    description: 'Decision command context',
  },
  {
    id: 'tools/simple',
    dir: 'integration/tools/simple',
    description: 'Ticket/abort/archive/export/help/continue command context',
  },
  {
    id: 'tools/contract',
    dir: 'integration/tools/contract',
    description: 'declare_contract command context',
  },
  {
    id: 'tools/mutation',
    dir: 'integration/tools/mutation',
    description: 'Mutation evidence command context',
  },
  {
    id: 'tools/observe',
    dir: 'integration/tools/observe',
    description: 'observe_repository command context',
  },
];

/** Every architectural owner and the physical zone its files must occupy. */
export const INTEGRATION_OWNERS: readonly IntegrationOwner[] = [
  {
    id: 'root-composition',
    targetZone: 'root',
    description: 'Plugin lifecycle entrypoints and the package barrels',
  },
  {
    id: 'root-host-runtime',
    targetZone: 'root',
    description: 'Host adapter and runtime composition',
  },
  {
    id: 'root-authority',
    targetZone: 'root',
    description: 'Integration-level cross-context authorities',
  },
  { id: 'status', targetZone: 'status', description: 'Status bounded context' },
  { id: 'discovery', targetZone: 'discovery', description: 'Discovery bounded context' },
  { id: 'review', targetZone: 'review', description: 'Review bounded context facade' },
  {
    id: 'review-dispatch',
    targetZone: 'review/dispatch',
    description: 'Review dispatch and orchestration',
  },
  {
    id: 'review-obligations',
    targetZone: 'review/obligations',
    description: 'Review obligations and challenge lifecycle',
  },
  {
    id: 'review-context',
    targetZone: 'review/context',
    description: 'Review context and subject resolution',
  },
  {
    id: 'review-observations',
    targetZone: 'review/observations',
    description: 'Review observations',
  },
  {
    id: 'review-evidence',
    targetZone: 'review/evidence',
    description: 'Review evidence and findings',
  },
  {
    id: 'review-validation',
    targetZone: 'review/validation',
    description: 'Review validation',
  },
  {
    id: 'review-prompting',
    targetZone: 'review/prompting',
    description: 'Review prompting',
  },
  {
    id: 'review-enforcement',
    targetZone: 'review/enforcement',
    description: 'Review enforcement subsystem',
  },
  { id: 'proofgraph', targetZone: 'proofgraph', description: 'ProofGraph bounded context' },
  { id: 'services', targetZone: 'services', description: 'Integration services' },
  { id: 'help', targetZone: 'help', description: 'Help bounded context' },
  { id: 'artifacts', targetZone: 'artifacts', description: 'Artifact projections' },
  {
    id: 'tools-infrastructure',
    targetZone: 'tools',
    description: 'Cross-command tool infrastructure',
  },
  { id: 'tools-plan', targetZone: 'tools/plan', description: 'Plan command' },
  {
    id: 'tools-architecture',
    targetZone: 'tools/architecture',
    description: 'Architecture command',
  },
  {
    id: 'tools-implementation',
    targetZone: 'tools/implementation',
    description: 'Implementation commands',
  },
  { id: 'tools-validation', targetZone: 'tools/validation', description: 'run_check command' },
  { id: 'tools-status', targetZone: 'tools/status', description: 'Status command' },
  { id: 'tools-hydrate', targetZone: 'tools/hydrate', description: 'Hydrate command' },
  {
    id: 'tools-review-tool',
    targetZone: 'tools/review-tool',
    description: 'Review command transport',
  },
  { id: 'tools-challenge', targetZone: 'tools/challenge', description: 'Challenge commands' },
  { id: 'tools-decision', targetZone: 'tools/decision', description: 'Decision command' },
  { id: 'tools-simple', targetZone: 'tools/simple', description: 'Simple session commands' },
  { id: 'tools-contract', targetZone: 'tools/contract', description: 'declare_contract command' },
  { id: 'tools-mutation', targetZone: 'tools/mutation', description: 'Mutation evidence commands' },
  { id: 'tools-observe', targetZone: 'tools/observe', description: 'observe_repository command' },
];

/** Exact projection of the production files under `src/integration/`. */
export const INTEGRATION_PLACEMENT: readonly IntegrationPlacementEntry[] = [
  {
    file: 'integration/archive-preflight.ts',
    owner: 'root-authority',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/artifacts/madr-writer.ts',
    owner: 'artifacts',
    zone: 'artifacts',
    targetZone: 'artifacts',
  },
  {
    file: 'integration/audit-outbox.ts',
    owner: 'root-authority',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/blocked-result.ts',
    owner: 'root-authority',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/discovery/discovery-drift-status.ts',
    owner: 'discovery',
    zone: 'discovery',
    targetZone: 'discovery',
  },
  {
    file: 'integration/discovery/discovery-health-audit.ts',
    owner: 'discovery',
    zone: 'discovery',
    targetZone: 'discovery',
  },
  {
    file: 'integration/discovery/discovery-health-gate.ts',
    owner: 'discovery',
    zone: 'discovery',
    targetZone: 'discovery',
  },
  {
    file: 'integration/discovery/discovery-health-loader.ts',
    owner: 'discovery',
    zone: 'discovery',
    targetZone: 'discovery',
  },
  {
    file: 'integration/discovery/discovery-io.ts',
    owner: 'discovery',
    zone: 'discovery',
    targetZone: 'discovery',
  },
  {
    file: 'integration/discovery/discovery-risk-paths.ts',
    owner: 'discovery',
    zone: 'discovery',
    targetZone: 'discovery',
  },
  {
    file: 'integration/discovery/review-discovery-provider.ts',
    owner: 'discovery',
    zone: 'discovery',
    targetZone: 'discovery',
  },
  { file: 'integration/errors.ts', owner: 'root-authority', zone: 'root', targetZone: 'root' },
  {
    file: 'integration/git-control-plane.ts',
    owner: 'root-authority',
    zone: 'root',
    targetZone: 'root',
  },
  { file: 'integration/help/help-projection.ts', owner: 'help', zone: 'help', targetZone: 'help' },
  { file: 'integration/help/help-renderer.ts', owner: 'help', zone: 'help', targetZone: 'help' },
  {
    file: 'integration/implementation-guidance.ts',
    owner: 'root-authority',
    zone: 'root',
    targetZone: 'root',
  },
  { file: 'integration/index.ts', owner: 'root-composition', zone: 'root', targetZone: 'root' },
  {
    file: 'integration/installed-commands.ts',
    owner: 'root-host-runtime',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/opencode-host-adapter.ts',
    owner: 'root-host-runtime',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/phase-tool-gate.ts',
    owner: 'root-authority',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-afterhooks.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-audit-context.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-audit-decisions.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-audit-lifecycle-reason.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-audit-reconcile.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-audit.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-beforehooks.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-compaction.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-discovery-health.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-enforcement-tracking.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-events.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-git-gate.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-helpers.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-logging.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-mutation-episodes.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-orchestrator.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-policy.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-regulated-recovery.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-rework-continuation.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-risk.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-shared.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/plugin-workspace.ts',
    owner: 'root-composition',
    zone: 'root',
    targetZone: 'root',
  },
  { file: 'integration/plugin.ts', owner: 'root-composition', zone: 'root', targetZone: 'root' },
  {
    file: 'integration/proofgraph/approval-projection.ts',
    owner: 'proofgraph',
    zone: 'proofgraph',
    targetZone: 'proofgraph',
  },
  {
    file: 'integration/proofgraph/claim-contract-rules.ts',
    owner: 'proofgraph',
    zone: 'proofgraph',
    targetZone: 'proofgraph',
  },
  {
    file: 'integration/proofgraph/claim-contract.ts',
    owner: 'proofgraph',
    zone: 'proofgraph',
    targetZone: 'proofgraph',
  },
  {
    file: 'integration/proofgraph/claim-resolution-projector.ts',
    owner: 'proofgraph',
    zone: 'proofgraph',
    targetZone: 'proofgraph',
  },
  {
    file: 'integration/proofgraph/config-default-consistency.ts',
    owner: 'proofgraph',
    zone: 'proofgraph',
    targetZone: 'proofgraph',
  },
  {
    file: 'integration/proofgraph/materialize-architecture.ts',
    owner: 'proofgraph',
    zone: 'proofgraph',
    targetZone: 'proofgraph',
  },
  {
    file: 'integration/proofgraph/materialize-contract.ts',
    owner: 'proofgraph',
    zone: 'proofgraph',
    targetZone: 'proofgraph',
  },
  {
    file: 'integration/proofgraph/mutation-provider.ts',
    owner: 'proofgraph',
    zone: 'proofgraph',
    targetZone: 'proofgraph',
  },
  {
    file: 'integration/proofgraph/proof-summary-projectors.ts',
    owner: 'proofgraph',
    zone: 'proofgraph',
    targetZone: 'proofgraph',
  },
  {
    file: 'integration/proofgraph/refresh.ts',
    owner: 'proofgraph',
    zone: 'proofgraph',
    targetZone: 'proofgraph',
  },
  {
    file: 'integration/proofgraph/registration-consistency.ts',
    owner: 'proofgraph',
    zone: 'proofgraph',
    targetZone: 'proofgraph',
  },
  {
    file: 'integration/proofgraph/structural-provider.ts',
    owner: 'proofgraph',
    zone: 'proofgraph',
    targetZone: 'proofgraph',
  },
  {
    file: 'integration/proofgraph/surface-digest.ts',
    owner: 'proofgraph',
    zone: 'proofgraph',
    targetZone: 'proofgraph',
  },
  {
    file: 'integration/provider-capability-resolution.ts',
    owner: 'root-authority',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/review/dispatch/agent-resolution.ts',
    owner: 'review-dispatch',
    zone: 'review/dispatch',
    targetZone: 'review/dispatch',
  },
  {
    file: 'integration/review/anchor-contract-lines.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/obligations/assurance.ts',
    owner: 'review-obligations',
    zone: 'review/obligations',
    targetZone: 'review/obligations',
  },
  {
    file: 'integration/review/obligations/attempt-lifecycle.ts',
    owner: 'review-obligations',
    zone: 'review/obligations',
    targetZone: 'review/obligations',
  },
  {
    file: 'integration/review/audit-events.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/obligations/challenge-contract.ts',
    owner: 'review-obligations',
    zone: 'review/obligations',
    targetZone: 'review/obligations',
  },
  {
    file: 'integration/review/obligations/challenge-history.ts',
    owner: 'review-obligations',
    zone: 'review/obligations',
    targetZone: 'review/obligations',
  },
  {
    file: 'integration/review/child-session-instruction.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/context/discovery-attempt-context.ts',
    owner: 'review-context',
    zone: 'review/context',
    targetZone: 'review/context',
  },
  {
    file: 'integration/review/context/discovery-context-loader.ts',
    owner: 'review-context',
    zone: 'review/context',
    targetZone: 'review/context',
  },
  {
    file: 'integration/review/discovery-context-prompt.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/context/discovery-port.ts',
    owner: 'review-context',
    zone: 'review/context',
    targetZone: 'review/context',
  },
  {
    file: 'integration/review/dispatch/dispatch-authority.ts',
    owner: 'review-dispatch',
    zone: 'review/dispatch',
    targetZone: 'review/dispatch',
  },
  {
    file: 'integration/review/dispatch/dispatch-signal.ts',
    owner: 'review-dispatch',
    zone: 'review/dispatch',
    targetZone: 'review/dispatch',
  },
  {
    file: 'integration/review/dispatch/durable-dispatch.ts',
    owner: 'review-dispatch',
    zone: 'review/dispatch',
    targetZone: 'review/dispatch',
  },
  {
    file: 'integration/review/enforcement/challenge-binding.ts',
    owner: 'review-enforcement',
    zone: 'review/enforcement',
    targetZone: 'review/enforcement',
  },
  {
    file: 'integration/review/enforcement/challenge-consistency.ts',
    owner: 'review-enforcement',
    zone: 'review/enforcement',
    targetZone: 'review/enforcement',
  },
  {
    file: 'integration/review/enforcement/enforcement.ts',
    owner: 'review-enforcement',
    zone: 'review/enforcement',
    targetZone: 'review/enforcement',
  },
  {
    file: 'integration/review/enforcement/findings-consistency.ts',
    owner: 'review-enforcement',
    zone: 'review/enforcement',
    targetZone: 'review/enforcement',
  },
  {
    file: 'integration/review/enforcement/index.ts',
    owner: 'review-enforcement',
    zone: 'review/enforcement',
    targetZone: 'review/enforcement',
  },
  {
    file: 'integration/review/enforcement/normalize.ts',
    owner: 'review-enforcement',
    zone: 'review/enforcement',
    targetZone: 'review/enforcement',
  },
  {
    file: 'integration/review/enforcement/pending-review.ts',
    owner: 'review-enforcement',
    zone: 'review/enforcement',
    targetZone: 'review/enforcement',
  },
  {
    file: 'integration/review/enforcement/prepare-findings.ts',
    owner: 'review-enforcement',
    zone: 'review/enforcement',
    targetZone: 'review/enforcement',
  },
  {
    file: 'integration/review/enforcement/types.ts',
    owner: 'review-enforcement',
    zone: 'review/enforcement',
    targetZone: 'review/enforcement',
  },
  {
    file: 'integration/review/finding-relation-grammar.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/findings-hash.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/findings-schema.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/freeze-coherence.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/context/frozen-reviewer-context.ts',
    owner: 'review-context',
    zone: 'review/context',
    targetZone: 'review/context',
  },
  {
    file: 'integration/review/impl-review-prompt.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  { file: 'integration/review/index.ts', owner: 'review', zone: 'review', targetZone: 'review' },
  {
    file: 'integration/review/dispatch/native-task-review-bindings.ts',
    owner: 'review-dispatch',
    zone: 'review/dispatch',
    targetZone: 'review/dispatch',
  },
  {
    file: 'integration/review/dispatch/native-task-review-types.ts',
    owner: 'review-dispatch',
    zone: 'review/dispatch',
    targetZone: 'review/dispatch',
  },
  {
    file: 'integration/review/dispatch/native-task-review.ts',
    owner: 'review-dispatch',
    zone: 'review/dispatch',
    targetZone: 'review/dispatch',
  },
  {
    file: 'integration/review/obligations/obligation-settlement.ts',
    owner: 'review-obligations',
    zone: 'review/obligations',
    targetZone: 'review/obligations',
  },
  {
    file: 'integration/review/obligations/obligation-state.ts',
    owner: 'review-obligations',
    zone: 'review/obligations',
    targetZone: 'review/obligations',
  },
  {
    file: 'integration/review/obligations/obligation-tools.ts',
    owner: 'review-obligations',
    zone: 'review/obligations',
    targetZone: 'review/obligations',
  },
  {
    file: 'integration/review/observations/observation-access.ts',
    owner: 'review-observations',
    zone: 'review/observations',
    targetZone: 'review/observations',
  },
  {
    file: 'integration/review/observations/observation-binding.ts',
    owner: 'review-observations',
    zone: 'review/observations',
    targetZone: 'review/observations',
  },
  {
    file: 'integration/review/observation-contract-prompt.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/observations/observation-replay-persist.ts',
    owner: 'review-observations',
    zone: 'review/observations',
    targetZone: 'review/observations',
  },
  {
    file: 'integration/review/observations/observation-replay.ts',
    owner: 'review-observations',
    zone: 'review/observations',
    targetZone: 'review/observations',
  },
  {
    file: 'integration/review/observations/observation-resolution.ts',
    owner: 'review-observations',
    zone: 'review/observations',
    targetZone: 'review/observations',
  },
  {
    file: 'integration/review/observations/observation-service.ts',
    owner: 'review-observations',
    zone: 'review/observations',
    targetZone: 'review/observations',
  },
  {
    file: 'integration/review/dispatch/orchestration-mode.ts',
    owner: 'review-dispatch',
    zone: 'review/dispatch',
    targetZone: 'review/dispatch',
  },
  {
    file: 'integration/review/pipeline-types.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/observations/pre-bind-findings.ts',
    owner: 'review-observations',
    zone: 'review/observations',
    targetZone: 'review/observations',
  },
  {
    file: 'integration/review/prompt-builders.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/prompt-sections.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/context/proof-context.ts',
    owner: 'review-context',
    zone: 'review/context',
    targetZone: 'review/context',
  },
  {
    file: 'integration/review/obligations/reissue-authority.ts',
    owner: 'review-obligations',
    zone: 'review/obligations',
    targetZone: 'review/obligations',
  },
  {
    file: 'integration/review/rejected-digests.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/report-coherence.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/dispatch/review-execution-projection.ts',
    owner: 'review-dispatch',
    zone: 'review/dispatch',
    targetZone: 'review/dispatch',
  },
  {
    file: 'integration/review/review-logger-port.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/obligations/review-loop-progress.ts',
    owner: 'review-obligations',
    zone: 'review/obligations',
    targetZone: 'review/obligations',
  },
  {
    file: 'integration/review/obligations/review-obligation-classification.ts',
    owner: 'review-obligations',
    zone: 'review/obligations',
    targetZone: 'review/obligations',
  },
  {
    file: 'integration/review/review-provenance.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/review-validation-acceptance.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/review-validation-evidence.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/review-validation-structured-evidence.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/review-validation.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/reviewed-digest.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/context/reviewer-context.ts',
    owner: 'review-context',
    zone: 'review/context',
    targetZone: 'review/context',
  },
  {
    file: 'integration/review/context/reviewer-contract.ts',
    owner: 'review-context',
    zone: 'review/context',
    targetZone: 'review/context',
  },
  {
    file: 'integration/review/reviewer-evidence-recorder.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/dispatch/reviewer-task-type.ts',
    owner: 'review-dispatch',
    zone: 'review/dispatch',
    targetZone: 'review/dispatch',
  },
  {
    file: 'integration/review/shared-helpers.ts',
    owner: 'review',
    zone: 'review',
    targetZone: 'review',
  },
  {
    file: 'integration/review/obligations/structured-followup.ts',
    owner: 'review-obligations',
    zone: 'review/obligations',
    targetZone: 'review/obligations',
  },
  {
    file: 'integration/review/context/subject-scope.ts',
    owner: 'review-context',
    zone: 'review/context',
    targetZone: 'review/context',
  },
  { file: 'integration/review/types.ts', owner: 'review', zone: 'review', targetZone: 'review' },
  {
    file: 'integration/runtime-instance.ts',
    owner: 'root-host-runtime',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/runtime-lease.ts',
    owner: 'root-host-runtime',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/services/decision-finalization.ts',
    owner: 'services',
    zone: 'services',
    targetZone: 'services',
  },
  {
    file: 'integration/services/regulated-completion.ts',
    owner: 'services',
    zone: 'services',
    targetZone: 'services',
  },
  {
    file: 'integration/status/finish-presentation.ts',
    owner: 'status',
    zone: 'status',
    targetZone: 'status',
  },
  {
    file: 'integration/status/status-conclusion.ts',
    owner: 'status',
    zone: 'status',
    targetZone: 'status',
  },
  {
    file: 'integration/status/status-detail-projections.ts',
    owner: 'status',
    zone: 'status',
    targetZone: 'status',
  },
  {
    file: 'integration/status/status-finish.ts',
    owner: 'status',
    zone: 'status',
    targetZone: 'status',
  },
  {
    file: 'integration/status/status-presentation.ts',
    owner: 'status',
    zone: 'status',
    targetZone: 'status',
  },
  {
    file: 'integration/status/status-types.ts',
    owner: 'status',
    zone: 'status',
    targetZone: 'status',
  },
  {
    file: 'integration/status/status-why-finish.ts',
    owner: 'status',
    zone: 'status',
    targetZone: 'status',
  },
  { file: 'integration/status/status.ts', owner: 'status', zone: 'status', targetZone: 'status' },
  {
    file: 'integration/status/why-presentation.ts',
    owner: 'status',
    zone: 'status',
    targetZone: 'status',
  },
  {
    file: 'integration/tool-classification.ts',
    owner: 'root-authority',
    zone: 'root',
    targetZone: 'root',
  },
  { file: 'integration/tool-names.ts', owner: 'root-authority', zone: 'root', targetZone: 'root' },
  {
    file: 'integration/tools/architecture/architecture-restart.ts',
    owner: 'tools-architecture',
    zone: 'tools/architecture',
    targetZone: 'tools/architecture',
  },
  {
    file: 'integration/tools/architecture/architecture-review-response.ts',
    owner: 'tools-architecture',
    zone: 'tools/architecture',
    targetZone: 'tools/architecture',
  },
  {
    file: 'integration/tools/architecture/architecture-review.ts',
    owner: 'tools-architecture',
    zone: 'tools/architecture',
    targetZone: 'tools/architecture',
  },
  {
    file: 'integration/tools/architecture/architecture-shared.ts',
    owner: 'tools-architecture',
    zone: 'tools/architecture',
    targetZone: 'tools/architecture',
  },
  {
    file: 'integration/tools/architecture/architecture-submit.ts',
    owner: 'tools-architecture',
    zone: 'tools/architecture',
    targetZone: 'tools/architecture',
  },
  {
    file: 'integration/tools/architecture/architecture.ts',
    owner: 'tools-architecture',
    zone: 'tools/architecture',
    targetZone: 'tools/architecture',
  },
  {
    file: 'integration/tools/auto-validation.ts',
    owner: 'tools-infrastructure',
    zone: 'tools',
    targetZone: 'tools',
  },
  {
    file: 'integration/tools/challenge/challenge-resolution.ts',
    owner: 'tools-challenge',
    zone: 'tools/challenge',
    targetZone: 'tools/challenge',
  },
  {
    file: 'integration/tools/challenge/pre-implementation-challenge.ts',
    owner: 'tools-challenge',
    zone: 'tools/challenge',
    targetZone: 'tools/challenge',
  },
  {
    file: 'integration/tools/contract/declare-contract.ts',
    owner: 'tools-contract',
    zone: 'tools/contract',
    targetZone: 'tools/contract',
  },
  {
    file: 'integration/tools/decision/decision-tool.ts',
    owner: 'tools-decision',
    zone: 'tools/decision',
    targetZone: 'tools/decision',
  },
  {
    file: 'integration/tools/error-format.ts',
    owner: 'tools-infrastructure',
    zone: 'tools',
    targetZone: 'tools',
  },
  {
    file: 'integration/tools/execution-subject-input-resolution.ts',
    owner: 'tools-infrastructure',
    zone: 'tools',
    targetZone: 'tools',
  },
  {
    file: 'integration/tools/helpers-rail-presentation.ts',
    owner: 'tools-infrastructure',
    zone: 'tools',
    targetZone: 'tools',
  },
  {
    file: 'integration/tools/helpers.ts',
    owner: 'tools-infrastructure',
    zone: 'tools',
    targetZone: 'tools',
  },
  {
    file: 'integration/tools/hydrate/hydrate-discovery-health.ts',
    owner: 'tools-hydrate',
    zone: 'tools/hydrate',
    targetZone: 'tools/hydrate',
  },
  {
    file: 'integration/tools/hydrate/hydrate-discovery.ts',
    owner: 'tools-hydrate',
    zone: 'tools/hydrate',
    targetZone: 'tools/hydrate',
  },
  {
    file: 'integration/tools/hydrate/hydrate-errors.ts',
    owner: 'tools-hydrate',
    zone: 'tools/hydrate',
    targetZone: 'tools/hydrate',
  },
  {
    file: 'integration/tools/hydrate/hydrate-format.ts',
    owner: 'tools-hydrate',
    zone: 'tools/hydrate',
    targetZone: 'tools/hydrate',
  },
  {
    file: 'integration/tools/hydrate/hydrate-policy.ts',
    owner: 'tools-hydrate',
    zone: 'tools/hydrate',
    targetZone: 'tools/hydrate',
  },
  {
    file: 'integration/tools/hydrate/hydrate-types.ts',
    owner: 'tools-hydrate',
    zone: 'tools/hydrate',
    targetZone: 'tools/hydrate',
  },
  {
    file: 'integration/tools/hydrate/hydrate.ts',
    owner: 'tools-hydrate',
    zone: 'tools/hydrate',
    targetZone: 'tools/hydrate',
  },
  {
    file: 'integration/tools/implementation/implement-diff-artifact.ts',
    owner: 'tools-implementation',
    zone: 'tools/implementation',
    targetZone: 'tools/implementation',
  },
  {
    file: 'integration/tools/implementation/implement-record.ts',
    owner: 'tools-implementation',
    zone: 'tools/implementation',
    targetZone: 'tools/implementation',
  },
  {
    file: 'integration/tools/implementation/implement-review-presentation.ts',
    owner: 'tools-implementation',
    zone: 'tools/implementation',
    targetZone: 'tools/implementation',
  },
  {
    file: 'integration/tools/implementation/implement-review-proof.ts',
    owner: 'tools-implementation',
    zone: 'tools/implementation',
    targetZone: 'tools/implementation',
  },
  {
    file: 'integration/tools/implementation/implement-review-recovery.ts',
    owner: 'tools-implementation',
    zone: 'tools/implementation',
    targetZone: 'tools/implementation',
  },
  {
    file: 'integration/tools/implementation/implement-review-state.ts',
    owner: 'tools-implementation',
    zone: 'tools/implementation',
    targetZone: 'tools/implementation',
  },
  {
    file: 'integration/tools/implementation/implement-review.ts',
    owner: 'tools-implementation',
    zone: 'tools/implementation',
    targetZone: 'tools/implementation',
  },
  {
    file: 'integration/tools/implementation/implement-shared.ts',
    owner: 'tools-implementation',
    zone: 'tools/implementation',
    targetZone: 'tools/implementation',
  },
  {
    file: 'integration/tools/implementation/implement-unable-review.ts',
    owner: 'tools-implementation',
    zone: 'tools/implementation',
    targetZone: 'tools/implementation',
  },
  {
    file: 'integration/tools/implementation/implement.ts',
    owner: 'tools-implementation',
    zone: 'tools/implementation',
    targetZone: 'tools/implementation',
  },
  {
    file: 'integration/tools/implementation/review-summary.ts',
    owner: 'tools-implementation',
    zone: 'tools/implementation',
    targetZone: 'tools/implementation',
  },
  {
    file: 'integration/tools/index.ts',
    owner: 'tools-infrastructure',
    zone: 'tools',
    targetZone: 'tools',
  },
  {
    file: 'integration/tools/mutation/reconcile-mutation-episode.ts',
    owner: 'tools-mutation',
    zone: 'tools/mutation',
    targetZone: 'tools/mutation',
  },
  {
    file: 'integration/tools/mutation/record-mutation-evidence.ts',
    owner: 'tools-mutation',
    zone: 'tools/mutation',
    targetZone: 'tools/mutation',
  },
  {
    file: 'integration/tools/observe/observe-repository.ts',
    owner: 'tools-observe',
    zone: 'tools/observe',
    targetZone: 'tools/observe',
  },
  {
    file: 'integration/tools/plan/plan-claim-submission.ts',
    owner: 'tools-plan',
    zone: 'tools/plan',
    targetZone: 'tools/plan',
  },
  {
    file: 'integration/tools/plan/plan-response.ts',
    owner: 'tools-plan',
    zone: 'tools/plan',
    targetZone: 'tools/plan',
  },
  {
    file: 'integration/tools/plan/plan-review-state.ts',
    owner: 'tools-plan',
    zone: 'tools/plan',
    targetZone: 'tools/plan',
  },
  {
    file: 'integration/tools/plan/plan-route.ts',
    owner: 'tools-plan',
    zone: 'tools/plan',
    targetZone: 'tools/plan',
  },
  {
    file: 'integration/tools/plan/plan-submission-state.ts',
    owner: 'tools-plan',
    zone: 'tools/plan',
    targetZone: 'tools/plan',
  },
  {
    file: 'integration/tools/plan/plan-types.ts',
    owner: 'tools-plan',
    zone: 'tools/plan',
    targetZone: 'tools/plan',
  },
  {
    file: 'integration/tools/plan/plan.ts',
    owner: 'tools-plan',
    zone: 'tools/plan',
    targetZone: 'tools/plan',
  },
  {
    file: 'integration/tools/presentation-telemetry.ts',
    owner: 'tools-infrastructure',
    zone: 'tools',
    targetZone: 'tools',
  },
  {
    file: 'integration/tools/rail-conclusion.ts',
    owner: 'tools-infrastructure',
    zone: 'tools',
    targetZone: 'tools',
  },
  {
    file: 'integration/tools/review-tool/completion.ts',
    owner: 'tools-review-tool',
    zone: 'tools/review-tool',
    targetZone: 'tools/review-tool',
  },
  {
    file: 'integration/tools/review-tool/continuation-authority.ts',
    owner: 'tools-review-tool',
    zone: 'tools/review-tool',
    targetZone: 'tools/review-tool',
  },
  {
    file: 'integration/tools/review-tool/continuation.ts',
    owner: 'tools-review-tool',
    zone: 'tools/review-tool',
    targetZone: 'tools/review-tool',
  },
  {
    file: 'integration/tools/review-tool/fingerprint.ts',
    owner: 'tools-review-tool',
    zone: 'tools/review-tool',
    targetZone: 'tools/review-tool',
  },
  {
    file: 'integration/tools/review-tool/index.ts',
    owner: 'tools-review-tool',
    zone: 'tools/review-tool',
    targetZone: 'tools/review-tool',
  },
  {
    file: 'integration/tools/review-tool/obligation-creation.ts',
    owner: 'tools-review-tool',
    zone: 'tools/review-tool',
    targetZone: 'tools/review-tool',
  },
  {
    file: 'integration/tools/review-tool/obligation-format.ts',
    owner: 'tools-review-tool',
    zone: 'tools/review-tool',
    targetZone: 'tools/review-tool',
  },
  {
    file: 'integration/tools/review-tool/obligation.ts',
    owner: 'tools-review-tool',
    zone: 'tools/review-tool',
    targetZone: 'tools/review-tool',
  },
  {
    file: 'integration/tools/review-tool/preparation.ts',
    owner: 'tools-review-tool',
    zone: 'tools/review-tool',
    targetZone: 'tools/review-tool',
  },
  {
    file: 'integration/tools/review-tool/review-input.ts',
    owner: 'tools-review-tool',
    zone: 'tools/review-tool',
    targetZone: 'tools/review-tool',
  },
  {
    file: 'integration/tools/review-tool/types.ts',
    owner: 'tools-review-tool',
    zone: 'tools/review-tool',
    targetZone: 'tools/review-tool',
  },
  {
    file: 'integration/tools/review-validation-mode.ts',
    owner: 'tools-infrastructure',
    zone: 'tools',
    targetZone: 'tools',
  },
  {
    file: 'integration/tools/simple/abort-tool.ts',
    owner: 'tools-simple',
    zone: 'tools/simple',
    targetZone: 'tools/simple',
  },
  {
    file: 'integration/tools/simple/archive-tool.ts',
    owner: 'tools-simple',
    zone: 'tools/simple',
    targetZone: 'tools/simple',
  },
  {
    file: 'integration/tools/simple/continue-tool.ts',
    owner: 'tools-simple',
    zone: 'tools/simple',
    targetZone: 'tools/simple',
  },
  {
    file: 'integration/tools/simple/export-tool.ts',
    owner: 'tools-simple',
    zone: 'tools/simple',
    targetZone: 'tools/simple',
  },
  {
    file: 'integration/tools/simple/help-tool.ts',
    owner: 'tools-simple',
    zone: 'tools/simple',
    targetZone: 'tools/simple',
  },
  {
    file: 'integration/tools/simple/ticket-tool.ts',
    owner: 'tools-simple',
    zone: 'tools/simple',
    targetZone: 'tools/simple',
  },
  {
    file: 'integration/tools/status/status-full-response.ts',
    owner: 'tools-status',
    zone: 'tools/status',
    targetZone: 'tools/status',
  },
  {
    file: 'integration/tools/status/status-provider-projection.ts',
    owner: 'tools-status',
    zone: 'tools/status',
    targetZone: 'tools/status',
  },
  {
    file: 'integration/tools/status/status-summary.ts',
    owner: 'tools-status',
    zone: 'tools/status',
    targetZone: 'tools/status',
  },
  {
    file: 'integration/tools/status/status-tool.ts',
    owner: 'tools-status',
    zone: 'tools/status',
    targetZone: 'tools/status',
  },
  {
    file: 'integration/tools/validation/run-check-presentation.ts',
    owner: 'tools-validation',
    zone: 'tools/validation',
    targetZone: 'tools/validation',
  },
  {
    file: 'integration/tools/validation/run-check-request.ts',
    owner: 'tools-validation',
    zone: 'tools/validation',
    targetZone: 'tools/validation',
  },
  {
    file: 'integration/tools/validation/run-check-result.ts',
    owner: 'tools-validation',
    zone: 'tools/validation',
    targetZone: 'tools/validation',
  },
  {
    file: 'integration/tools/validation/run-check-tool.ts',
    owner: 'tools-validation',
    zone: 'tools/validation',
    targetZone: 'tools/validation',
  },
  { file: 'integration/types.ts', owner: 'root-authority', zone: 'root', targetZone: 'root' },
  {
    file: 'integration/user-decision-intent.ts',
    owner: 'root-authority',
    zone: 'root',
    targetZone: 'root',
  },
  {
    file: 'integration/verification-runtime-resolution.ts',
    owner: 'root-authority',
    zone: 'root',
    targetZone: 'root',
  },
];

/** Placement owner of a file, or null when the file has no placement entry. */
const PLACEMENT_BY_FILE = new Map(INTEGRATION_PLACEMENT.map((entry) => [entry.file, entry]));

export function placementOwnerOf(file: string): string | null {
  return PLACEMENT_BY_FILE.get(file)?.owner ?? null;
}

/** True when the file is plugin composition (index.ts, plugin.ts, plugin-*). */
export function isRootCompositionFile(file: string): boolean {
  return placementOwnerOf(file) === 'root-composition';
}

/** True when the file is host/runtime wiring that contexts must not import. */
export function isRootHostRuntimeFile(file: string): boolean {
  return placementOwnerOf(file) === 'root-host-runtime';
}

/** True when the file is a tool command context (tools/<context>/**). */
export function isToolCommandContextFile(file: string): boolean {
  const entry = PLACEMENT_BY_FILE.get(file);
  return entry !== undefined && entry.targetZone.startsWith('tools/');
}

export interface IntegrationPlacementViolation {
  readonly rule: string;
  readonly file: string;
  readonly message: string;
}

export interface IntegrationPlacementAnalysisInput {
  readonly productionFiles: readonly string[];
  readonly placement: readonly IntegrationPlacementEntry[];
  readonly zones: readonly IntegrationPlacementZone[];
  readonly owners: readonly IntegrationOwner[];
  readonly isTestFile: (rel: string) => boolean;
}

export function analyzeIntegrationPlacement(
  input: IntegrationPlacementAnalysisInput,
): IntegrationPlacementViolation[] {
  const violations: IntegrationPlacementViolation[] = [];
  const production = new Set(input.productionFiles);

  const zoneById = new Map<string, IntegrationPlacementZone>();
  for (const zone of input.zones) {
    if (zoneById.has(zone.id)) {
      violations.push({ rule: 'duplicate-zone-id', file: zone.id, message: 'duplicate zone id' });
    }
    zoneById.set(zone.id, zone);
  }

  const ownerById = new Map<string, IntegrationOwner>();
  for (const owner of input.owners) {
    if (ownerById.has(owner.id)) {
      violations.push({
        rule: 'duplicate-owner-id',
        file: owner.id,
        message: 'duplicate owner id',
      });
    }
    ownerById.set(owner.id, owner);
  }

  const placementByFile = new Map<string, IntegrationPlacementEntry>();
  for (const entry of input.placement) {
    if (placementByFile.has(entry.file)) {
      violations.push({
        rule: 'duplicate-placement-entry',
        file: entry.file,
        message: 'duplicate placement entry',
      });
    }
    placementByFile.set(entry.file, entry);
  }

  for (const file of input.productionFiles) {
    if (!placementByFile.has(file)) {
      violations.push({
        rule: 'unclassified-production-file',
        file,
        message: 'production file has no placement entry',
      });
    }
  }

  for (const entry of input.placement) {
    if (!production.has(entry.file)) {
      violations.push({
        rule: 'stale-placement-entry',
        file: entry.file,
        message: 'placement entry has no production file',
      });
    }
    if (input.isTestFile(entry.file)) {
      violations.push({
        rule: 'test-file-in-placement',
        file: entry.file,
        message: 'test support must not carry a placement entry',
      });
      continue;
    }
    const zone = zoneById.get(entry.zone);
    if (!zone) {
      violations.push({
        rule: 'unknown-zone',
        file: entry.file,
        message: 'unknown current zone ' + entry.zone,
      });
    } else {
      const parent = entry.file.split('/').slice(0, -1).join('/');
      if (parent !== zone.dir) {
        violations.push({
          rule: 'zone-directory-mismatch',
          file: entry.file,
          message: 'zone ' + entry.zone + ' expects directory ' + zone.dir,
        });
      }
    }
    if (!zoneById.has(entry.targetZone)) {
      violations.push({
        rule: 'unknown-zone',
        file: entry.file,
        message: 'unknown target zone ' + entry.targetZone,
      });
    }
    const owner = ownerById.get(entry.owner);
    if (!owner) {
      violations.push({
        rule: 'unknown-owner',
        file: entry.file,
        message: 'unknown owner ' + entry.owner,
      });
    } else if (owner.targetZone !== entry.targetZone) {
      violations.push({
        rule: 'owner-target-mismatch',
        file: entry.file,
        message: 'owner ' + entry.owner + ' requires target zone ' + owner.targetZone,
      });
    }
    if (entry.zone !== entry.targetZone) {
      violations.push({
        rule: 'placement-debt',
        file: entry.file,
        message: 'file is outside its target zone ' + entry.targetZone,
      });
    }
  }

  const zoneFileCount = new Map<string, number>();
  for (const entry of input.placement) {
    if (input.isTestFile(entry.file)) continue;
    zoneFileCount.set(entry.targetZone, (zoneFileCount.get(entry.targetZone) ?? 0) + 1);
  }
  for (const zone of input.zones) {
    if (zone.maxProductionFiles === undefined) continue;
    const count = zoneFileCount.get(zone.id) ?? 0;
    if (count > zone.maxProductionFiles) {
      violations.push({
        rule: 'zone-production-budget-exceeded',
        file: zone.id,
        message: `${count} production files exceed the zone budget of ${zone.maxProductionFiles}`,
      });
    }
  }

  return violations;
}
