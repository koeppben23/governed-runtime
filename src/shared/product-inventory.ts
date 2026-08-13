/**
 * @module shared/product-inventory
 * @description Canonical documented inventory projection — a single snapshot of
 *              all documented counts, sizes, and inventory numbers, verified
 *              against live runtime authorities by the drift test in
 *              `src/documentation/__tests__/product-inventory.test.ts`.
 *
 * This file is NOT a second authority. The live code registries (enums,
 * arrays, sets, maps) are the runtime authorities. This file documents
 * their current sizes. When you add or remove a tool, phase, profile, or
 * collector, update the corresponding count here — the drift test will
 * fail until both agree.
 *
 * @version v2
 */

/**
 * FlowGuard product inventory.
 *
 * Terminology (enforced by convention — no two keys use the same word):
 *
 * - **Machine Commands** — values in the `Command` enum (`src/machine/commands.ts`)
 * - **Integration Tools** — registered `ToolDefinition` exports from
 *   `src/integration/tools/index.ts`
 * - **MCP Tools** — entries in the `FLOWGUARD_TOOLS` registry
 *   (`src/mcp-server/server.ts`). Currently 14 of 15 Integration Tools; see
 *   docs for the one excluded tool.
 * - **Installed Command Definitions** — entries in `INSTALLED_COMMANDS`
 *   (`src/integration/installed-commands.ts`), including aliases, variants,
 *   product commands, and operational helpers.
 * - **Phases** — values in the `Phase` Zod enum (`src/state/schema.ts`)
 * - **Policy Modes** — values in `POLICY_MODES` (`src/state/policy-mode.ts`)
 * - **Profiles** — registered entries in `defaultProfileRegistry`
 *   (`src/config/profile.ts`)
 * - **Discovery Collectors** — top-level collector functions wired in the
 *   orchestrator (`src/discovery/orchestrator.ts`)
 * - **Review Loops** — phases with independent subagent review
 *   (`src/integration/review/review-loop-progress.ts`)
 * - **Enforcement Layers** — distinct review enforcement checks L1-L4
 *   (`src/integration/review/enforcement/enforcement.ts`)
 * - **Audit Event Kinds** — members of `AuditEventKind` union
 *   (`src/audit/types.ts`)
 * - **Archive Finding Codes** — members of `ArchiveFindingCodeSchema`
 *   (`src/archive/types.ts`)
 * - **Archive Verify JSDoc Checks** — numbered checks in the `verifyArchive()`
 *   JSDoc (`src/adapters/workspace/archive-verify-chain.ts`)
 * - **CLI Bins** — keys in `package.json` `bin`
 * - **Mutation Files** — entries in `stryker.conf.json` `mutate` array
 */
export const PRODUCT_INVENTORY = {
  machineCommands: 11,
  integrationTools: 18,
  mcpTools: 17,
  installedCommandDefs: 25,
  phases: 15,
  policyModes: 4,
  profiles: 4,
  discoveryCollectors: 6,
  reviewLoops: 3,
  enforcementLayers: 4,
  auditEventKinds: 5,
  archiveFindingCodes: 20,
  archiveVerifyJsdocChecks: 9,
  cliBins: 7,
  mutationFiles: 57,
} as const;

export type ProductInventory = typeof PRODUCT_INVENTORY;
